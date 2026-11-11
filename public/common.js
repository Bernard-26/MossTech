/* =====================================================
   MOSSTECH shared helpers - common.js
   Loaded by every page BEFORE its own script.
   Talks to the Express back-end (session cookie is HttpOnly, so JS never sees it).
   ===================================================== */
'use strict';

// ---------- Server calls ----------
async function api(method, url, body) {
  const opts = { method, credentials: 'same-origin', headers: { 'X-Requested-With': 'mosstech' } };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try { res = await fetch(url, opts); }
  catch (e) { return { ok: false, status: 0, data: { error: 'Cannot reach the server. Is it running?' } }; }
  let data = {};
  try { data = await res.json(); } catch (e) { /* non-JSON reply */ }
  return { ok: res.ok, status: res.status, data };
}

let _mePromise = null;
function getCurrentUser() {
  if (!_mePromise) _mePromise = api('GET', '/api/auth/me').then(r => (r.ok ? r.data.user : null));
  return _mePromise;
}

// ---------- Safe DOM helper (never uses innerHTML) ----------
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'text') node.textContent = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k === 'class') node.className = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  (Array.isArray(children) ? children : [children]).forEach(c => {
    if (c === null || c === undefined) return;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return node;
}

// ---------- Formatting ----------
function safeImageUrl(url) {
  const fallback = 'pics/default.jpg';
  if (!url || typeof url !== 'string') return fallback;
  const u = url.trim();
  if (/^https:\/\//i.test(u)) return u;
  if (/^[\w\-./ ]+$/.test(u) && !u.includes('..')) return u;
  return fallback;
}
function peso(n, minDecimals = 2) {
  const num = Number(n);
  return '₱' + (isNaN(num) ? 0 : num).toLocaleString('en-US', { minimumFractionDigits: minDecimals, maximumFractionDigits: 2 });
}

// ---------- Nav: Sign In / Sign Out button (all pages) ----------
async function setupAuthButton() {
  const btn = document.getElementById('navAuthBtn');
  if (!btn) return;
  const user = await getCurrentUser();
  if (!user) return; // keeps the normal "Sign In" link to login.html
  btn.textContent = 'Sign Out';
  btn.setAttribute('href', '#');
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!confirm('Sign out?')) return;
    await api('POST', '/api/auth/logout');
    window.location.href = 'login.html';
  });
}

window.addEventListener('DOMContentLoaded', () => {
  setupAuthButton();
  // Category dropdowns in the home page sidebar
  document.querySelectorAll('.dropdown-header').forEach(h =>
    h.addEventListener('click', () => h.parentElement.classList.toggle('open')));
});
