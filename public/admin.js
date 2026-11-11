/* =====================================================
   MOSSTECH Admin Dashboard - admin.js
   Every action calls /api/admin/*, which the server only allows for a
   logged-in administrator (checked on the server on every request).
   ===================================================== */
'use strict';

const VALID_STATUSES = ['Processing', 'Shipped', 'Out for Delivery', 'Delivered'];
const IDLE_LIMIT_MS = 15 * 60 * 1000;   // the server enforces the same limit
let idleTimer = null;
let cache = { products: [], orders: [] };
let forced2fa = false;   // admin has not turned on 2FA yet: only the 2FA setup screen works

// ---------- Server calls ----------
function goToLogin(message) {
  if (message) alert(message);
  window.location.href = 'login.html';
}
// Wraps api(): if the server says "not logged in / not admin", leave the dashboard
async function call(method, url, body) {
  const r = await api(method, url, body);
  if (r.status === 401 || r.status === 403 && /Administrator|log in/i.test(r.data.error || '')) goToLogin('Your session has ended. Please log in again.');
  return r;
}
function resetIdleTimer() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => { await api('POST', '/api/auth/logout'); goToLogin('Session expired due to inactivity.'); }, IDLE_LIMIT_MS);
}

// ---------- DOM helpers ----------
function clear(node) { node.replaceChildren(); }
function emptyRow(tbody, cols, message) {
  tbody.appendChild(el('tr', {}, el('td', { colspan: String(cols), style: 'text-align:center;', text: message })));
}

// ---------- Modal ----------
function openModal(title, bodyNode, buttons) {
  closeModal();
  const overlay = el('div', {
    id: 'admin-modal',
    style: 'position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:9999;',
    onclick: (e) => { if (e.target.id === 'admin-modal') closeModal(); }
  });
  const box = el('div', { style: 'background:#fff;border-radius:8px;padding:20px;width:92%;max-width:440px;max-height:90vh;overflow:auto;box-shadow:0 8px 30px rgba(0,0,0,.3);' });
  box.appendChild(el('h2', { text: title, style: 'margin:0 0 15px;font-size:1.2rem;color:#1b4332;' }));
  box.appendChild(bodyNode);
  const bar = el('div', { style: 'display:flex;justify-content:flex-end;gap:8px;margin-top:15px;' });
  buttons.forEach(b => bar.appendChild(el('button', {
    text: b.label, onclick: b.onClick,
    style: `background:${b.color || '#757575'};color:#fff;border:none;padding:8px 14px;border-radius:4px;cursor:pointer;font-weight:bold;`
  })));
  box.appendChild(bar);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}
function closeModal() { document.getElementById('admin-modal')?.remove(); }
function field(labelText, input) {
  return el('div', { style: 'margin-bottom:12px;' }, [
    el('label', { text: labelText, style: 'display:block;font-weight:bold;font-size:.9rem;margin-bottom:4px;' }), input
  ]);
}
const INPUT_STYLE = 'width:100%;padding:8px;border:1px solid #ccc;border-radius:4px;box-sizing:border-box;';

// ---------- Tabs ----------
function switchTab(event, targetViewId) {
  if (forced2fa && targetViewId !== 'settings-view') {
    return alert('Turn on two-factor authentication first (Settings > Two-Factor Authentication).');
  }
  document.querySelectorAll('.nav-menu .nav-item').forEach(i => i.classList.remove('active'));
  if (event && event.currentTarget) event.currentTarget.parentElement.classList.add('active');
  document.querySelectorAll('.tab-section').forEach(s => s.classList.remove('active-view'));
  document.getElementById(targetViewId)?.classList.add('active-view');

  if (targetViewId === 'dashboard-view') updateCounters();
  else if (targetViewId === 'users-view') renderUsersTable();
  else if (targetViewId === 'orders-view') renderOrdersTable();
  else if (targetViewId === 'inventory-view') renderInventoryTable();
  else if (targetViewId === 'settings-view') { if (!forced2fa) { loadSettingsForm(); renderAudit(); } renderTwoFactor(); }
}

async function updateCounters() {
  const r = await call('GET', '/api/admin/summary');
  if (!r.ok) return;
  document.getElementById('users-count-val').textContent = r.data.users;
  document.getElementById('orders-count-val').textContent = r.data.orders;
}

