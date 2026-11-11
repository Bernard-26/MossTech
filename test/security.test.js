// Security regression tests: starts the real server and checks the hardening described in SECURITY.md
const path = require('path'), os = require('os'), fs = require('fs');
const assert = require('assert');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DB = path.join(os.tmpdir(), 'mosstech-sec-test.db');
for (const ext of ['', '-wal', '-shm']) fs.rmSync(DB + ext, { force: true });
const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSKEY = 'Passkey#Strong-2026x';
const totp = require('../server/totp');

// ---------- in-process unit checks ----------
process.env.DB_PATH = DB + '-unit';
for (const ext of ['', '-wal', '-shm']) fs.rmSync(process.env.DB_PATH + ext, { force: true });
const S = require('../server/security');
const { db } = require('../server/db');
assert(S.passkeyProblems('Short#1a').includes('at least 12 characters'), 'short passkey rejected');
assert.deepEqual(S.passkeyProblems('Long#Passkey-2026'), [], 'long strong passkey accepted');
// lockouts live in the database, expire by window, and never get shortened
for (let i = 0; i < 5; i++) S.registerFail('t:unit');
assert(S.lockRemaining('t:unit') > 0, 'locked after 5 failures');
assert(db.prepare('SELECT until FROM lockouts WHERE key = ?').get('t:unit').until > Date.now(), 'lock is stored in the database');
S.registerFail('t:unit');
assert(S.lockRemaining('t:unit') > 0, 'extra failure does not unlock');
S.clearFails('t:unit'); assert.equal(S.lockRemaining('t:unit'), 0);
// audit log stores text safely
S.audit({ ip: '1.2.3.4' }, 'unit_test', 'hello <b>x</b>');
assert.equal(db.prepare("SELECT detail FROM audit_log WHERE action='unit_test'").get().detail, 'hello b x /b');
// requireAdmin: an admin without 2FA can reach ONLY the setup routes
const run = (user, p) => { let out = { status: 0 }; const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; } };
  S.requireAdmin({ user, path: p }, res, () => { out.status = 200; }); return out; };
assert.equal(run({ role: 'admin', needs2fa: true }, '/summary').status, 403);
assert.equal(run({ role: 'admin', needs2fa: true }, '/2fa/setup').status, 200);
assert.equal(run({ role: 'admin', needs2fa: false }, '/summary').status, 200);
assert.equal(run({ role: 'user' }, '/2fa/setup').status, 403);
assert.equal(run(null, '/summary').status, 401);
console.log('unit checks ok');

