'use strict';
const { db } = require('./db');
const totp = require('./totp');
const S = require('./security');

// Accepts a 6-digit authenticator code OR an 8-character backup code (each backup code works once).
function verifySecondFactor(userId, rawCode) {
  const u = db.prepare('SELECT totp_secret, totp_last_step FROM users WHERE id = ?').get(userId);
  if (!u || !u.totp_secret) return false;
  const code = String(rawCode || '').replace(/[\s-]/g, '').toLowerCase();
  if (/^\d{6}$/.test(code)) {
    const step = totp.verify(u.totp_secret, code, u.totp_last_step);
    if (!step) return false;
    db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, userId);
    return true;
  }
  if (/^[0-9a-f]{8}$/.test(code)) {
    return db.prepare('UPDATE totp_backup SET used = 1 WHERE user_id = ? AND code_hash = ? AND used = 0')
      .run(userId, S.sha256(code)).changes === 1;
  }
  return false;
}
module.exports = { verifySecondFactor };
