/* =====================================================
   MOSSTECH Cart & Checkout - cart.js
   The cart is only a list of { id, quantity } in localStorage.
   Prices shown here come from the server, and the server recalculates
   the total (and checks stock) again when the order is placed.
   ===================================================== */
'use strict';

const CART_KEY = 'cart';
const MAX_QTY_PER_ITEM = 99;
let catalog = [];
let isSubmitting = false;

function readCart() {
  try {
    const c = JSON.parse(localStorage.getItem(CART_KEY));
    return Array.isArray(c) ? c : [];
  } catch (e) { return []; }
}
function writeCart(lines) { localStorage.setItem(CART_KEY, JSON.stringify(lines.map(l => ({ id: l.id, quantity: l.quantity })))); }

// Cart lines joined with live catalog data; unavailable products are dropped
function getCart() {
  const lines = [];
  readCart().forEach(item => {
    const p = catalog.find(x => String(x.id) === String(item && item.id));
    if (!p) return;
    let qty = parseInt(item.quantity, 10);
    if (isNaN(qty) || qty < 1) qty = 1;
    qty = Math.min(qty, MAX_QTY_PER_ITEM, Math.max(Number(p.stock) || 0, 0));
    if (qty < 1) return;
    // price = what the customer pays now (after any discount); the server calculates it again at checkout
    lines.push({ id: p.id, name: p.name, price: Number(p.sale_price ?? p.price), discount: Number(p.discount_percent) || 0,
                 image_url: safeImageUrl(p.image_url), quantity: qty });
  });
  return lines;
}
const cartTotal = (cart) => cart.reduce((s, i) => s + i.price * i.quantity, 0);

function renderCart() {
  const cart = getCart();
  writeCart(cart);
  const tbody = document.getElementById('cart-items');
  const emptyMsg = document.getElementById('empty-cart-message');
  const table = document.querySelector('.cart-table');
  const summary = document.querySelector('.cart-summary');
  tbody.replaceChildren();

  const isEmpty = cart.length === 0;
  emptyMsg.style.display = isEmpty ? 'block' : 'none';
  if (table) table.style.display = isEmpty ? 'none' : '';
  if (summary) summary.style.display = isEmpty ? 'none' : '';

  cart.forEach((item, index) => {
    const img = el('img', { src: item.image_url, alt: item.name, width: '60', style: 'border-radius:4px;vertical-align:middle;margin-right:10px;' });
    const minus = el('button', { text: '−', 'aria-label': 'Decrease quantity', onclick: () => changeQty(index, -1) });
    const plus = el('button', { text: '+', 'aria-label': 'Increase quantity', onclick: () => changeQty(index, 1) });
    const qty = el('span', { text: String(item.quantity), style: 'display:inline-block;min-width:28px;text-align:center;' });
    const remove = el('button', { text: 'Remove', onclick: () => removeItem(index), style: 'color:#d32f2f;background:none;border:none;cursor:pointer;' });
    tbody.appendChild(el('tr', {}, [
      el('td', {}, [img, el('span', { text: item.name }),
        item.discount > 0 ? el('small', { text: ' (-' + item.discount + '%)', style: 'color:#d32f2f;font-weight:bold;' }) : null]),
      el('td', { text: peso(item.price) }),
      el('td', {}, [minus, qty, plus]),
      el('td', { text: peso(item.price * item.quantity) }),
      el('td', {}, remove)
    ]));
  });
  document.getElementById('cart-total').textContent = peso(cartTotal(cart)).replace('₱', '');
}

function changeQty(index, delta) {
  const cart = getCart();
  if (!cart[index]) return;
  const p = catalog.find(x => String(x.id) === String(cart[index].id));
  const maxAllowed = Math.min(Number(p && p.stock) || 0, MAX_QTY_PER_ITEM);
  const next = cart[index].quantity + delta;
  if (next < 1) return removeItem(index);
  if (next > maxAllowed) { alert('Sorry, only ' + maxAllowed + ' in stock.'); return; }
  cart[index].quantity = next;
  writeCart(cart);
  renderCart();
}
function removeItem(index) {
  const cart = getCart();
  cart.splice(index, 1);
  writeCart(cart);
  renderCart();
}

// ---------- Checkout ----------
async function showCheckout() {
  if (getCart().length === 0) { alert('Your cart is empty.'); return; }
  document.getElementById('cart-section').style.display = 'none';
  document.getElementById('checkout-form').style.display = 'block';

  const user = await getCurrentUser();
  if (user) {
    const nameEl = document.getElementById('customerName');
    const emailEl = document.getElementById('customerEmail');
    if (nameEl && !nameEl.value) nameEl.value = user.username;
    if (emailEl && !emailEl.value) emailEl.value = user.email;
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function showError(message) {
  const err = document.getElementById('checkout-error');
  err.textContent = message;
  err.style.display = 'block';
}

async function placeOrder(e) {
  e.preventDefault();
  if (isSubmitting) return;
  document.getElementById('checkout-error').style.display = 'none';

  const cart = getCart();
  if (cart.length === 0) return showError('Your cart is empty.');
  const payload = {
    name: document.getElementById('customerName').value,
    email: document.getElementById('customerEmail').value,
    phone: document.getElementById('customerPhone').value,
    address: document.getElementById('customerAddress').value,
    payment: document.getElementById('paymentMethod').value,
    items: cart.map(i => ({ id: i.id, quantity: i.quantity }))   // no prices: the server looks them up
  };

  isSubmitting = true;
  const overlay = document.getElementById('loading-overlay');
  overlay.style.display = 'flex';
  const r = await api('POST', '/api/orders', payload);
  overlay.style.display = 'none';
  isSubmitting = false;

  if (!r.ok) return showError(r.data.error || 'Could not place your order. Please try again.');

  sessionStorage.setItem('lastOrderNumber', r.data.order_number);
  localStorage.removeItem(CART_KEY);
  document.getElementById('checkoutForm').style.display = 'none';
  document.getElementById('orderNumber').textContent = r.data.order_number;
  document.getElementById('order-success').style.display = 'block';
}

window.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('checkout-btn').addEventListener('click', showCheckout);
  document.getElementById('checkoutForm').addEventListener('submit', placeOrder);

  const r = await api('GET', '/api/products');
  if (!r.ok) {
    document.getElementById('empty-cart-message').textContent = r.data.error || 'Could not load your cart. Is the server running?';
    document.getElementById('empty-cart-message').style.display = 'block';
    document.querySelector('.cart-table').style.display = 'none';
    document.querySelector('.cart-summary').style.display = 'none';
    return;
  }
  catalog = r.data.products;
  renderCart();
  window.addEventListener('storage', (e) => { if (e.key === CART_KEY) renderCart(); });
});