// ---------- Users ----------
async function renderUsersTable() {
  const tbody = document.getElementById('user-accounts-table');
  const r = await call('GET', '/api/admin/users');
  clear(tbody);
  if (!r.ok) return emptyRow(tbody, 5, r.data.error || 'Could not load users.');
  if (r.data.users.length === 0) return emptyRow(tbody, 5, 'No registered accounts found.');
  r.data.users.forEach((u, i) => {
    const isAdmin = u.role === 'admin';
    tbody.appendChild(el('tr', {}, [
      el('td', { text: String(i + 1) }),
      el('td', {}, el('strong', { text: u.username })),
      el('td', { text: u.email }),
      el('td', {}, el('span', { class: 'role-tag ' + (isAdmin ? 'role-admin' : 'role-user'), text: isAdmin ? 'ADMIN' : 'USER' })),
      el('td', {}, el('span', { class: 'hash-code', text: 'Hidden' }))
    ]));
  });
}

// ---------- Inventory ----------
async function renderInventoryTable() {
  const tbody = document.getElementById('inventory-table-body');
  const r = await call('GET', '/api/products');
  clear(tbody);
  if (!r.ok) return emptyRow(tbody, 6, r.data.error || 'Could not load products.');
  cache.products = r.data.products;
  if (cache.products.length === 0) return emptyRow(tbody, 6, 'No products found in inventory.');

  cache.products.forEach(p => {
    tbody.appendChild(el('tr', {}, [
      el('td', { text: String(p.id) }),
      el('td', {}, el('img', { src: safeImageUrl(p.image_url), width: '35', alt: 'Product', style: 'border-radius:4px;vertical-align:middle;' })),
      el('td', {}, el('strong', { text: p.name })),
      el('td', {}, Number(p.discount_percent) > 0
        ? [el('strong', { text: peso(p.sale_price) }), el('br'),
           el('small', { text: 'was ' + peso(p.price) + ' (-' + p.discount_percent + '%)', style: 'color:#d32f2f;' })]
        : peso(p.price)),
      el('td', { text: String(p.stock) }),
      el('td', { style: 'text-align:center;' }, [
        el('button', { text: 'Edit', onclick: () => openProductModal(p.id), style: 'background:#1976d2;color:#fff;border:none;padding:4px 8px;border-radius:3px;cursor:pointer;margin-right:5px;' }),
        el('button', { text: 'Delete', onclick: () => deleteProduct(p.id), style: 'background:#d32f2f;color:#fff;border:none;padding:4px 8px;border-radius:3px;cursor:pointer;' })
      ])
    ]));
  });
}

function openAddProductModal() { openProductModal(null); }

function openProductModal(productId) {
  const existing = productId !== null ? cache.products.find(p => String(p.id) === String(productId)) : null;
  if (productId !== null && !existing) return alert('Product not found.');

  const nameIn = el('input', { type: 'text', maxlength: '100', style: INPUT_STYLE, value: existing ? existing.name : '' });
  const priceIn = el('input', { type: 'number', min: '0', step: '0.01', style: INPUT_STYLE, value: existing ? String(existing.price) : '' });
  const stockIn = el('input', { type: 'number', min: '0', step: '1', style: INPUT_STYLE, value: existing ? String(existing.stock) : '' });
  const discIn = el('input', { type: 'number', min: '0', max: '90', step: '1', style: INPUT_STYLE, value: existing ? String(existing.discount_percent || 0) : '0' });
  const catIn = el('select', { style: INPUT_STYLE }, ['laptops', 'cellphones', 'tablets', 'other'].map(c => el('option', { value: c, text: c })));
  catIn.value = existing ? existing.category : 'laptops';
  const brandIn = el('input', { type: 'text', maxlength: '40', style: INPUT_STYLE, value: existing ? existing.brand : '' });
  const imgIn = el('input', { type: 'text', placeholder: 'pics/product.jpg', style: INPUT_STYLE, value: existing ? existing.image_url : '' });

  const body = el('div', {}, [
    field('Product Name', nameIn), field('Price (₱)', priceIn), field('Discount (% off, 0 = none)', discIn), field('Stock', stockIn),
    field('Category', catIn), field('Brand', brandIn), field('Image path / https URL', imgIn)
  ]);

  openModal(existing ? 'Edit Product' : 'Add Product', body, [
    { label: 'Cancel', onClick: closeModal },
    {
      label: 'Save', color: '#2e7d32',
      onClick: async () => {
        const payload = { name: nameIn.value, price: priceIn.value, stock: stockIn.value, discount_percent: discIn.value, category: catIn.value, brand: brandIn.value, image_url: imgIn.value };
        const r = existing
          ? await call('PUT', '/api/admin/products/' + encodeURIComponent(existing.id), payload)
          : await call('POST', '/api/admin/products', payload);
        if (!r.ok) return alert(r.data.error || 'Could not save the product.');
        closeModal();
        renderInventoryTable();
      }
    }
  ]);
}

