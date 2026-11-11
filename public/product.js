/* =====================================================
   MOSSTECH Products - product.js
   Prices, names and stock come from the server (SQLite).
   The cart in localStorage only remembers { id, quantity } - prices are
   always re-checked by the server when the order is placed.
   ===================================================== */
'use strict';

const CART_KEY = 'cart';
const MAX_QTY_PER_ITEM = 99;
let catalog = [];

// ---------- Cart storage (ids + quantities only) ----------
function getCart() {
  try {
    const c = JSON.parse(localStorage.getItem(CART_KEY));
    return Array.isArray(c) ? c : [];
  } catch (e) { return []; }
}
function saveCart(cart) { localStorage.setItem(CART_KEY, JSON.stringify(cart.map(i => ({ id: i.id, quantity: i.quantity })))); }
function idFromImage(src) { const m = String(src || '').match(/(\d+)\.\w+$/); return m ? Number(m[1]) : null; }

// ---------- Toast ----------
let toastTimer = null;
function toast(message, isError) {
  let t = document.getElementById('mt-toast');
  if (!t) {
    t = el('div', { id: 'mt-toast', style:
      'position:fixed;bottom:25px;left:50%;transform:translateX(-50%);padding:12px 20px;border-radius:6px;' +
      'color:#fff;font-size:.95rem;z-index:9999;box-shadow:0 4px 14px rgba(0,0,0,.3);transition:opacity .2s;' });
    document.body.appendChild(t);
  }
  t.style.background = isError ? '#d32f2f' : '#2e7d32';
  t.textContent = message;
  t.style.opacity = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.style.opacity = '0'; }, 2200);
}

// ---------- Sync the page with the server catalog ----------
// Shows the sale price, the old price crossed out, and a red "-15%" tag when a discount is set
function setPriceDisplay(priceEl, p) {
  priceEl.textContent = '';
  const d = Number(p.discount_percent) || 0;
  if (d > 0) {
    priceEl.appendChild(el('span', { text: peso(p.sale_price, 0), style: 'font-weight:bold;' }));
    priceEl.appendChild(document.createTextNode(' '));
    priceEl.appendChild(el('s', { text: peso(p.price, 0), style: 'color:var(--text-muted);font-size:.85em;' }));
    priceEl.appendChild(el('span', { text: '-' + d + '%', style: 'background:#d32f2f;color:#fff;border-radius:4px;padding:1px 6px;font-size:.75em;margin-left:6px;' }));
  } else {
    priceEl.textContent = peso(p.price, 0);
  }
}

function applyProductToCard(card, p) {
  const h3 = card.querySelector('h3');
  const price = card.querySelector('.price');
  const img = card.querySelector('img');
  if (h3) h3.textContent = String(p.name || '');
  if (price) setPriceDisplay(price, p);
  if (img && p.image_url) img.setAttribute('src', safeImageUrl(p.image_url));

  const stock = Number(p.stock);
  const out = Number.isFinite(stock) && stock <= 0;
  card.querySelectorAll('.buy-btn, .cart-btn').forEach(b => {
    b.disabled = out;
    b.style.opacity = out ? '.5' : '';
    b.style.cursor = out ? 'not-allowed' : '';
  });
  let tag = card.querySelector('.stock-tag');
  if (!tag) { tag = el('p', { class: 'stock-tag', style: 'font-size:.85rem;margin:4px 0;' }); (price || card).after(tag); }
  if (out) { tag.textContent = 'Out of stock'; tag.style.color = '#d32f2f'; }
  else if (Number.isFinite(stock) && stock <= 5) { tag.textContent = 'Only ' + stock + ' left'; tag.style.color = '#e65100'; }
  else tag.textContent = '';
}

async function syncCatalog() {
  const grid = document.querySelector('.product-grid');
  const cards = Array.from(grid.querySelectorAll('.product'));

  const r = await api('GET', '/api/products');
  if (!r.ok) {
    toast(r.data.error || 'Could not load products from the server.', true);
    cards.forEach(c => c.querySelectorAll('.buy-btn, .cart-btn').forEach(b => { b.disabled = true; }));
    return;
  }
  catalog = r.data.products;

  cards.forEach(card => {
    const id = idFromImage(card.querySelector('img')?.getAttribute('src'));
    card.dataset.category = String(card.dataset.category || '').toLowerCase();
    card.dataset.brand = String(card.dataset.brand || '').toLowerCase();
    const p = catalog.find(x => Number(x.id) === id);
    if (!p) { card.style.display = 'none'; card.dataset.removed = '1'; return; }  // deleted by the admin
    card.dataset.id = String(p.id);
    applyProductToCard(card, p);
  });

  // Products the admin added that are not written in the HTML
  catalog.forEach(p => {
    if (grid.querySelector(`.product[data-id="${p.id}"]`)) return;
    const card = el('div', { class: 'product', 'data-id': String(p.id),
      'data-category': String(p.category || 'other').toLowerCase(), 'data-brand': String(p.brand || '').toLowerCase() }, [
      el('img', { src: safeImageUrl(p.image_url), alt: String(p.name || '') }),
      el('h3', { text: String(p.name || '') }),
      el('p', { class: 'price', text: peso(p.price, 0) }),
      el('ul', { class: 'specs hidden' }, [
        el('li', { text: 'Category: ' + (p.category || 'N/A') }),
        el('li', { text: 'Brand: ' + (p.brand || 'N/A') }),
        el('li', { text: 'In Stock: ' + p.stock })
      ]),
      el('button', { class: 'buy-btn', text: 'Buy Now' }),
      el('button', { class: 'cart-btn', text: 'Add to Cart' })
    ]);
    applyProductToCard(card, p);
    grid.appendChild(card);
  });
}

