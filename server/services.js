'use strict';
// Order business rules. Prices and stock ALWAYS come from the database, never from the browser.
const crypto = require('crypto');
const { db, tx } = require('./db');
const S = require('./security');
const { salePrice } = require('./pricing');

const ORDER_STATUSES = ['Processing', 'Shipped', 'Out for Delivery', 'Delivered'];
const PAYMENT_METHODS = ['Cash on Delivery', 'GCash', 'Credit Card'];
const MAX_QTY = 99;

function newOrderNumber() {
  const d = new Date();
  const date = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  return `MT-${date}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

async function createOrder(input, userId) {
  const b = input || {};
  const name = S.cleanText(b.name, 80);
  const email = S.cleanText(b.email, 120).toLowerCase();
  const phone = S.cleanText(b.phone, 20);
  const address = S.cleanText(b.address, 250);
  const payment = String(b.payment || '');

  if (!S.isValidName(name)) throw new S.HttpError(400, 'Please enter a valid full name.');
  if (!S.isValidEmail(email)) throw new S.HttpError(400, 'Please enter a valid email address.');
  if (!S.isValidPhone(phone)) throw new S.HttpError(400, 'Please enter a valid phone number.');
  if (address.length < 10) throw new S.HttpError(400, 'Please enter a complete delivery address.');
  if (!PAYMENT_METHODS.includes(payment)) throw new S.HttpError(400, 'Please select a valid payment method.');
  if (!Array.isArray(b.items) || b.items.length === 0 || b.items.length > 50) throw new S.HttpError(400, 'Your cart is empty.');

  // Merge duplicate lines and validate ids / quantities
  const wanted = new Map();
  for (const it of b.items) {
    const id = Number(it && it.id), qty = Number(it && it.quantity);
    if (!Number.isInteger(id) || id < 1 || id > 2147483647 || !Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) throw new S.HttpError(400, 'Invalid cart contents.');
    wanted.set(id, Math.min((wanted.get(id) || 0) + qty, MAX_QTY));
  }

  // Lock products in a fixed (ascending id) order so two customers buying the same items at the same moment
  // cannot deadlock each other.
  const ids = [...wanted.keys()].sort((a, b) => a - b);
  return tx(async (t) => {
    let total = 0;
    const lines = [];
    for (const id of ids) {
      const qty = wanted.get(id);
      const p = await t.one('SELECT id, name, price, stock, discount_percent FROM products WHERE id = $1', [id]);
      if (!p) throw new S.HttpError(400, 'A product in your cart is no longer available.');
      // Atomic stock check + decrement: the row is locked until the order commits, so no overselling.
      const upd = await t.run('UPDATE products SET stock = stock - $1 WHERE id = $2 AND stock >= $1', [qty, id]);
      if (upd.rowCount !== 1) throw new S.HttpError(409, `Not enough stock for "${p.name}".`);
      const unit = salePrice(p.price, p.discount_percent);   // the discounted price the customer really pays
      total += unit * qty;
      lines.push({ id: p.id, name: p.name, price: unit, qty });
    }
    let number = newOrderNumber();
    while (await t.one('SELECT 1 FROM orders WHERE order_number = $1', [number])) number = newOrderNumber();

    const order = await t.one(
      `INSERT INTO orders(order_number, user_id, customer_name, customer_email, customer_phone, customer_address,
                          payment_method, total_amount, order_date, status)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9, 'Processing') RETURNING id`,
      [number, userId || null, name, email, phone, address, payment,
       Math.round(total * 100) / 100, new Date().toISOString().slice(0, 10)]);
    for (const l of lines) {
      await t.run('INSERT INTO order_items(order_id, product_id, name, price, quantity) VALUES($1,$2,$3,$4,$5)',
        [order.id, l.id, l.name, l.price, l.qty]);
    }
    return number;
  });
}

function maskName(name) {
  const s = String(name || '').trim();
  return s ? s.split(/\s+/).map(w => w[0] + '*'.repeat(Math.max(w.length - 1, 1))).join(' ') : 'N/A';
}
async function itemsFor(orderId) {
  return (await db.all('SELECT name, price, quantity FROM order_items WHERE order_id = $1 ORDER BY id', [orderId]))
    .map(i => ({ name: i.name, price: i.price, quantity: i.quantity }));
}
// Customer lookup: order number AND email must both match
async function trackOrder(number, email) {
  const o = await db.one('SELECT * FROM orders WHERE order_number = $1 AND customer_email = $2', [number, email]);
  if (!o) return null;
  return {
    order_number: o.order_number, status: o.status, customer_name: maskName(o.customer_name),
    order_date: o.order_date, payment_method: o.payment_method, total_amount: o.total_amount, items: await itemsFor(o.id)
  };
}

// A logged-in customer's own orders (matched by account, never by email: emails are not verified)
async function listOrdersForUser(userId) {
  const orders = await db.all('SELECT * FROM orders WHERE user_id = $1 ORDER BY id DESC', [userId]);
  return Promise.all(orders.map(async (o) => ({
    order_number: o.order_number, status: o.status, order_date: o.order_date,
    payment_method: o.payment_method, total_amount: o.total_amount, items: await itemsFor(o.id)
  })));
}

module.exports = { ORDER_STATUSES, PAYMENT_METHODS, createOrder, trackOrder, itemsFor, listOrdersForUser };
