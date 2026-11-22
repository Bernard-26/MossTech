'use strict';
const express = require('express');
const crypto = require('crypto');
const { db, tx, getSetting } = require('../db');
const S = require('../security');
const { sendMail } = require('../mailer');
const { verifySecondFactor } = require('../twofactor');

const router = express.Router();
const loginLimit = S.rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: 'Too many login attempts. Try again later.' });
const signupLimit = S.rateLimit({ windowMs: 60 * 60 * 1000, max: 20, message: 'Too many sign-ups from this network. Try again later.' });
const resetLimit = S.rateLimit({ windowMs: 15 * 60 * 1000, max: 15, message: 'Too many attempts. Try again later.' });

const REQUIRE_VERIFY = process.env.REQUIRE_EMAIL_VERIFICATION !== '0';
const VERIFY_TTL_MS = 15 * 60 * 1000;
const RESEND_GAP_MS = 60 * 1000;

const publicUser = (u) => ({ username: u.username, email: u.email, role: u.role });
const str = (v, max = 200) => String(v ?? '').slice(0, max);
const sixDigits = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

// ---------- Email verification codes ----------
async function issueVerificationCode(user) {
  const code = sixDigits();
  const now = Date.now();
  await db.run(
    `INSERT INTO email_verifications(user_id, code_hash, expires_at, tries, sent_at) VALUES($1,$2,$3,0,$4)
     ON CONFLICT (user_id) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at,
                                         tries = 0, sent_at = EXCLUDED.sent_at`,
    [user.id, S.sha256(code), now + VERIFY_TTL_MS, now]);
  await sendMail({
    to: user.email,
    subject: 'Your MOSSTECH verification code',
    text: `Your MOSSTECH verification code is ${code}\n\nIt expires in 15 minutes. If you did not create an account, you can ignore this email.`
  });
}

router.get('/me', (req, res) => res.json({ user: req.user ? { ...publicUser(req.user), needs2fa: Boolean(req.user.needs2fa) } : null }));

