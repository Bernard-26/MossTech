'use strict';
// On the very first start, copy the products written in public/product.html into the database.
const fs = require('fs');
const { db } = require('./db');
const { DEFAULT_DEALS } = require('./pricing');

const DEFAULT_STOCK = 10;
const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function seedProductsFromHtml(file) {
  if (db.prepare('SELECT COUNT(*) AS n FROM products').get().n > 0) return 0;
  if (!fs.existsSync(file)) return 0;
  const html = fs.readFileSync(file, 'utf8');
  const re = /<div class="product"([^>]*)>([\s\S]*?)<\/div>/g;
  const insert = db.prepare(
    'INSERT OR IGNORE INTO products(id, name, price, stock, image_url, category, brand, discount_percent) VALUES(?,?,?,?,?,?,?,?)');
  let count = 0, m;
  while ((m = re.exec(html))) {
    const attrs = m[1], body = m[2];
    const img = (body.match(/<img[^>]*src="([^"]+)"/) || [])[1] || '';
    const id = Number((img.match(/(\d+)\.\w+$/) || [])[1]);
    const name = decode(((body.match(/<h3>([\s\S]*?)<\/h3>/) || [])[1] || '').trim());
    const price = parseFloat(((body.match(/class="price">([^<]*)</) || [])[1] || '').replace(/[^\d.]/g, ''));
    const category = ((attrs.match(/data-category="([^"]*)"/) || [])[1] || 'other').toLowerCase();
    const brand = ((attrs.match(/data-brand="([^"]*)"/) || [])[1] || '').toLowerCase();
    if (!id || !name || !Number.isFinite(price)) continue;
    insert.run(id, name, price, DEFAULT_STOCK, img, category, brand, DEFAULT_DEALS[id] || 0);
    count++;
  }
  return count;
}
module.exports = { seedProductsFromHtml };