// ---------- Cart actions ----------
function updateCartBadge() {
  const link = document.querySelector('a[href="cart.html"]');
  if (!link) return;
  const count = getCart().reduce((s, i) => s + (Number(i.quantity) || 0), 0);
  let badge = link.querySelector('.cart-badge');
  if (!badge) {
    badge = el('span', { class: 'cart-badge',
      style: 'background:#d32f2f;color:#fff;border-radius:10px;padding:1px 6px;font-size:.7rem;margin-left:4px;vertical-align:top;' });
    link.appendChild(badge);
  }
  badge.textContent = String(count);
  badge.style.display = count > 0 ? 'inline-block' : 'none';
}

function addToCart(productId) {
  const product = catalog.find(p => String(p.id) === String(productId));
  if (!product) { toast('This product is no longer available.', true); return false; }
  const maxAllowed = Math.min(Number(product.stock) || 0, MAX_QTY_PER_ITEM);
  if (maxAllowed <= 0) { toast('Sorry, this item is out of stock.', true); return false; }

  const cart = getCart();
  const line = cart.find(i => String(i.id) === String(product.id));
  const currentQty = line ? Number(line.quantity) || 0 : 0;
  if (currentQty + 1 > maxAllowed) { toast('You already have the maximum available (' + maxAllowed + ') in your cart.', true); return false; }

  if (line) line.quantity = currentQty + 1;
  else cart.push({ id: product.id, quantity: 1 });
  saveCart(cart);
  updateCartBadge();
  return true;
}

// ---------- Filtering / search ----------
function applyFilters() {
  const query = (document.getElementById('searchBar')?.value || '').trim().toLowerCase().slice(0, 80);
  const params = new URLSearchParams(window.location.search);
  const categoryFilter = (params.get('category') || '').trim().toLowerCase();
  const brandFilter = (params.get('brand') || '').trim().toLowerCase();

  let visible = 0;
  document.querySelectorAll('.product-grid .product').forEach(card => {
    if (card.dataset.removed === '1') return;
    const hay = (card.textContent + ' ' + card.dataset.brand + ' ' + card.dataset.category).toLowerCase();
    const match = (!query || hay.includes(query)) &&
      (!categoryFilter || card.dataset.category === categoryFilter) &&
      (!brandFilter || card.dataset.brand.includes(brandFilter));
    card.style.display = match ? '' : 'none';
    if (match) visible++;
  });
  let msg = document.getElementById('no-results');
  if (!msg) {
    msg = el('p', { id: 'no-results', text: 'No products found.', style: 'text-align:center;margin:30px 0;font-size:18px;color:#666;display:none;' });
    document.querySelector('.product-grid').after(msg);
  }
  msg.style.display = visible === 0 ? 'block' : 'none';
}

// ---------- Init ----------
window.addEventListener('DOMContentLoaded', async () => {
  document.querySelectorAll('.product .specs').forEach(s => s.classList.add('hidden'));
  updateCartBadge();

  const grid = document.querySelector('.product-grid');
  grid.addEventListener('click', (e) => {
    const card = e.target.closest('.product');
    if (!card) return;
    if (e.target.closest('.cart-btn')) { if (addToCart(card.dataset.id)) toast('Added to cart!'); return; }
    if (e.target.closest('.buy-btn')) { if (addToCart(card.dataset.id)) window.location.href = 'cart.html'; return; }
    card.classList.toggle('open');   // product.css shows the specs (and turns the arrow) when the card is .open
  });
  // Links like product.html?q=Redmi%20Note%2015 (used by the home page deals) pre-fill the search box
  const q = new URLSearchParams(window.location.search).get('q');
  const searchBox = document.getElementById('searchBar');
  if (q && searchBox) searchBox.value = q.slice(0, 80);
  searchBox?.addEventListener('input', applyFilters);
  window.addEventListener('storage', (e) => { if (e.key === CART_KEY) updateCartBadge(); });

  await syncCatalog();
  applyFilters();
});