// ---------- integration: real server ----------
function client(ip) {
  let cookie = '';
  return async (method, url, body, extra = {}) => {
    const headers = { 'X-Requested-With': 'mosstech', Origin: BASE, 'X-Forwarded-For': ip, ...extra };
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(BASE + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (sc.length) { const c = sc[0].split(';')[0]; cookie = c.endsWith('=') ? '' : c; }
    let data = null; const text = await res.text(); try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  };
}
const codeFor = (secret, stepOffset = 0) =>
  totp.hotp(totp.base32Decode(secret), Math.floor(Date.now() / 1000 / 30) + stepOffset);

(async () => {
  const server = spawn(process.execPath, ['--no-warnings', 'server.js'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DB_PATH: DB, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'development', TRUST_PROXY: '1',
           ADMIN_PASSKEY: PASSKEY, REQUIRE_EMAIL_VERIFICATION: '0', REQUIRE_ADMIN_2FA: '1',
           SEED_ADMIN_USERNAME: '', SEED_ADMIN_EMAIL: '', SEED_ADMIN_PASSWORD: '', BREVO_API_KEY: '', SMTP_HOST: '' }
  });
  let log = ''; server.stdout.on('data', d => log += d); server.stderr.on('data', d => log += d);
  try {
    for (let i = 0; i < 60 && !log.includes('running at'); i++) await new Promise(r => setTimeout(r, 250));
    assert(log.includes('running at'), 'server started: ' + log);

    const anon = client('9.9.9.9');
    // headers / files
    const page = await anon('GET', '/login.html');
    const csp = page.headers.get('content-security-policy');
    assert(csp.includes("script-src-attr 'none'") && !/script-src 'self' 'unsafe/.test(csp), 'CSP blocks inline scripts');
    assert(!/\son[a-z]+="/.test(page.data), 'login.html has no inline handlers');
    assert.equal((await anon('GET', '/pics/report.pdf')).status, 404, 'pdf not served');
    assert.equal((await anon('GET', '/admin.js')).status, 404, 'admin.js hidden from visitors');
    assert.equal((await anon('GET', '/admin.css')).status, 404, 'admin.css hidden from visitors');
    assert.equal((await anon('GET', '/admin.html')).status, 302, 'admin page redirects visitors');
    assert.equal((await anon('GET', '/home.js')).status, 200, 'normal scripts still served');

    // admin sign-up needs the passkey; then 2FA is forced
    const adm = client('10.0.0.1');
    const bad = await adm('POST', '/api/auth/signup', { username: 'boss', email: 'boss@example.com', password: 'Str0ng#Pass1', role: 'admin', adminKey: 'nope' });
    assert.equal(bad.status, 403);
    assert.equal((await adm('POST', '/api/auth/signup', { username: 'boss', email: 'boss@example.com', password: 'Str0ng#Pass1', role: 'admin', adminKey: PASSKEY })).status, 201);
    assert.equal((await adm('POST', '/api/auth/login', { id: 'boss', password: 'Str0ng#Pass1' })).status, 200);
    const me = await adm('GET', '/api/auth/me');
    assert.equal(me.data.user.needs2fa, true, 'admin without 2FA is flagged');
    const blocked = await adm('GET', '/api/admin/summary');
    assert.equal(blocked.status, 403); assert.equal(blocked.data.setup2fa, true, 'admin API locked until 2FA is on');
    assert.equal((await adm('GET', '/api/admin/audit')).status, 403);
    assert.equal((await adm('GET', '/api/admin/2fa/status')).data.required, true);
    assert.equal((await adm('GET', '/admin.js')).status, 200, 'admin.js served to admins');

    const setup = await adm('POST', '/api/admin/2fa/setup', { password: 'Str0ng#Pass1' });
    assert(setup.data.secret, '2FA secret issued');
    const en = await adm('POST', '/api/admin/2fa/enable', { code: codeFor(setup.data.secret) });
    assert.equal(en.status, 200); assert.equal(en.data.backupCodes.length, 8);
    assert.equal((await adm('GET', '/api/admin/summary')).status, 200, 'admin panel unlocked after 2FA');
    const audit = (await adm('GET', '/api/admin/audit')).data.entries.map(e => e.action);
    assert(audit.includes('login_success') && audit.includes('2fa_enabled') && audit.includes('admin_account_created'), 'audit log records events: ' + audit);
    assert(!JSON.stringify((await adm('GET', '/api/admin/audit')).data).includes('Str0ng#Pass1'), 'no password in audit log');

    // account deletion: needs password; last admin protected
    assert.equal((await adm('DELETE', '/api/auth/account', {})).status, 403, 'delete without password refused');
    assert.equal((await adm('DELETE', '/api/auth/account', { password: 'wrong' })).status, 403);
    const last = await adm('DELETE', '/api/auth/account', { password: 'Str0ng#Pass1' });
    assert.equal(last.status, 400, 'last admin cannot be deleted'); assert(/only administrator/.test(last.data.error));

    // a normal user can delete only with the password
    const usr = client('10.0.0.2');
    assert.equal((await usr('POST', '/api/auth/signup', { username: 'juan', email: 'juan@example.com', password: 'Juan#1234x' })).status, 201);
    assert.equal((await usr('POST', '/api/auth/login', { id: 'juan', password: 'Juan#1234x' })).status, 200);
    assert.equal((await usr('DELETE', '/api/auth/account')).status, 403);
    assert.equal((await usr('DELETE', '/api/auth/account', { password: 'Juan#1234x' })).status, 200);
    assert.equal((await usr('GET', '/api/auth/me')).data.user, null, 'session gone after deletion');

    // admin password reset: the passkey alone is not enough when 2FA is on
    const rst = client('10.0.0.3');
    const r1 = await rst('POST', '/api/auth/reset', { email: 'boss@example.com', secret: PASSKEY, newPassword: 'Newer#Pass99' });
    assert.equal(r1.status, 400); assert.equal(r1.data.needsCode, true, 'asks for the 2FA code');
    assert.equal((await rst('POST', '/api/auth/login', { id: 'boss', password: 'Newer#Pass99' })).status, 401, 'password NOT changed yet');
    const r2 = await rst('POST', '/api/auth/reset', { email: 'boss@example.com', secret: PASSKEY, newPassword: 'Newer#Pass99', code: '000000' });
    assert.equal(r2.status, 400);
    const r3 = await rst('POST', '/api/auth/reset', { email: 'boss@example.com', secret: 'Wrong#Passkey1', newPassword: 'Newer#Pass99', code: codeFor(setup.data.secret, 1) });
    assert.equal(r3.status, 400); assert(!r3.data.needsCode, 'wrong passkey never reveals the 2FA step');
    const r4 = await rst('POST', '/api/auth/reset', { email: 'boss@example.com', secret: PASSKEY, newPassword: 'Newer#Pass99', code: codeFor(setup.data.secret, 1) });
    assert.equal(r4.status, 200, 'passkey + valid 2FA code resets the password: ' + JSON.stringify(r4.data));
    assert.equal((await rst('POST', '/api/auth/login', { id: 'boss', password: 'Newer#Pass99' })).data.twoFactorRequired, true);

    // lockout is per IP: an attacker cannot lock the real owner out
    const attacker = client('6.6.6.6'), owner = client('7.7.7.7');
    assert.equal((await owner('POST', '/api/auth/signup', { username: 'maria', email: 'maria@example.com', password: 'Maria#1234x' })).status, 201);
    for (let i = 0; i < 5; i++) assert.equal((await attacker('POST', '/api/auth/login', { id: 'maria', password: 'guess' + i })).status, 401);
    assert.equal((await attacker('POST', '/api/auth/login', { id: 'maria', password: 'Maria#1234x' })).status, 429, 'attacker IP is locked');
    assert.equal((await owner('POST', '/api/auth/login', { id: 'maria', password: 'Maria#1234x' })).status, 200, 'real owner NOT locked out');

    console.log('SECURITY TESTS PASSED');
    server.kill(); process.exit(0);
  } catch (e) {
    console.error('FAIL', e, '\n--- server log ---\n' + log.slice(-1500));
    server.kill(); process.exit(1);
  }
})();