async function deleteProduct(productId) {
  if (!confirm('Delete this product? This cannot be undone.')) return;
  const r = await call('DELETE', '/api/admin/products/' + encodeURIComponent(productId));
  if (!r.ok) return alert(r.data.error || 'Could not delete the product.');
  renderInventoryTable();
}

// ---------- Orders ----------
async function renderOrdersTable() {
  const tbody = document.getElementById('orders-history-table');
  const r = await call('GET', '/api/admin/orders');
  clear(tbody);
  if (!r.ok) return emptyRow(tbody, 8, r.data.error || 'Could not load orders.');
  cache.orders = r.data.orders;
  if (cache.orders.length === 0) return emptyRow(tbody, 8, 'No orders found.');

  cache.orders.forEach(order => {
    const num = order.order_number;
    const select = el('select', { class: 'status-select' }, VALID_STATUSES.map(s => el('option', { value: s, text: s })));
    select.value = VALID_STATUSES.includes(order.status) ? order.status : 'Processing';
    select.addEventListener('change', () => updateOrderStatus(num, select.value));

    tbody.appendChild(el('tr', {}, [
      el('td', {}, el('strong', { text: num })),
      el('td', {}, [el('strong', { text: order.customer_name }), el('br'), el('small', { style: 'color:#666', text: order.customer_email })]),
      el('td', {}, el('button', { text: 'View Order Details', onclick: () => showOrderDetails(num),
        style: 'background:none;border:none;color:#1976d2;cursor:pointer;text-decoration:underline;padding:0;' })),
      el('td', { text: peso(order.total_amount) }),
      el('td', { text: order.payment_method }),
      el('td', { text: order.order_date }),
      el('td', {}, select),
      el('td', {}, el('button', { text: 'Delete', onclick: () => deleteOrder(num), style: 'color:red;background:none;border:none;cursor:pointer;' }))
    ]));
  });
}

function showOrderDetails(orderNumber) {
  const order = cache.orders.find(o => o.order_number === orderNumber);
  if (!order) return alert('Order not found.');
  const list = el('ul', { style: 'padding-left:18px;margin:0;' });
  if (order.items.length === 0) list.appendChild(el('li', { text: 'No item details saved for this order.' }));
  order.items.forEach(it => list.appendChild(el('li', { text: `${it.name} x${it.quantity} - ${peso(it.price)}` })));
  openModal('Order Details', el('div', {}, [
    el('p', { text: 'Order #' + orderNumber, style: 'margin-top:0;font-weight:bold;' }),
    list,
    el('p', { text: 'Total: ' + peso(order.total_amount), style: 'margin-bottom:0;font-weight:bold;' })
  ]), [{ label: 'Close', onClick: closeModal }]);
}

async function updateOrderStatus(orderNumber, newStatus) {
  const r = await call('PATCH', '/api/admin/orders/' + encodeURIComponent(orderNumber) + '/status', { status: newStatus });
  if (!r.ok) { alert(r.data.error || 'Could not update the status.'); return renderOrdersTable(); }
  alert(`Order ${orderNumber} status updated to "${newStatus}"!`);
}

async function deleteOrder(orderNumber) {
  if (!confirm(`Are you sure you want to delete order ${orderNumber}?`)) return;
  const r = await call('DELETE', '/api/admin/orders/' + encodeURIComponent(orderNumber));
  if (!r.ok) return alert(r.data.error || 'Could not delete the order.');
  renderOrdersTable();
  updateCounters();
}

// ---------- Settings ----------
function getSettingsInputs() {
  const card = document.querySelector('#settings-view .card');
  const inputs = card ? card.querySelectorAll('input') : [];
  return { name: inputs[0], email: inputs[1], shipping: inputs[2], saveBtn: card ? card.querySelector('button') : null };
}
async function loadSettingsForm() {
  const f = getSettingsInputs();
  const r = await call('GET', '/api/admin/settings');
  if (!r.ok || !f.name) return;
  f.name.value = r.data.settings.storeName;
  f.email.value = r.data.settings.supportEmail;
  f.shipping.value = Number(r.data.settings.shippingFee).toFixed(2);
}
async function saveStoreSettings() {
  const f = getSettingsInputs();
  const r = await call('PUT', '/api/admin/settings', { storeName: f.name.value, supportEmail: f.email.value, shippingFee: f.shipping.value });
  alert(r.ok ? 'Store settings saved successfully!' : (r.data.error || 'Could not save settings.'));
}

