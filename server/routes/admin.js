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

// Valid PostgreSQL INTEGER id from a URL segment (an out-of-range number would otherwise be a database error)
const asId = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 2147483647 ? n : null; };

router.get('/backup', S.ah(async (req, res) => {   // admin-only: fresh pg_dump of the database (custom format, restore with pg_restore)
  let file;
  try { file = await require('../backup').backupNow(); }
  catch (e) {
    if (e.code === 'NO_PG_DUMP') return res.status(501).json({ error: 'pg_dump is not available in this container. Back up from the host instead (see DOCKER.md).' });
    throw e;
  }
  const name = require('path').basename(file);
  await S.audit(req, 'backup_downloaded', name);
  res.set('Cache-Control', 'no-store');
  res.download(file, name);
}));

router.get('/summary', S.ah(async (req, res) => {
  res.json({
    users: (await db.one('SELECT COUNT(*) AS n FROM users')).n,
    orders: (await db.one('SELECT COUNT(*) AS n FROM orders')).n
  });
}));

router.get('/users', S.ah(async (req, res) => {
  const users = (await db.all('SELECT username, email, role FROM users ORDER BY id'))
    .map(u => ({ username: u.username, email: S.maskEmail(u.email), role: u.role }));
  res.json({ users });
}));

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
router.post('/products', S.ah(async (req, res) => {
  const p = readProduct(req.body || {}, res); if (!p) return;
  const { id } = await db.one(
    'INSERT INTO products(name, price, stock, image_url, category, brand, discount_percent) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',
    [p.name, p.price, p.stock, p.image_url, p.category, p.brand, p.discount_percent]);
  await S.audit(req, 'product_created', `#${id} ${p.name}`);
  res.status(201).json({ id });
}));
router.put('/products/:id', S.ah(async (req, res) => {
  const id = asId(req.params.id);
  if (!id || !await db.one('SELECT 1 FROM products WHERE id = $1', [id])) return res.status(404).json({ error: 'Product not found.' });
  const p = readProduct(req.body || {}, res); if (!p) return;
  await db.run('UPDATE products SET name=$1, price=$2, stock=$3, image_url=$4, category=$5, brand=$6, discount_percent=$7 WHERE id=$8',
    [p.name, p.price, p.stock, p.image_url, p.category, p.brand, p.discount_percent, id]);
  await S.audit(req, 'product_updated', `#${id} ${p.name}`);
  res.json({ ok: true });
}));
router.delete('/products/:id', S.ah(async (req, res) => {
  const id = asId(req.params.id);
  const r = id ? await db.run('DELETE FROM products WHERE id = $1', [id]) : { rowCount: 0 };
  if (!r.rowCount) return res.status(404).json({ error: 'Product not found.' });
  await S.audit(req, 'product_deleted', `#${id}`);
  res.json({ ok: true });
}));