router.post('/signup', signupLimit, S.ah(async (req, res) => {
  const b = req.body || {};
  const username = str(b.username).trim();
  const email = str(b.email).trim().toLowerCase();
  const password = str(b.password, 300);
  const role = b.role === 'admin' ? 'admin' : 'user';

  if (!S.isValidUsername(username)) return res.status(400).json({ error: 'Username must be 3-20 characters: letters, numbers or underscore.' });
  if (!S.isValidEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
  const issues = S.passwordProblems(password);
  if (issues.length) return res.status(400).json({ error: 'Password needs: ' + issues.join(', ') + '.' });

  if (role === 'admin') {
    const stored = await getSetting('admin_passkey_hash');
    if (!stored) return res.status(403).json({ error: 'Administrator sign-up is disabled. Set ADMIN_PASSKEY in the server .env file.' });
    const key = 'passkey:' + req.ip;
    const wait = await S.lockRemaining(key);
    if (wait) return res.status(429).json({ error: `Too many failed attempts. Try again in ${wait}s.` });
    if (!await S.verifySecret(str(b.adminKey, 300), stored)) {
      await S.registerFail(key);
      await S.audit(req, 'admin_signup_bad_passkey', `attempted username: ${username}`);
      return res.status(403).json({ error: 'Invalid admin passkey.' });
    }
    await S.clearFails(key);
  }

  if (await db.one('SELECT 1 FROM users WHERE username = $1', [username])) return res.status(409).json({ error: 'That username is already taken.' });
  if (await db.one('SELECT 1 FROM users WHERE email = $1', [email])) return res.status(409).json({ error: 'An account with that email already exists.' });

  const pw_hash = await S.hashSecret(password);
  let id;
  try {
    id = (await db.one('INSERT INTO users(username, email, role, pw_hash, email_verified) VALUES($1,$2,$3,$4,$5) RETURNING id',
      [username, email, role, pw_hash, REQUIRE_VERIFY ? 0 : 1])).id;
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That username or email is already registered.' }); // unique violation (two sign-ups at once)
    throw e;
  }
  await S.audit(req, role === 'admin' ? 'admin_account_created' : 'account_created', `username: ${username}`, { id, username });
  if (REQUIRE_VERIFY) await issueVerificationCode({ id, email });
  res.status(201).json({ ok: true, needsVerification: REQUIRE_VERIFY, email });
}));

router.post('/verify-email', resetLimit, S.ah(async (req, res) => {
  const email = str((req.body || {}).email).trim().toLowerCase();
  const code = str((req.body || {}).code, 20).replace(/\s/g, '');
  const BAD = 'Invalid or expired verification code.';
  // Keyed by IP + email: a stranger cannot block the real owner from verifying their own address
  const lockKey = `verify:${req.ip}:${email}`;
  const wait = await S.lockRemaining(lockKey);
  if (wait) return res.status(429).json({ error: `Too many failed attempts. Try again in ${wait}s.` });

  const user = await db.one('SELECT id FROM users WHERE email = $1', [email]);
  // One atomic statement counts this attempt AND checks expiry / the 5-try limit, so parallel guesses cannot all
  // get past a stale "tries" value. No row back = no code, expired, or out of tries.
  const row = user && await db.one(
    'UPDATE email_verifications SET tries = tries + 1 WHERE user_id = $1 AND tries < 5 AND expires_at >= $2 RETURNING code_hash',
    [user.id, Date.now()]);
  if (!row) { await S.registerFail(lockKey); return res.status(400).json({ error: BAD }); }
  if (!/^\d{6}$/.test(code) || !S.safeEqual(S.sha256(code), row.code_hash)) { await S.registerFail(lockKey); return res.status(400).json({ error: BAD }); }

  await tx(async (t) => {
    await t.run('UPDATE users SET email_verified = 1 WHERE id = $1', [user.id]);
    await t.run('DELETE FROM email_verifications WHERE user_id = $1', [user.id]);
  });
  await S.clearFails(lockKey);
  res.json({ ok: true });
}));

router.post('/resend-code', resetLimit, S.ah(async (req, res) => {
  const email = str((req.body || {}).email).trim().toLowerCase();
  const user = S.isValidEmail(email) && await db.one('SELECT id, email, email_verified FROM users WHERE email = $1', [email]);
  if (user && !user.email_verified) {
    const last = await db.one('SELECT sent_at FROM email_verifications WHERE user_id = $1', [user.id]);
    if (!last || Date.now() - last.sent_at >= RESEND_GAP_MS) await issueVerificationCode(user);
  }
  res.json({ ok: true }); // same reply whether or not the account exists
}));

// ---------- Login (password, then email check, then optional 2FA for admins) ----------
const challenges = new Map(); // sha256(challenge) -> { userId, expires, tries }
setInterval(() => { const n = Date.now(); for (const [k, c] of challenges) if (n > c.expires) challenges.delete(k); }, 60 * 1000).unref();

async function finishLogin(req, res, user) {
  if (req.sessionHash) await S.destroySession(req, res); // never reuse an old session id
  await S.createSession(res, user.id);
  await S.audit(req, 'login_success', `role: ${user.role}`, user);
  res.json({ user: publicUser(user) });
}

router.post('/login', loginLimit, S.ah(async (req, res) => {
  const id = str((req.body || {}).id).trim().toLowerCase();
  const password = str((req.body || {}).password, 300);
  if (!id || !password) return res.status(400).json({ error: 'Please enter your username/email and password.' });

  // Two counters: (IP + account) locks after 5 misses; the account alone locks only after a much larger number
  // of misses from anywhere, so one stranger cannot easily lock a real user out, yet a distributed attack is still slowed.
  const ipKey = `login:${req.ip}:${id}`, acctKey = `login-acct:${id}`;
  const wait = Math.max(await S.lockRemaining(ipKey), await S.lockRemaining(acctKey));
  if (wait) return res.status(429).json({ error: `Too many failed attempts. Try again in ${wait}s.` });

  const user = await db.one('SELECT * FROM users WHERE username = $1 OR email = $1', [id]);
  const ok = await S.verifySecret(password, user ? user.pw_hash : null); // same work whether or not the user exists
  if (!user || !ok) {
    await S.registerFail(ipKey);
    await S.registerFail(acctKey, { max: 30, lockMs: 3 * 60 * 1000 });
    await S.audit(req, 'login_failed', `account: ${id.slice(0, 60)}`);
    return res.status(401).json({ error: 'Invalid username/email or password.' });
  }
  await S.clearFails(ipKey);
  await S.clearFails(acctKey);

  if (REQUIRE_VERIFY && !user.email_verified) {
    return res.status(403).json({ error: 'Please verify your email address first.', needsVerification: true, email: user.email });
  }
  if (user.role === 'admin' && user.totp_enabled) {
    const challenge = crypto.randomBytes(24).toString('base64url');
    challenges.set(S.sha256(challenge), { userId: user.id, expires: Date.now() + 5 * 60 * 1000, tries: 0 });
    return res.json({ twoFactorRequired: true, challenge });
  }
  await finishLogin(req, res, user);
}));

router.post('/login/2fa', loginLimit, S.ah(async (req, res) => {
  const key = S.sha256(str((req.body || {}).challenge, 100));
  const entry = challenges.get(key);
  if (!entry || Date.now() > entry.expires) return res.status(401).json({ error: 'Your login session expired. Please log in again.', restart: true });

  const lockKey = '2fa:' + entry.userId;
  const wait = await S.lockRemaining(lockKey);
  if (wait) return res.status(429).json({ error: `Too many failed attempts. Try again in ${wait}s.` });

  if (++entry.tries > 5) { challenges.delete(key); return res.status(401).json({ error: 'Too many wrong codes. Please log in again.', restart: true }); }
  if (!await verifySecondFactor(entry.userId, (req.body || {}).code)) {
    await S.registerFail(lockKey);
    await S.audit(req, 'login_2fa_failed', `user id: ${entry.userId}`, { id: entry.userId, username: null });
    return res.status(401).json({ error: 'Invalid code.' });
  }
  challenges.delete(key);
  await S.clearFails(lockKey);
  const user = await db.one('SELECT id, username, email, role FROM users WHERE id = $1', [entry.userId]);
  if (!user) return res.status(401).json({ error: 'Your login session expired. Please log in again.', restart: true });
  await finishLogin(req, res, user);
}));

router.post('/logout', S.ah(async (req, res) => {
  if (req.user) await S.audit(req, 'logout');
  await S.destroySession(req, res);
  res.json({ ok: true });
}));

// ---------- Forgot / reset password ----------
const resetCodes = new Map(); // email -> { hash, expires, tries }

router.post('/forgot', resetLimit, S.ah(async (req, res) => {
  const email = str((req.body || {}).email).trim().toLowerCase();
  if (!S.isValidEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
  const user = await db.one('SELECT role FROM users WHERE email = $1', [email]);
  if (user && user.role === 'user') {
    const code = sixDigits();
    resetCodes.set(email, { hash: S.sha256(code), expires: Date.now() + 5 * 60 * 1000, tries: 0 });
    sendMail({ to: email, subject: 'MOSSTECH password reset code',
      text: `Your MOSSTECH password reset code is ${code}\n\nIt is valid for 5 minutes. If you did not ask for this, ignore this email.` }).catch(() => {});
  }
  res.json({ ok: true });
}));

router.post('/reset', resetLimit, S.ah(async (req, res) => {
  const b = req.body || {};
  const email = str(b.email).trim().toLowerCase();
  const secret = str(b.secret, 300);
  const newPw = str(b.newPassword, 300);
  const BAD = 'Invalid or expired reset code / passkey.';
  if (!S.isValidEmail(email) || !secret) return res.status(400).json({ error: BAD });

  const resetKey = `reset:${req.ip}:${email}`;
  const wait = await S.lockRemaining(resetKey);
  if (wait) return res.status(429).json({ error: `Too many failed attempts. Try again in ${wait}s.` });

  const user = await db.one('SELECT id, username, role, totp_enabled FROM users WHERE email = $1', [email]);
  let ok = false;
  if (user && user.role === 'admin') {
    ok = await S.verifySecret(secret, await getSetting('admin_passkey_hash'));
    // The passkey alone must not be enough to take over an admin who has 2FA: ask for the authenticator/backup code too.
    // (Only revealed AFTER the passkey was correct, so it tells an outsider nothing.)
    if (ok && user.totp_enabled) {
      const code = str(b.code, 20);
      if (!code) return res.status(400).json({ error: 'Enter the code from your authenticator app (or a backup code) too.', needsCode: true });
      if (!await verifySecondFactor(user.id, code)) {
        await S.registerFail(resetKey);
        await S.audit(req, 'admin_reset_bad_2fa', `account: ${user.username}`, user);
        return res.status(400).json({ error: 'Invalid authenticator or backup code.', needsCode: true });
      }
    }
  } else {
    await S.verifySecret(secret, null);
    const entry = resetCodes.get(email);
    if (user && entry && Date.now() <= entry.expires && entry.tries < 5) {
      entry.tries++;
      ok = S.safeEqual(S.sha256(secret.trim()), entry.hash);
    }
  }
  if (!ok) {
    await S.registerFail(resetKey);
    if (user) await S.audit(req, 'password_reset_failed', `account: ${user.username}`, user);
    return res.status(400).json({ error: BAD });
  }

  const issues = S.passwordProblems(newPw);
  if (issues.length) return res.status(400).json({ error: 'Password needs: ' + issues.join(', ') + '.' });

  await db.run("UPDATE users SET pw_hash = $1, email_verified = CASE WHEN role = 'user' THEN 1 ELSE email_verified END WHERE id = $2",
    [await S.hashSecret(newPw), user.id]);
  await S.destroyAllSessions(user.id);
  resetCodes.delete(email);
  await S.clearFails(resetKey);
  await S.audit(req, 'password_reset', `account: ${user.username} (${user.role})`, user);
  res.json({ ok: true });
}));

// ---------- Delete Account ----------
// Needs the account password again (a stolen session alone cannot delete the account),
// and the last remaining administrator can never be deleted.
router.delete('/account', S.ah(async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'You must be logged in to delete your account.' });
  }
  const userId = req.user.id;
  const lockKey = 'delacct:' + userId;
  const wait = await S.lockRemaining(lockKey);
  if (wait) return res.status(429).json({ error: `Too many failed attempts. Try again in ${wait}s.` });

  const me = await db.one('SELECT pw_hash, role FROM users WHERE id = $1', [userId]);
  if (!me) return res.status(404).json({ error: 'User account not found.' });
  if (!await S.verifySecret(str((req.body || {}).password, 300), me.pw_hash)) {
    await S.registerFail(lockKey);
    await S.audit(req, 'account_delete_bad_password');
    return res.status(403).json({ error: 'Your password is incorrect.' });
  }
  await S.clearFails(lockKey);

  // Locking the admin rows makes "am I the last administrator?" safe even if two admins delete themselves at once.
  const outcome = await tx(async (t) => {
    if (me.role === 'admin') {
      const admins = await t.all("SELECT id FROM users WHERE role = 'admin' FOR UPDATE");
      if (admins.length <= 1) return 'last-admin';
    }
    await t.run('UPDATE orders SET user_id = NULL WHERE user_id = $1', [userId]);
    const r = await t.run('DELETE FROM users WHERE id = $1', [userId]);   // sessions + verification codes cascade
    return r.rowCount ? 'deleted' : 'missing';
  });
  if (outcome === 'last-admin') return res.status(400).json({ error: 'You are the only administrator, so this account cannot be deleted.' });
  if (outcome === 'missing') return res.status(404).json({ error: 'User account not found.' });

  await S.audit(req, 'account_deleted', `role: ${me.role}`);
  await S.destroyAllSessions(userId);
  if (req.sessionHash) await S.destroySession(req, res);
  res.json({ ok: true, message: 'Account deleted successfully.' });
}));

module.exports = router;