function updateAdminPasskey() {
  const input = document.getElementById('newAdminKey');
  const newPasskey = input.value;
  if (!newPasskey) return alert('Enter the new passkey first.');
  const pwIn = el('input', { type: 'password', style: INPUT_STYLE, autocomplete: 'current-password' });
  openModal('Confirm your password', field('Your admin account password', pwIn), [
    { label: 'Cancel', onClick: closeModal },
    {
      label: 'Update Passkey', color: '#d32f2f',
      onClick: async () => {
        const r = await call('PUT', '/api/admin/passkey', { currentPassword: pwIn.value, newPasskey });
        if (!r.ok) return alert(r.data.error || 'Could not update the passkey.');
        closeModal();
        input.value = '';
        alert('Admin passkey updated!');
      }
    }
  ]);
}

// ---------- Two-factor authentication ----------
function actionButton(label, color, onClick) {
  return el('button', { text: label, onclick: onClick,
    style: `background:${color};color:#fff;border:none;padding:9px 15px;border-radius:4px;cursor:pointer;font-weight:bold;` });
}
async function renderTwoFactor() {
  const body = document.getElementById('twofa-body');
  if (!body) return;
  const r = await call('GET', '/api/admin/2fa/status');
  clear(body);
  if (!r.ok) return body.appendChild(el('p', { text: r.data.error || 'Could not load the 2FA status.' }));
  if (r.data.enabled) {
    body.appendChild(el('p', { text: `Enabled ✔  Logging in needs a code from your authenticator app. Backup codes left: ${r.data.backupLeft}.`, style: 'margin-top:0;' }));
    body.appendChild(actionButton('Turn off 2FA', '#d32f2f', openDisableTwoFactor));
  } else {
    body.appendChild(el('p', { text: (r.data.required ? 'REQUIRED for administrators: ' : 'Off. ') + 'Add a second step to admin login: a 6-digit code from an app such as Google Authenticator, Microsoft Authenticator or Authy.', style: 'margin-top:0;' }));
    body.appendChild(actionButton('Set up 2FA', '#2e7d32', openSetupTwoFactor));
  }
}

function openSetupTwoFactor() {
  const pwIn = el('input', { type: 'password', style: INPUT_STYLE, autocomplete: 'current-password' });
  openModal('Set up 2FA: confirm your password', field('Your admin account password', pwIn), [
    { label: 'Cancel', onClick: closeModal },
    { label: 'Continue', color: '#2e7d32', onClick: async () => {
        const r = await call('POST', '/api/admin/2fa/setup', { password: pwIn.value });
        if (!r.ok) return alert(r.data.error || 'Could not start the setup.');
        showSetupStep(r.data);
    } }
  ]);
}
function showSetupStep(data) {
  const codeIn = el('input', { type: 'text', inputmode: 'numeric', maxlength: '6', placeholder: '6-digit code', style: INPUT_STYLE, autocomplete: 'one-time-code' });
  const body = el('div', {}, [
    el('p', { text: '1. In your authenticator app choose "Add account", then scan this QR code' + (data.qr ? '' : ' (not available, so use the key below)') + ':', style: 'margin-top:0;' }),
    data.qr ? el('img', { src: data.qr, alt: 'QR code', width: '220', height: '220', style: 'display:block;margin:0 auto 10px;background:#fff;' }) : null,
    el('p', { text: 'Or type this key manually:', style: 'margin:6px 0 4px;' }),
    el('code', { text: data.secret, style: 'display:block;word-break:break-all;background:var(--primary);color:var(--accent);border:1px solid var(--border-color);padding:8px;border-radius:4px;user-select:all;' }),
    el('p', { text: '2. Enter the 6-digit code the app shows:', style: 'margin:14px 0 6px;' }),
    codeIn
  ]);
  openModal('Set up 2FA: scan the code', body, [
    { label: 'Cancel', onClick: () => { closeModal(); renderTwoFactor(); } },
    { label: 'Turn on 2FA', color: '#2e7d32', onClick: async () => {
        const r = await call('POST', '/api/admin/2fa/enable', { code: codeIn.value });
        if (!r.ok) return alert(r.data.error || 'That code is not correct.');
        showBackupCodes(r.data.backupCodes);
    } }
  ]);
}
function showBackupCodes(codes) {
  const list = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:10px 0;' },
    codes.map(c => el('code', { text: c, style: 'background:var(--primary);color:var(--accent);border:1px solid var(--border-color);padding:6px;border-radius:4px;text-align:center;font-size:1rem;letter-spacing:1px;' })));
  openModal('2FA is on: save your backup codes', el('div', {}, [
    el('p', { text: 'If you lose your phone, each of these codes can be used once instead of the app code. They are shown only this one time. Write them down or store them somewhere safe.', style: 'margin-top:0;' }),
    list
  ]), [{ label: 'I saved them', color: '#2e7d32', onClick: () => { closeModal(); if (forced2fa) return window.location.reload(); renderTwoFactor(); } }]);
}
function openDisableTwoFactor() {
  const pwIn = el('input', { type: 'password', style: INPUT_STYLE, autocomplete: 'current-password' });
  const codeIn = el('input', { type: 'text', style: INPUT_STYLE, placeholder: 'Authenticator or backup code', autocomplete: 'one-time-code' });
  openModal('Turn off 2FA', el('div', {}, [field('Your admin account password', pwIn), field('Authenticator or backup code', codeIn)]), [
    { label: 'Cancel', onClick: closeModal },
    { label: 'Turn off', color: '#d32f2f', onClick: async () => {
        const r = await call('POST', '/api/admin/2fa/disable', { password: pwIn.value, code: codeIn.value });
        if (!r.ok) return alert(r.data.error || 'Could not turn off 2FA.');
        closeModal();
        renderTwoFactor();
    } }
  ]);
}

