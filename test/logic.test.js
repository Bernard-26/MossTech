process.env.NODE_ENV = 'development';
const { resetDatabase } = require('./helpers');
const assert = require('assert');
const PRODUCT_HTML = require('path').join(__dirname, '..', 'public', 'product.html');
const { db, tx, getSetting, setSetting, close } = require('../server/db');
const { migrate } = require('../server/migrate');
const S = require('../server/security');
const svc = require('../server/services');
const { seedProductsFromHtml } = require('../server/seed');
const { salePrice, DEFAULT_DEALS } = require('../server/pricing');

(async () => {
  await resetDatabase();
  // migrations are idempotent
  assert.equal(await migrate(), 0, 'second migrate run applies nothing');
  assert.equal((await db.one('SELECT COUNT(*) AS n FROM schema_migrations')).n, 1);
  // settings
  await setSetting('k', 'v1'); await setSetting('k', 'v2'); assert.equal(await getSetting('k'), 'v2'); assert.equal(await getSetting('nope', 'fb'), 'fb');
  // seed
  const n = await seedProductsFromHtml(PRODUCT_HTML);
  console.log('seeded', n, await db.all('SELECT id,name,price,category,brand FROM products WHERE id IN (1,11,25)'));
  assert(n > 0); assert.equal(await seedProductsFromHtml(PRODUCT_HTML), 0);
  // the id counter was moved past the seeded ids, so a new product does not collide
  const maxSeed = (await db.one('SELECT MAX(id) AS m FROM products')).m;
  const fresh = await db.one("INSERT INTO products(name, price, stock) VALUES('Fresh', 1, 1) RETURNING id");
  assert.equal(fresh.id, maxSeed + 1, 'sequence continues after seeded ids'); await db.run('DELETE FROM products WHERE id = $1', [fresh.id]);
  // hashing
  const h = await S.hashSecret('Abc#1234'); assert(await S.verifySecret('Abc#1234', h)); assert(!await S.verifySecret('wrong', h)); assert(!await S.verifySecret('x', null));
  // validators
  assert.deepEqual(S.passwordProblems('Abc#1234'), []); assert(S.passwordProblems('abc').length > 2);
  assert.equal(S.cleanImageUrl('javascript:alert(1)'), null); assert.equal(S.cleanImageUrl('../x.jpg'), null); assert.equal(S.cleanImageUrl('pics/a.jpg'), 'pics/a.jpg'); assert.equal(S.cleanImageUrl('data:image/png;base64,AA'), null);
  // numbers come back as JS numbers, not strings
  assert.equal(typeof (await db.one('SELECT price FROM products WHERE id = 1')).price, 'number');
  // orders: price from DB, stock deducted, tampering ignored
  const good = { name: 'Juan Dela Cruz', email: 'Juan@Example.com', phone: '09171234567', address: '123 Rizal Street, Manila', payment: 'GCash', items: [{ id: 1, quantity: 2 }, { id: 1, quantity: 1 }, { id: 11, quantity: 1, price: 1 }] };
  const num = await svc.createOrder(good, null); console.log('order', num);
  const o = await db.one('SELECT * FROM orders WHERE order_number = $1', [num]);
  const p1 = (await db.one('SELECT price FROM products WHERE id = 1')).price;
  const d11 = await db.one('SELECT price, discount_percent FROM products WHERE id = 11');
  assert.equal(d11.discount_percent, 15, 'Infinix starts on sale');
  assert.equal(o.total_amount, Math.round((p1 * 3 + salePrice(d11.price, d11.discount_percent)) * 100) / 100, 'discounted price charged');
  assert.equal((await db.one('SELECT stock FROM products WHERE id = 1')).stock, 7);
  // overselling blocked + rolled back (product 1 is decremented first, then 11 fails => 1 must be restored)
  await assert.rejects(svc.createOrder({ ...good, items: [{ id: 1, quantity: 1 }, { id: 11, quantity: 50 }] }, null), (e) => e.status === 409);
  assert.equal((await db.one('SELECT stock FROM products WHERE id = 1')).stock, 7, 'rollback keeps stock');
  assert.equal((await db.one('SELECT stock FROM products WHERE id = 11')).stock, 9);
  await assert.rejects(svc.createOrder({ ...good, items: [{ id: 9999, quantity: 1 }] }, null), (e) => e.status === 400);
  await assert.rejects(svc.createOrder({ ...good, items: [{ id: 1, quantity: -5 }] }, null), (e) => e.status === 400);
  await assert.rejects(svc.createOrder({ ...good, items: [{ id: 1e20, quantity: 1 }] }, null), (e) => e.status === 400);
  await assert.rejects(svc.createOrder({ ...good, payment: 'Bitcoin' }, null), (e) => e.status === 400);
  // concurrent orders for the last items never oversell
  await db.run('UPDATE products SET stock = 3 WHERE id = 2');
  const race = await Promise.allSettled(Array.from({ length: 6 }, () => svc.createOrder({ ...good, items: [{ id: 2, quantity: 1 }] }, null)));
  assert.equal(race.filter((r) => r.status === 'fulfilled').length, 3, 'exactly 3 of 6 parallel orders succeed');
  assert.equal((await db.one('SELECT stock FROM products WHERE id = 2')).stock, 0);
  // tracking needs both
  assert(await svc.trackOrder(num, 'juan@example.com')); assert.equal(await svc.trackOrder(num, 'other@example.com'), null);
  console.log((await svc.trackOrder(num, 'juan@example.com')).customer_name);
  // sessions + roles
  await db.run("INSERT INTO users(username,email,role,pw_hash) VALUES('bob','bob@x.com','user',$1)", [h]);
  const uid = (await db.one("SELECT id FROM users WHERE username = 'BOB'")).id; // case-insensitive (citext)
  await assert.rejects(db.run("INSERT INTO users(username,email,role,pw_hash) VALUES('Bob','b2@x.com','user',$1)", [h]), (e) => e.code === '23505', 'usernames are unique ignoring case');
  let cookie; const res = { cookie: (n, v) => { cookie = n + '=' + v; } };
  await S.createSession(res, uid);
  const load = (req) => new Promise((resolve, reject) => S.loadUser(req, {}, (e) => e ? reject(e) : resolve(req)));
  const req = await load({ headers: { cookie } }); assert.equal(req.user.username, 'bob');
  const r2 = { status(c) { this.c = c; return this; }, json(b) { this.b = b; } }; S.requireAdmin(req, r2, () => assert.fail('user passed admin gate')); assert.equal(r2.c, 403);
  assert.equal((await load({ headers: { cookie: 'mt_sid=forged' } })).user, null);
  await db.run('UPDATE sessions SET last_seen = $1', [Date.now() - 3 * 3600 * 1000]);
  assert.equal((await load({ headers: { cookie } })).user, null, 'idle expiry');
  // csrf
  const mk = (hd, m = 'POST') => ({ method: m, get: (k) => hd[k] }); let pass; const run = (rq) => { const r = { status(c) { this.c = c; return this; }, json() {} }; pass = false; S.csrfGuard(rq, r, () => pass = true); return pass; };
  assert(!run(mk({}))); assert(run(mk({ 'X-Requested-With': 'mosstech', Host: 'a.com', Origin: 'http://a.com' }))); assert(!run(mk({ 'X-Requested-With': 'mosstech', Host: 'a.com', Origin: 'http://evil.com' }))); assert(run(mk({}, 'GET')));
  // lockout (also when the guesses arrive in parallel)
  for (let i = 0; i < 5; i++) await S.registerFail('k'); assert((await S.lockRemaining('k')) > 0);
  await Promise.all(Array.from({ length: 5 }, () => S.registerFail('par'))); assert((await S.lockRemaining('par')) > 0, 'parallel failures still lock');
  // rate limit
  const rl = S.rateLimit({ windowMs: 1000, max: 2 }); let blocked = 0; for (let i = 0; i < 4; i++) rl({ ip: '1' }, { set() {}, status() { blocked++; return { json() {} }; } }, () => {}); assert.equal(blocked, 2);

  // ---- Discounts ----
  assert.equal(salePrice(11550, 10), 10395); assert.equal(salePrice(8999, 15), 7649.15); assert.equal(salePrice(1000, 0), 1000);
  const deals = Object.fromEntries((await db.all('SELECT id, discount_percent AS d FROM products WHERE discount_percent > 0 ORDER BY id')).map((r) => [r.id, r.d]));
  assert.deepEqual(deals, DEFAULT_DEALS);
  const oItem = await db.one('SELECT price FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.order_number = $1 AND oi.product_id = 11', [num]);
  assert.equal(oItem.price, salePrice(d11.price, 15), 'order item keeps the price actually paid');
  await db.run('UPDATE products SET discount_percent = 50 WHERE id = 1');
  const n2 = await svc.createOrder({ ...good, items: [{ id: 1, quantity: 1 }] }, null);
  assert.equal((await db.one('SELECT total_amount FROM orders WHERE order_number = $1', [n2])).total_amount, p1 / 2, 'admin-set discount applies');
  await assert.rejects(db.run('UPDATE products SET discount_percent = 95 WHERE id = 1'), 'database rejects discounts above 90');
  // ---- TOTP (RFC 6238 test vector: secret "12345678901234567890", time 59s -> ...287082) ----
  const totp = require('../server/totp'); const { verifySecondFactor } = require('../server/twofactor');
  const rfcSecret = totp.base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(rfcSecret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(totp.hotp(totp.base32Decode(rfcSecret), 1), '287082');
  assert.deepEqual([...totp.base32Decode(totp.base32Encode(Buffer.from('hello world')))], [...Buffer.from('hello world')]);
  const now = 59000; const st = totp.verify(rfcSecret, '287082', 0, now); assert.equal(st, 1);
  assert.equal(totp.verify(rfcSecret, '287082', st, now), 0, 'same code cannot be reused');
  assert.equal(totp.verify(rfcSecret, '000000', 0, now), 0); assert.equal(totp.verify(rfcSecret, 'abcdef', 0, now), 0);
  assert(totp.otpauthUri(totp.generateSecret(), 'a@x.com').startsWith('otpauth://totp/MOSSTECH%3Aa%40x.com?secret='));
  // second factor + backup codes against the database
  const secret = totp.generateSecret(); await db.run('UPDATE users SET totp_secret = $1, totp_enabled = 1, totp_last_step = 0 WHERE id = $2', [secret, uid]);
  const cur = totp.hotp(totp.base32Decode(secret), Math.floor(Date.now() / 30000));
  assert(await verifySecondFactor(uid, cur)); assert(!await verifySecondFactor(uid, cur), 'replay blocked'); assert(!await verifySecondFactor(uid, '123456'));
  await db.run('INSERT INTO totp_backup(user_id, code_hash) VALUES($1,$2)', [uid, S.sha256('a1b2c3d4')]);
  assert(await verifySecondFactor(uid, 'A1B2-C3D4'), 'backup code works'); assert(!await verifySecondFactor(uid, 'a1b2c3d4'), 'backup code is single-use');
  // transactions roll back
  await assert.rejects(tx(async (t) => { await t.run("INSERT INTO settings(key,value) VALUES('tx_test','1')"); throw new Error('boom'); }));
  assert.equal(await getSetting('tx_test'), null, 'rolled back');
  // mailer falls back to console when SMTP is not configured
  const mailer = require('../server/mailer'); assert.equal(await mailer.sendMail({ to: 'x@y.com', subject: 't', text: 'code 123456' }), false);
  // Brevo API mode (fetch is mocked)
  assert.deepEqual(mailer.parseFrom.call(null), { name: 'MOSSTECH', email: '' });
  process.env.MAIL_FROM = 'MOSSTECH Store <shop@example.com>'; assert.deepEqual(mailer.parseFrom(), { name: 'MOSSTECH Store', email: 'shop@example.com' });
  process.env.BREVO_API_KEY = 'k'; let sent; global.fetch = async (url, op) => { sent = { url, op }; return { ok: true }; };
  assert.equal(await mailer.sendMail({ to: 'c@x.com', subject: 's', text: 't' }), true);
  assert.equal(sent.url, 'https://api.brevo.com/v3/smtp/email'); assert.equal(sent.op.headers['api-key'], 'k');
  assert.equal(JSON.parse(sent.op.body).to[0].email, 'c@x.com'); assert.equal(JSON.parse(sent.op.body).sender.email, 'shop@example.com');
  global.fetch = async () => ({ ok: false, status: 401, text: async () => 'bad key' }); assert.equal(await mailer.sendMail({ to: 'c@x.com', subject: 's', text: 't' }), false);
  delete process.env.BREVO_API_KEY; delete process.env.MAIL_FROM;
  console.log('ALL TESTS PASSED'); await close(); process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
