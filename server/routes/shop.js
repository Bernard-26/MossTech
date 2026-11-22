'use strict';
const express = require('express');
const { db } = require('../db');
const S = require('../security');
const svc = require('../services');
const { salePrice } = require('../pricing');

const router = express.Router();
const orderLimit = S.rateLimit({ windowMs: 60 * 60 * 1000, max: 30, message: 'Too many orders from this network. Try again later.' });
const trackLimit = S.rateLimit({ windowMs: 60 * 1000, max: 20 });

router.get('/products', S.ah(async (req, res) => {
  const rows = await db.all('SELECT id, name, price, stock, image_url, category, brand, discount_percent FROM products ORDER BY id');
  res.json({ products: rows.map(p => ({ ...p, sale_price: salePrice(p.price, p.discount_percent) })) });
}));

router.post('/orders', orderLimit, S.ah(async (req, res) => {
  const order_number = await svc.createOrder(req.body, req.user && req.user.id);
  res.status(201).json({ order_number });
}));

router.get('/orders/mine', S.requireAuth, S.ah(async (req, res) => {
  res.json({ orders: await svc.listOrdersForUser(req.user.id) });
}));

router.post('/orders/track', trackLimit, S.ah(async (req, res) => {
  const key = 'track:' + req.ip;
  const wait = await S.lockRemaining(key);
  if (wait) return res.status(429).json({ error: `Too many attempts. Please try again in ${wait}s.` });

  const number = String((req.body || {}).orderNumber || '').trim().toUpperCase().replace(/[^A-Z0-9\-]/g, '').slice(0, 40);
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  if (!number) return res.status(400).json({ error: 'Please enter your order number.' });
  if (!S.isValidEmail(email)) return res.status(400).json({ error: 'Please enter the email used during purchase.' });

  const order = await svc.trackOrder(number, email);
  if (!order) {
    await S.registerFail(key);
    return res.status(404).json({ error: 'No order found with that order number and email. Please check and try again.' });
  }
  await S.clearFails(key);
  res.json({ order });
}));

module.exports = router;