// ---------- Security audit log ----------
async function renderAudit() {
  const tbody = document.getElementById('audit-body');
  if (!tbody) return;
  clear(tbody);
  const r = await call('GET', '/api/admin/audit');
  if (!r.ok) return emptyRow(tbody, 5, r.data.error || 'Could not load the audit log.');
  if (!r.data.entries.length) return emptyRow(tbody, 5, 'No events yet.');
  r.data.entries.forEach(e => tbody.appendChild(el('tr', {}, [
    el('td', { text: e.time, style: 'white-space:nowrap;' }), el('td', { text: e.user }),
    el('td', { text: e.action }), el('td', { text: e.detail }), el('td', { text: e.ip })
  ])));
}

// ---------- Logout ----------
async function handleLogout() {
  if (!confirm('Log out of Admin Panel?')) return;
  await api('POST', '/api/auth/logout');
  window.location.href = 'login.html';
}

// ---------- Init ----------
window.addEventListener('DOMContentLoaded', async () => {
  const user = await getCurrentUser();
  if (!user || user.role !== 'admin') return goToLogin();
  document.getElementById('admin-name').textContent = user.username;

  // Buttons are wired here (not with inline onclick="..." attributes) so the strict CSP can block inline scripts
  document.querySelectorAll('.nav-menu a[data-tab]').forEach(a =>
    a.addEventListener('click', (e) => switchTab(e, a.dataset.tab)));
  document.getElementById('logoutBtn')?.addEventListener('click', () => handleLogout());
  document.getElementById('addProductBtn')?.addEventListener('click', () => openAddProductModal());

  const f = getSettingsInputs();
  if (f.saveBtn) f.saveBtn.onclick = saveStoreSettings;
  const keyBtn = document.querySelector('#newAdminKey')?.parentElement.querySelector('button');
  if (keyBtn) keyBtn.onclick = updateAdminPasskey;

  ['click', 'keydown', 'mousemove', 'touchstart'].forEach(ev => document.addEventListener(ev, resetIdleTimer, { passive: true }));
  resetIdleTimer();

  if (user.needs2fa) {
    // Administrators must have 2FA. Until it is on, the server only allows the 2FA setup calls.
    forced2fa = true;
    document.querySelectorAll('.nav-menu .nav-item').forEach(i => i.classList.remove('active'));
    document.querySelector('.nav-menu a[data-tab="settings-view"]')?.parentElement.classList.add('active');
    switchTab(null, 'settings-view');
    alert('For security, administrators must turn on two-factor authentication before using the admin panel. Set it up now.');
    return;
  }

  loadSettingsForm();
  updateCounters();
  renderUsersTable();
  renderOrdersTable();
  renderInventoryTable();

});
