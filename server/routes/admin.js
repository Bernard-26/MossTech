'use strict';
const express = require('express');
const { db, getSetting, setSetting, tx } = require('../db');
const S = require('../security');
const svc = require('../services');
const crypto = require('crypto');
const totp = require('../totp');
const { verifySecondFactor } = require('../twofactor');
let QRCode = null;
try { QRCode = require('qrcode'); } catch (e) { /* optional: the secret key is shown as text instead */ }

const router = express.Router();
router.use(S.requireAdmin); // every route below is administrator-only

const CATEGORIES = ['laptops', 'cellphones', 'tablets', 'other'];

router.get('/summary', (req, res) => {
  res.json({
    users: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
    orders: db.prepare('SELECT COUNT(*) AS n FROM orders').get().n
  });
});

router.get('/users', (req, res) => {
  const users = db.prepare('SELECT username, email, role FROM users ORDER BY id').all()
    .map(u => ({ username: u.username, email: S.maskEmail(u.email), role: u.role }));
  res.json({ users });
});

// ---------- Products ----------
function readProduct(b, res) {
  const name = S.cleanText(b.name, 100);
  const price = Number(b.price), stock = Number(b.stock);
  const image_url = S.cleanImageUrl(b.image_url);
  const category = CATEGORIES.includes(String(b.category).toLowerCase()) ? String(b.category).toLowerCase() : 'other';
  const brand = S.cleanText(b.brand, 40).toLowerCase();
  const discount = Number(b.discount_percent === '' || b.discount_percent == null ? 0 : b.discount_percent);
  let err = null;
  if (name.length < 2) err = 'Product name must be at least 2 characters.';
  else if (!Number.isFinite(price) || price < 0 || price > 10000000) err = 'Enter a valid price.';
  else if (!Number.isInteger(stock) || stock < 0 || stock > 100000) err = 'Enter a valid stock number.';
  else if (!Number.isInteger(discount) || discount < 0 || discount > 90) err = 'Discount must be a whole number from 0 to 90.';
  else if (!image_url) err = 'Image must be a relative path like pics/item.jpg or an https:// URL.';
  if (err) { res.status(400).json({ error: err }); return null; }
  return { name, price: Math.round(price * 100) / 100, stock, image_url, category, brand, discount_percent: discount };
}
router.post('/products', (req, res) => {
  const p = readProduct(req.body || {}, res); if (!p) return;
  const id = db.prepare('INSERT INTO products(name, price, stock, image_url, category, brand, discount_percent) VALUES(?,?,?,?,?,?,?)')
    .run(p.name, p.price, p.stock, p.image_url, p.category, p.brand, p.discount_percent).lastInsertRowid;
  S.audit(req, 'product_created', `#${id} ${p.name}`);
  res.status(201).json({ id: Number(id) });
});
router.put('/products/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM products WHERE id = ?').get(id)) return res.status(404).json({ error: 'Product not found.' });
  const p = readProduct(req.body || {}, res); if (!p) return;
  db.prepare('UPDATE products SET name=?, price=?, stock=?, image_url=?, category=?, brand=?, discount_percent=? WHERE id=?')
    .run(p.name, p.price, p.stock, p.image_url, p.category, p.brand, p.discount_percent, id);
  S.audit(req, 'product_updated', `#${id} ${p.name}`);
  res.json({ ok: true });
});
router.delete('/products/:id', (req, res) => {
  const r = db.prepare('DELETE FROM products WHERE id = ?').run(Number(req.params.id));
  if (!r.changes) return res.status(404).json({ error: 'Product not found.' });
  S.audit(req, 'product_deleted', `#${Number(req.params.id)}`);
  res.json({ ok: true });
});

