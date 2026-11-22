'use strict';
// On the very first start, copy the products written in public/product.html into the database.
const fs = require('fs');
const { db, tx } = require('./db');
const { DEFAULT_DEALS } = require('./pricing');

const DEFAULT_STOCK = 10;
const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

async function seedProductsFromHtml(file) {
  if ((await db.one('SELECT COUNT(*) AS n FROM products')).n > 0) return 0;
  if (!fs.existsSync(file)) return 0;
  const html = fs.readFileSync(file, 'utf8');
  const re = /<div class="product"([^>]*)>([\s\S]*?)<\/div>/g;
  const rows = [];
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1], body = m[2];
    const img = (body.match(/<img[^>]*src="([^"]+)"/) || [])[1] || '';
    const id = Number((img.match(/(\d+)\.\w+$/) || [])[1]);
    const name = decode(((body.match(/<h3>([\s\S]*?)<\/h3>/) || [])[1] || '').trim());
    const price = parseFloat(((body.match(/class="price">([^<]*)</) || [])[1] || '').replace(/[^\d.]/g, ''));
    const category = ((attrs.match(/data-category="([^"]*)"/) || [])[1] || 'other').toLowerCase();
    const brand = ((attrs.match(/data-brand="([^"]*)"/) || [])[1] || '').toLowerCase();
    if (!id || !name || !Number.isFinite(price)) continue;
    rows.push([id, name, price, DEFAULT_STOCK, img, category, brand, DEFAULT_DEALS[id] || 0]);
  }
  if (!rows.length) return 0;
  await tx(async (t) => {
    for (const r of rows) {
      await t.run(
        `INSERT INTO products(id, name, price, stock, image_url, category, brand, discount_percent)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`, r);
    }
    // The ids above were explicit, so move the id counter past them or the next admin-added product would collide.
    await t.run(`SELECT setval(pg_get_serial_sequence('products', 'id'), (SELECT MAX(id) FROM products))`);
  });
  return rows.length;
}
module.exports = { seedProductsFromHtml };