// ---------- Orders ----------
router.get('/orders', S.ah(async (req, res) => {
  const rows = await db.all('SELECT * FROM orders ORDER BY id DESC');
  const orders = await Promise.all(rows.map(async (o) => ({
    order_number: o.order_number, customer_name: o.customer_name, customer_email: S.maskEmail(o.customer_email),
    payment_method: o.payment_method, total_amount: o.total_amount, order_date: o.order_date,
    status: o.status, items: await svc.itemsFor(o.id)
  })));
  res.json({ orders });
}));
router.patch('/orders/:number/status', S.ah(async (req, res) => {
  const status = String((req.body || {}).status || '');
  if (!svc.ORDER_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status selected.' });
  const r = await db.run('UPDATE orders SET status = $1 WHERE order_number = $2', [status, req.params.number]);
  if (!r.rowCount) return res.status(404).json({ error: 'Order not found.' });
  await S.audit(req, 'order_status_changed', `${req.params.number} -> ${status}`);
  res.json({ ok: true });
}));
router.delete('/orders/:number', S.ah(async (req, res) => {
  const r = await db.run('DELETE FROM orders WHERE order_number = $1', [req.params.number]);
  if (!r.rowCount) return res.status(404).json({ error: 'Order not found.' });
  await S.audit(req, 'order_deleted', req.params.number);
  res.json({ ok: true });
}));

// ---------- Settings ----------
const DEFAULT_SETTINGS = { storeName: 'MOSSTECH', supportEmail: 'support@mosstech.com', shippingFee: 59 };
router.get('/settings', S.ah(async (req, res) => {
  let saved = {};
  try { saved = JSON.parse(await getSetting('store_settings', '{}')); } catch { /* ignore */ }
  res.json({ settings: { ...DEFAULT_SETTINGS, ...saved } });
}));
router.put('/settings', S.ah(async (req, res) => {
  const b = req.body || {};
  const storeName = S.cleanText(b.storeName, 80);
  const supportEmail = String(b.supportEmail || '').trim().toLowerCase();
  const shippingFee = Number(b.shippingFee);
  if (storeName.length < 2) return res.status(400).json({ error: 'Store name must be at least 2 characters.' });
  if (!S.isValidEmail(supportEmail)) return res.status(400).json({ error: 'Enter a valid support email.' });
  if (!Number.isFinite(shippingFee) || shippingFee < 0 || shippingFee > 100000) return res.status(400).json({ error: 'Enter a valid shipping fee.' });
  await setSetting('store_settings', JSON.stringify({ storeName, supportEmail, shippingFee }));
  await S.audit(req, 'store_settings_changed');
  res.json({ ok: true });
}));

// ---------- Admin passkey (needs the admin's own password too) ----------
router.put('/passkey', S.ah(async (req, res) => {
  const { currentPassword, newPasskey } = req.body || {};
  const me = await db.one('SELECT pw_hash FROM users WHERE id = $1', [req.user.id]);
  const wait = await S.lockRemaining('pk:' + req.user.id);
  if (wait) return res.status(429).json({ error: `Too many failed attempts. Try again in ${wait}s.` });
  if (!await S.verifySecret(String(currentPassword || ''), me && me.pw_hash)) {
    await S.registerFail('pk:' + req.user.id);
    return res.status(403).json({ error: 'Your current password is incorrect.' });
  }
  const issues = S.passkeyProblems(String(newPasskey || ''));
  if (issues.length) return res.status(400).json({ error: 'Passkey needs: ' + issues.join(', ') + '.' });
  await setSetting('admin_passkey_hash', await S.hashSecret(String(newPasskey)));
  await S.audit(req, 'admin_passkey_changed');
  res.json({ ok: true });
}));

// ---------- Two-factor authentication (authenticator app) ----------
async function checkPassword(req, res, pw) {
  const wait = await S.lockRemaining('pk:' + req.user.id);
  if (wait) { res.status(429).json({ error: `Too many failed attempts. Try again in ${wait}s.` }); return false; }
  const me = await db.one('SELECT pw_hash FROM users WHERE id = $1', [req.user.id]);
  if (!await S.verifySecret(String(pw || ''), me && me.pw_hash)) {
    await S.registerFail('pk:' + req.user.id);
    res.status(403).json({ error: 'Your current password is incorrect.' });
    return false;
  }
  await S.clearFails('pk:' + req.user.id);
  return true;
}

router.get('/2fa/status', S.ah(async (req, res) => {
  const u = await db.one('SELECT totp_enabled FROM users WHERE id = $1', [req.user.id]);
  const left = (await db.one('SELECT COUNT(*) AS n FROM totp_backup WHERE user_id = $1 AND used = 0', [req.user.id])).n;
  res.json({ enabled: Boolean(u.totp_enabled), backupLeft: left, required: S.REQUIRE_ADMIN_2FA });
}));

router.post('/2fa/setup', S.ah(async (req, res) => {
  if (!await checkPassword(req, res, (req.body || {}).password)) return;
  if ((await db.one('SELECT totp_enabled FROM users WHERE id = $1', [req.user.id])).totp_enabled) {
    return res.status(400).json({ error: 'Two-factor is already enabled.' });
  }
  const secret = totp.generateSecret();
  await db.run('UPDATE users SET totp_secret = $1, totp_enabled = 0, totp_last_step = 0 WHERE id = $2', [secret, req.user.id]);
  const uri = totp.otpauthUri(secret, req.user.email);
  let qr = null;
  if (QRCode) { try { qr = await QRCode.toDataURL(uri, { margin: 1, width: 220 }); } catch (e) { /* show the key instead */ } }
  res.json({ secret, qr });
}));

router.post('/2fa/enable', S.ah(async (req, res) => {
  const u = await db.one('SELECT totp_secret, totp_enabled FROM users WHERE id = $1', [req.user.id]);
  if (!u.totp_secret || u.totp_enabled) return res.status(400).json({ error: 'Start the setup first.' });
  const wait = await S.lockRemaining('2fa-setup:' + req.user.id);
  if (wait) return res.status(429).json({ error: `Too many failed attempts. Try again in ${wait}s.` });
  const step = totp.verify(u.totp_secret, String((req.body || {}).code || '').replace(/\s/g, ''), 0);
  if (!step) { await S.registerFail('2fa-setup:' + req.user.id); return res.status(400).json({ error: 'That code is not correct. Check the time on your phone and try again.' }); }

  const codes = Array.from({ length: 8 }, () => crypto.randomBytes(4).toString('hex'));
  await tx(async (t) => {
    await t.run('UPDATE users SET totp_enabled = 1, totp_last_step = $1 WHERE id = $2', [step, req.user.id]);
    await t.run('DELETE FROM totp_backup WHERE user_id = $1', [req.user.id]);
    for (const c of codes) await t.run('INSERT INTO totp_backup(user_id, code_hash) VALUES($1,$2)', [req.user.id, S.sha256(c)]);
  });
  await S.clearFails('2fa-setup:' + req.user.id);
  await S.audit(req, '2fa_enabled');
  res.json({ ok: true, backupCodes: codes.map(c => c.slice(0, 4) + '-' + c.slice(4)) }); // shown only once
}));

router.post('/2fa/disable', S.ah(async (req, res) => {
  if (!await checkPassword(req, res, (req.body || {}).password)) return;
  if (!await verifySecondFactor(req.user.id, (req.body || {}).code)) return res.status(400).json({ error: 'That code is not correct.' });
  await tx(async (t) => {
    await t.run('UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last_step = 0 WHERE id = $1', [req.user.id]);
    await t.run('DELETE FROM totp_backup WHERE user_id = $1', [req.user.id]);
  });
  await S.audit(req, '2fa_disabled');
  res.json({ ok: true });
}));

// ---------- Security audit log (newest first) ----------
router.get('/audit', S.ah(async (req, res) => {
  const rows = await db.all('SELECT ts, username, action, detail, ip FROM audit_log ORDER BY id DESC LIMIT 200');
  res.json({ entries: rows.map(r => ({ time: new Date(r.ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
    user: r.username || '-', action: r.action, detail: r.detail, ip: r.ip || '-' })) });
}));

module.exports = router;