// ---------- Orders ----------
router.get('/orders', (req, res) => {
  const orders = db.prepare('SELECT * FROM orders ORDER BY id DESC').all().map(o => ({
    order_number: o.order_number, customer_name: o.customer_name, customer_email: S.maskEmail(o.customer_email),
    payment_method: o.payment_method, total_amount: o.total_amount, order_date: o.order_date,
    status: o.status, items: svc.itemsFor(o.id)
  }));
  res.json({ orders });
});
router.patch('/orders/:number/status', (req, res) => {
  const status = String((req.body || {}).status || '');
  if (!svc.ORDER_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status selected.' });
  const r = db.prepare('UPDATE orders SET status = ? WHERE order_number = ?').run(status, req.params.number);
  if (!r.changes) return res.status(404).json({ error: 'Order not found.' });
  S.audit(req, 'order_status_changed', `${req.params.number} -> ${status}`);
  res.json({ ok: true });
});
router.delete('/orders/:number', (req, res) => {
  const r = db.prepare('DELETE FROM orders WHERE order_number = ?').run(req.params.number);
  if (!r.changes) return res.status(404).json({ error: 'Order not found.' });
  S.audit(req, 'order_deleted', req.params.number);
  res.json({ ok: true });
});

// ---------- Settings ----------
const DEFAULT_SETTINGS = { storeName: 'MOSSTECH', supportEmail: 'support@mosstech.com', shippingFee: 59 };
router.get('/settings', (req, res) => {
  let saved = {};
  try { saved = JSON.parse(getSetting('store_settings', '{}')); } catch { /* ignore */ }
  res.json({ settings: { ...DEFAULT_SETTINGS, ...saved } });
});
router.put('/settings', (req, res) => {
  const b = req.body || {};
  const storeName = S.cleanText(b.storeName, 80);
  const supportEmail = String(b.supportEmail || '').trim().toLowerCase();
  const shippingFee = Number(b.shippingFee);
  if (storeName.length < 2) return res.status(400).json({ error: 'Store name must be at least 2 characters.' });
  if (!S.isValidEmail(supportEmail)) return res.status(400).json({ error: 'Enter a valid support email.' });
  if (!Number.isFinite(shippingFee) || shippingFee < 0 || shippingFee > 100000) return res.status(400).json({ error: 'Enter a valid shipping fee.' });
  setSetting('store_settings', JSON.stringify({ storeName, supportEmail, shippingFee }));
  S.audit(req, 'store_settings_changed');
  res.json({ ok: true });
});

// ---------- Admin passkey (needs the admin's own password too) ----------
router.put('/passkey', S.ah(async (req, res) => {
  const { currentPassword, newPasskey } = req.body || {};
  const me = db.prepare('SELECT pw_hash FROM users WHERE id = ?').get(req.user.id);
  const wait = S.lockRemaining('pk:' + req.user.id);
  if (wait) return res.status(429).json({ error: `Too many failed attempts. Try again in ${wait}s.` });
  if (!await S.verifySecret(String(currentPassword || ''), me && me.pw_hash)) {
    S.registerFail('pk:' + req.user.id);
    return res.status(403).json({ error: 'Your current password is incorrect.' });
  }
  const issues = S.passkeyProblems(String(newPasskey || ''));
  if (issues.length) return res.status(400).json({ error: 'Passkey needs: ' + issues.join(', ') + '.' });
  setSetting('admin_passkey_hash', await S.hashSecret(String(newPasskey)));
  S.audit(req, 'admin_passkey_changed');
  res.json({ ok: true });
}));

// ---------- Two-factor authentication (authenticator app) ----------
async function checkPassword(req, res, pw) {
  const wait = S.lockRemaining('pk:' + req.user.id);
  if (wait) { res.status(429).json({ error: `Too many failed attempts. Try again in ${wait}s.` }); return false; }
  const me = db.prepare('SELECT pw_hash FROM users WHERE id = ?').get(req.user.id);
  if (!await S.verifySecret(String(pw || ''), me && me.pw_hash)) {
    S.registerFail('pk:' + req.user.id);
    res.status(403).json({ error: 'Your current password is incorrect.' });
    return false;
  }
  S.clearFails('pk:' + req.user.id);
  return true;
}

router.get('/2fa/status', (req, res) => {
  const u = db.prepare('SELECT totp_enabled FROM users WHERE id = ?').get(req.user.id);
  const left = db.prepare('SELECT COUNT(*) AS n FROM totp_backup WHERE user_id = ? AND used = 0').get(req.user.id).n;
  res.json({ enabled: Boolean(u.totp_enabled), backupLeft: left, required: S.REQUIRE_ADMIN_2FA });
});

router.post('/2fa/setup', S.ah(async (req, res) => {
  if (!await checkPassword(req, res, (req.body || {}).password)) return;
  if (db.prepare('SELECT totp_enabled FROM users WHERE id = ?').get(req.user.id).totp_enabled) {
    return res.status(400).json({ error: 'Two-factor is already enabled.' });
  }
  const secret = totp.generateSecret();
  db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 0, totp_last_step = 0 WHERE id = ?').run(secret, req.user.id);
  const uri = totp.otpauthUri(secret, req.user.email);
  let qr = null;
  if (QRCode) { try { qr = await QRCode.toDataURL(uri, { margin: 1, width: 220 }); } catch (e) { /* show the key instead */ } }
  res.json({ secret, qr });
}));

router.post('/2fa/enable', (req, res) => {
  const u = db.prepare('SELECT totp_secret, totp_enabled FROM users WHERE id = ?').get(req.user.id);
  if (!u.totp_secret || u.totp_enabled) return res.status(400).json({ error: 'Start the setup first.' });
  const wait = S.lockRemaining('2fa-setup:' + req.user.id);
  if (wait) return res.status(429).json({ error: `Too many failed attempts. Try again in ${wait}s.` });
  const step = totp.verify(u.totp_secret, String((req.body || {}).code || '').replace(/\s/g, ''), 0);
  if (!step) { S.registerFail('2fa-setup:' + req.user.id); return res.status(400).json({ error: 'That code is not correct. Check the time on your phone and try again.' }); }

  const codes = Array.from({ length: 8 }, () => crypto.randomBytes(4).toString('hex'));
  tx(() => {
    db.prepare('UPDATE users SET totp_enabled = 1, totp_last_step = ? WHERE id = ?').run(step, req.user.id);
    db.prepare('DELETE FROM totp_backup WHERE user_id = ?').run(req.user.id);
    const ins = db.prepare('INSERT INTO totp_backup(user_id, code_hash) VALUES(?,?)');
    codes.forEach(c => ins.run(req.user.id, S.sha256(c)));
  });
  S.clearFails('2fa-setup:' + req.user.id);
  S.audit(req, '2fa_enabled');
  res.json({ ok: true, backupCodes: codes.map(c => c.slice(0, 4) + '-' + c.slice(4)) }); // shown only once
});

router.post('/2fa/disable', S.ah(async (req, res) => {
  if (!await checkPassword(req, res, (req.body || {}).password)) return;
  if (!verifySecondFactor(req.user.id, (req.body || {}).code)) return res.status(400).json({ error: 'That code is not correct.' });
  tx(() => {
    db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last_step = 0 WHERE id = ?').run(req.user.id);
    db.prepare('DELETE FROM totp_backup WHERE user_id = ?').run(req.user.id);
  });
  S.audit(req, '2fa_disabled');
  res.json({ ok: true });
}));

// ---------- Security audit log (newest first) ----------
router.get('/audit', (req, res) => {
  const rows = db.prepare('SELECT ts, username, action, detail, ip FROM audit_log ORDER BY id DESC LIMIT 200').all();
  res.json({ entries: rows.map(r => ({ time: new Date(r.ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
    user: r.username || '-', action: r.action, detail: r.detail, ip: r.ip || '-' })) });
});

module.exports = router;
