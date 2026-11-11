'use strict';
const crypto = require('crypto');
const { promisify } = require('util');
const { db } = require('./db');

const scrypt = promisify(crypto.scrypt);
const IS_PROD = process.env.NODE_ENV === 'production';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ------------------------------------------------------------------
// Hashing (scrypt, salted). Used for passwords AND the admin passkey.
// ------------------------------------------------------------------
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
function safeEqual(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}
async function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(secret), salt, 64, SCRYPT);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
let dummyHash = null;
// When "stored" is missing (unknown user) we still do the same amount of work,
// so response time never reveals whether an account exists.
async function verifySecret(secret, stored) {
  const real = typeof stored === 'string' && stored.startsWith('scrypt$');
  if (!real) { dummyHash = dummyHash || await hashSecret('dummy-password-for-timing'); stored = dummyHash; }
  const [, saltHex, keyHex] = stored.split('$');
  const key = await scrypt(String(secret), Buffer.from(saltHex, 'hex'), 64, SCRYPT);
  const ok = crypto.timingSafeEqual(key, Buffer.from(keyHex, 'hex'));
  return real && ok;
}

// ------------------------------------------------------------------
// Validation
// ------------------------------------------------------------------
const isValidEmail = (s) => typeof s === 'string' && s.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
const isValidUsername = (s) => typeof s === 'string' && /^[A-Za-z0-9_]{3,20}$/.test(s);
const isValidName = (s) => /^[\p{L}][\p{L}\s.'\-]{1,79}$/u.test(s);
function isValidPhone(s) {
  if (!/^[\d+\-()\s]+$/.test(s)) return false;
  const digits = s.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15;
}
function passwordProblems(pw) {
  const issues = [];
  if (typeof pw !== 'string') return ['a password'];
  if (pw.length < 8) issues.push('at least 8 characters');
  if (pw.length > 200) issues.push('no more than 200 characters');
  if (!/[a-z]/.test(pw)) issues.push('a lowercase letter');
  if (!/[A-Z]/.test(pw)) issues.push('an uppercase letter');
  if (!/\d/.test(pw)) issues.push('a number');
  if (!/[^A-Za-z0-9]/.test(pw)) issues.push('a symbol');
  return issues;
}
// The admin passkey unlocks admin sign-up and admin password resets, so it must be stronger than a normal password.
function passkeyProblems(pk) {
  const issues = passwordProblems(pk);
  if (typeof pk === 'string' && pk.length < 12) issues.push('at least 12 characters');
  return issues;
}
function cleanText(s, max) {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
// Relative path (pics/x.jpg) or https URL. Blocks javascript:, data:, "..", etc. Returns null if unsafe.
function cleanImageUrl(u) {
  u = String(u ?? '').trim();
  if (!u) return 'pics/default.jpg';
  if (/^https:\/\/[^\s"'<>]+$/i.test(u)) return u.slice(0, 300);
  if (/^[\w\-./ ]+$/.test(u) && !u.includes('..') && !u.startsWith('/')) return u.slice(0, 200);
  return null;
}
function maskEmail(email) {
  if (!email || typeof email !== 'string' || !email.includes('@')) return 'N/A';
  const [name, domain] = email.split('@');
  return (name.length <= 2 ? name : name.slice(0, 2)) + '***@' + domain;
}

// ------------------------------------------------------------------
// Sessions (random token in an HttpOnly cookie; only its hash is stored)
// ------------------------------------------------------------------
const REQUIRE_ADMIN_2FA = process.env.REQUIRE_ADMIN_2FA !== '0';
const COOKIE = 'mt_sid';
const SESSION_MAX_MS = 8 * 60 * 60 * 1000;
const IDLE_MS = { admin: 15 * 60 * 1000, user: 2 * 60 * 60 * 1000 };

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
function cookieOptions() {
  return { httpOnly: true, sameSite: 'strict', secure: IS_PROD, path: '/', maxAge: SESSION_MAX_MS };
}
function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('INSERT INTO sessions(token_hash, user_id, created_at, last_seen) VALUES(?,?,?,?)')
    .run(sha256(token), userId, now, now);
  res.cookie(COOKIE, token, cookieOptions());
}
function destroySession(req, res) {
  if (req.sessionHash) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(req.sessionHash);
  const { maxAge, ...opts } = cookieOptions();
  res.clearCookie(COOKIE, opts);
}
function destroyAllSessions(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}
// Attaches req.user (or null). The role is read from the database on every request.
function loadUser(req, res, next) {
  req.user = null;
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return next();
  const hash = sha256(token);
  const row = db.prepare(
    `SELECT s.created_at, s.last_seen, u.id, u.username, u.email, u.role, u.totp_enabled
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(hash);
  if (!row) return next();
  const now = Date.now();
  const idle = IDLE_MS[row.role] || IDLE_MS.user;
  if (now - row.created_at > SESSION_MAX_MS || now - row.last_seen > idle) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
    return next();
  }
  if (now - row.last_seen > 15000) db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').run(now, hash);
  req.user = {
    id: row.id, username: row.username, email: row.email, role: row.role,
    // Administrators must turn on 2FA; until they do, the session can only reach the 2FA setup screens.
    needs2fa: REQUIRE_ADMIN_2FA && row.role === 'admin' && !row.totp_enabled
  };
  req.sessionHash = hash;
  next();
}
const requireAuth = (req, res, next) =>
  req.user ? next() : res.status(401).json({ error: 'Please log in.' });
const SETUP_2FA_PATHS = new Set(['/2fa/status', '/2fa/setup', '/2fa/enable']);
const requireAdmin = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Please log in.' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access required.' });
  if (req.user.needs2fa && !SETUP_2FA_PATHS.has(req.path)) {
    return res.status(403).json({ error: 'Turn on two-factor authentication before using the admin panel.', setup2fa: true });
  }
  next();
};
setInterval(() => {
  const now = Date.now();
  db.prepare('DELETE FROM sessions WHERE created_at < ? OR last_seen < ?').run(now - SESSION_MAX_MS, now - IDLE_MS.user);
}, 10 * 60 * 1000).unref();

// ------------------------------------------------------------------
// CSRF: cookie is SameSite=Strict, and every state-changing request must
// carry a custom header (cross-site forms cannot add one) + a matching Origin.
// ------------------------------------------------------------------
function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-Requested-With') !== 'mosstech') return res.status(403).json({ error: 'Blocked request.' });
  const origin = req.get('Origin');
  if (origin) {
    try { if (new URL(origin).host !== req.get('Host')) throw 0; }
    catch { return res.status(403).json({ error: 'Blocked request.' }); }
  }
  next();
}

// ------------------------------------------------------------------
// Rate limiting (in memory) + per-key lockouts
// ------------------------------------------------------------------
function rateLimit({ windowMs, max, message, keyFn }) {
  const hits = new Map();
  setInterval(() => { const n = Date.now(); for (const [k, e] of hits) if (n > e.reset) hits.delete(k); }, windowMs).unref();
  return (req, res, next) => {
    const key = keyFn ? keyFn(req) : req.ip;
    const now = Date.now();
    let e = hits.get(key);
    if (!e || now > e.reset) { e = { count: 0, reset: now + windowMs }; hits.set(key, e); }
    if (++e.count > max) {
      res.set('Retry-After', String(Math.ceil((e.reset - now) / 1000)));
      return res.status(429).json({ error: message || 'Too many requests. Please slow down.' });
    }
    next();
  };
}
// Stored in SQLite (table "lockouts"), so restarting the server does not wipe them.
// Failures older than FAIL_WINDOW_MS stop counting. Login/verify/reset use keys that include the client IP,
// so a stranger cannot lock a real user out of their own account just by guessing at it.
const MAX_FAILS = 5, LOCK_MS = 60 * 1000, FAIL_WINDOW_MS = 15 * 60 * 1000;
const lockKey = (key) => String(key).slice(0, 300);
function lockRemaining(key) {
  const f = db.prepare('SELECT until FROM lockouts WHERE key = ?').get(lockKey(key));
  return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0;
}
function registerFail(key, opts = {}) {
  const max = opts.max || MAX_FAILS, lockMs = opts.lockMs || LOCK_MS;
  const k = lockKey(key), now = Date.now();
  const f = db.prepare('SELECT count, last_fail, until FROM lockouts WHERE key = ?').get(k);
  let count = (f && now - f.last_fail <= FAIL_WINDOW_MS ? f.count : 0) + 1;
  let until = f ? f.until : 0;               // never shorten a lock that is already running
  if (count >= max) { until = Math.max(until, now + lockMs); count = 0; }
  db.prepare(`INSERT INTO lockouts(key, count, last_fail, until) VALUES(?,?,?,?)
              ON CONFLICT(key) DO UPDATE SET count = excluded.count, last_fail = excluded.last_fail, until = excluded.until`)
    .run(k, count, now, until);
}
const clearFails = (key) => { db.prepare('DELETE FROM lockouts WHERE key = ?').run(lockKey(key)); };
const AUDIT_KEEP_MS = 180 * 24 * 60 * 60 * 1000;
setInterval(() => {
  const n = Date.now();
  db.prepare('DELETE FROM lockouts WHERE until < ? AND last_fail < ?').run(n, n - FAIL_WINDOW_MS);
  db.prepare('DELETE FROM audit_log WHERE ts < ?').run(n - AUDIT_KEEP_MS);
}, 5 * 60 * 1000).unref();

// ------------------------------------------------------------------
// Audit log: who did what, when, from where. Never pass secrets in `detail`.
// ------------------------------------------------------------------
function audit(req, action, detail = '', actor = null) {
  try {
    const u = actor || (req && req.user) || null;
    db.prepare('INSERT INTO audit_log(ts, user_id, username, action, detail, ip) VALUES(?,?,?,?,?,?)')
      .run(Date.now(), u ? u.id : null, u ? u.username : null, String(action).slice(0, 60),
           cleanText(detail, 300), req && req.ip ? String(req.ip).slice(0, 60) : null);
  } catch (e) { console.error('audit log failed:', e.message); }
}

// ------------------------------------------------------------------
// Headers
// ------------------------------------------------------------------
function securityHeaders(req, res, next) {
  res.set({
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "script-src-attr 'none'",          // inline onclick="..." attributes are blocked: all handlers live in the .js files
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com",
      "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com",
      "img-src 'self' data: https:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'"
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin'
  });
  if (IS_PROD) res.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
}
const noStore = (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };

// Lets async route handlers throw errors safely
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = {
  HttpError, sha256, safeEqual, hashSecret, verifySecret,
  isValidEmail, isValidUsername, isValidName, isValidPhone, passwordProblems, passkeyProblems, cleanText, cleanImageUrl, maskEmail,
  REQUIRE_ADMIN_2FA, audit,
  createSession, destroySession, destroyAllSessions, loadUser, requireAuth, requireAdmin,
  csrfGuard, rateLimit, lockRemaining, registerFail, clearFails, securityHeaders, noStore, ah
};
