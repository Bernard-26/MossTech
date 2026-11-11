'use strict';
// Time-based one-time passwords (RFC 6238) - works with Google Authenticator, Microsoft Authenticator, Authy.
// Built only on Node's crypto module (no extra package).
const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of String(str).replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(ch);
    if (i < 0) continue;
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function generateSecret() { return base32Encode(crypto.randomBytes(20)); }

function hotp(keyBuf, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', keyBuf).update(msg).digest();
  const o = h[19] & 15;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 1000000).padStart(6, '0');
}
// Returns the matching time step (a number > lastStep) or 0. Accepts one step either side (clock drift).
// Passing the last accepted step stops the same code from being used twice.
function verify(secretB32, code, lastStep = 0, nowMs = Date.now()) {
  if (!/^\d{6}$/.test(String(code))) return 0;
  const key = base32Decode(secretB32);
  const current = Math.floor(nowMs / 1000 / STEP_SECONDS);
  for (const drift of [-1, 0, 1]) {
    const step = current + drift;
    if (step <= lastStep) continue;
    const a = Buffer.from(hotp(key, step)), b = Buffer.from(String(code));
    if (crypto.timingSafeEqual(a, b)) return step;
  }
  return 0;
}
function otpauthUri(secret, account, issuer = 'MOSSTECH') {
  return `otpauth://totp/${encodeURIComponent(issuer + ':' + account)}?secret=${secret}` +
         `&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;
}
module.exports = { generateSecret, verify, hotp, base32Decode, base32Encode, otpauthUri };
