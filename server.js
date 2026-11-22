'use strict';
const path = require('path');
const express = require('express');
const { db, getSetting, setSetting, waitForDb, close: closeDb } = require('./server/db');
const { migrate } = require('./server/migrate');
const S = require('./server/security');
const { seedProductsFromHtml } = require('./server/seed');

const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const HOST = process.env.HOST || (IS_PROD ? '0.0.0.0' : '127.0.0.1');
const PUBLIC_DIR = path.join(__dirname, 'public');

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
else if (IS_PROD) console.warn('! NODE_ENV=production but TRUST_PROXY is not 1. If this site runs behind Render/nginx/Cloudflare, every visitor looks like the same IP, which breaks the per-IP rate limits and lockouts. Set TRUST_PROXY=1 behind a proxy.');

// Health check for hosting platforms (before the HTTPS redirect so probes always work)
app.get('/healthz', (req, res) => res.type('text').send('ok'));
// Readiness: also proves the database answers (used by the Docker HEALTHCHECK)
app.get('/readyz', async (req, res) => {
  try { await db.one('SELECT 1'); res.type('text').send('ok'); }
  catch (e) { res.status(503).type('text').send('database unavailable'); }
});
// Hosting platforms terminate HTTPS and tell us the original protocol: send plain-HTTP visitors to HTTPS
if (IS_PROD) {
  app.use((req, res, next) => {
    // Only redirect to a well-formed host name (a forged Host header must not turn this into an open redirect)
    if (req.headers['x-forwarded-proto'] === 'http' && /^[A-Za-z0-9.\-]+(:\d+)?$/.test(req.headers.host || '')) {
      return res.redirect(301, 'https://' + req.headers.host + req.originalUrl);
    }
    next();
  });
}
app.use(S.securityHeaders);
app.use(express.json({ limit: '20kb' }));
app.use(S.loadUser);

// ---- API ----
app.use('/api', S.noStore, S.csrfGuard, S.rateLimit({ windowMs: 60 * 1000, max: 300 }));
app.use('/api/auth', require('./server/routes/auth'));
app.use('/api/admin', require('./server/routes/admin'));
app.use('/api', require('./server/routes/shop'));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// ---- Pages ----
// The admin page itself is only served to a logged-in administrator.
app.get('/admin.html', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.redirect('/login.html');
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});
app.get('/', (req, res) => res.redirect('/home.html'));
// The admin script and stylesheet are only handed to a logged-in administrator
app.get(['/admin.js', '/admin.css'], (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') return res.status(404).type('text').send('Not found');
  res.set('Cache-Control', 'no-store');
  next();
});
// Only normal website file types are ever served from public/ (no PDFs, archives, backups, source maps...)
const PUBLIC_EXT = /\.(html|css|js|jpe?g|png|gif|webp|svg|ico|txt|xml)$/i;
app.use((req, res, next) => {
  if (/\.[A-Za-z0-9]+$/.test(req.path) && !PUBLIC_EXT.test(req.path)) return res.status(404).type('text').send('Not found');
  next();
});
app.use(express.static(PUBLIC_DIR, { dotfiles: 'ignore', index: false }));

// ---- Errors ----
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof S.HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') return res.status(400).json({ error: 'Invalid request.' });
  console.error(err); // details stay in the server log, never sent to the browser
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

(async () => {
  // 1. Wait for PostgreSQL (retries with back-off), 2. create/upgrade the tables, 3. first-run data, 4. listen
  await waitForDb();
  if (process.env.AUTO_MIGRATE !== '0') await migrate();   // AUTO_MIGRATE=0: run `npm run migrate` yourself instead

  // First run: store the admin passkey (hashed) from .env, and load products from product.html
  const wanted = process.env.ADMIN_PASSKEY;
  if (!await getSetting('admin_passkey_hash')) {
    if (!wanted) console.warn('! ADMIN_PASSKEY is not set: administrator sign-up is disabled until you set it in .env');
    else if (S.passkeyProblems(wanted).length) console.warn('! ADMIN_PASSKEY is too weak (needs 12+ chars, upper, lower, number, symbol). Admin sign-up stays disabled.');
    else { await setSetting('admin_passkey_hash', await S.hashSecret(wanted)); console.log('Admin passkey saved (hashed).'); }
  }
  // Optional: create the first administrator from environment variables (useful on hosts with temporary storage)
  const { SEED_ADMIN_USERNAME: su, SEED_ADMIN_EMAIL: se, SEED_ADMIN_PASSWORD: sp } = process.env;
  if (su && se && sp) {
    if (!S.isValidUsername(su) || !S.isValidEmail(se.toLowerCase()) || S.passwordProblems(sp).length) {
      console.warn('! SEED_ADMIN_* values are invalid (username 3-20 letters/numbers/_, valid email, strong password). Skipped.');
    } else if (!await db.one('SELECT 1 FROM users WHERE username = $1 OR email = $2', [su, se.toLowerCase()])) {
      await db.run("INSERT INTO users(username, email, role, pw_hash, email_verified) VALUES($1,$2,'admin',$3,1) ON CONFLICT DO NOTHING",
        [su, se.toLowerCase(), await S.hashSecret(sp)]);
      console.log(`Administrator account "${su}" created from environment variables.`);
    }
  }
  const seeded = await seedProductsFromHtml(path.join(PUBLIC_DIR, 'product.html'));
  if (seeded) console.log(`Loaded ${seeded} products from product.html`);

  require('./server/backup').schedule();
  const server = app.listen(PORT, HOST, () => console.log(`MOSSTECH running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`));

  // `docker stop` sends SIGTERM: finish in-flight requests, close the database pool, then exit
  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received, shutting down...`);
    setTimeout(() => process.exit(1), 10000).unref();   // hard stop if something hangs
    server.close(async () => { try { await closeDb(); } catch (_) { /* ignore */ } process.exit(0); });
    if (server.closeIdleConnections) server.closeIdleConnections();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
})().catch((e) => { console.error('Startup failed:', e.message); process.exit(1); });

process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));
