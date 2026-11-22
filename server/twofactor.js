'use strict';
const { db } = require('./db');
const totp = require('./totp');
const S = require('./security');

// Accepts a 6-digit authenticator code OR an 8-character backup code (each backup code works once).
async function verifySecondFactor(userId, rawCode) {
  const u = await db.one('SELECT totp_secret, totp_last_step FROM users WHERE id = $1', [userId]);
  if (!u || !u.totp_secret) return false;
  const code = String(rawCode || '').replace(/[\s-]/g, '').toLowerCase();
  if (/^\d{6}$/.test(code)) {
    const step = totp.verify(u.totp_secret, code, u.totp_last_step);
    if (!step) return false;
    // Atomic replay guard: only the request that moves totp_last_step forward wins, so the same code
    // cannot be used twice even if two requests arrive at the same moment.
    const r = await db.run('UPDATE users SET totp_last_step = $1::bigint WHERE id = $2 AND totp_last_step < $1::bigint', [step, userId]);
    return r.rowCount === 1;
  }
  if (/^[0-9a-f]{8}$/.test(code)) {
    const r = await db.run('UPDATE totp_backup SET used = 1 WHERE user_id = $1 AND code_hash = $2 AND used = 0',
      [userId, S.sha256(code)]);
    return r.rowCount === 1;
  }
  return false;
}
module.exports = { verifySecondFactor };
