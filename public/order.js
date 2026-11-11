/* =====================================================
   MOSSTECH Order Status - order.js
   The server only returns an order when order number AND email both match.
   ===================================================== */
'use strict';

const STATUS_STEPS = ['Processing', 'Shipped', 'Out for Delivery', 'Delivered'];

function showResult(node) {
  const box = document.getElementById('orderResult');
  box.replaceChildren(node);
  box.style.display = 'block';
}
function showMessage(text, isError) {
  showResult(el('p', { text, style: 'text-align:center;margin:10px 0;color:' + (isError ? 'var(--danger, #f87171)' : 'var(--text-main, #f4f4f5)') + ';' }));
}

function statusTracker(status) {
  const current = Math.max(STATUS_STEPS.indexOf(status), 0);
  const row = el('div', { style: 'display:flex;justify-content:space-between;gap:6px;margin:15px 0;flex-wrap:wrap;' });
  STATUS_STEPS.forEach((step, i) => {
    const done = i <= current;
    row.appendChild(el('div', {
      text: (done ? '✔ ' : '○ ') + step,
      style: `flex:1;min-width:110px;text-align:center;padding:8px 4px;border-radius:4px;font-size:.85rem;` +
             `background:${done ? 'var(--accent, #4ade80)' : 'var(--border-color, #27272a)'};color:${done ? 'var(--primary, #121212)' : 'var(--text-muted, #a1a1aa)'};font-weight:${i === current ? 'bold' : 'normal'};`
    }));
  });
  return row;
}

function buildOrder(order) {
  const wrap = el('div', {});
  wrap.appendChild(el('h3', { text: 'Order #' + String(order.order_number) }));
  wrap.appendChild(el('p', {}, [el('strong', { text: 'Status: ' }), el('span', { text: order.status })]));
  wrap.appendChild(statusTracker(order.status));
  wrap.appendChild(el('div', { style: 'margin:10px 0;line-height:1.7;' }, [
    order.customer_name ? el('div', {}, [el('strong', { text: 'Customer: ' }), String(order.customer_name)]) : null,
    el('div', {}, [el('strong', { text: 'Order date: ' }), String(order.order_date || 'N/A')]),
    el('div', {}, [el('strong', { text: 'Payment: ' }), String(order.payment_method || 'N/A')])
  ]));
  wrap.appendChild(el('h4', { text: 'Items', style: 'margin:15px 0 6px;' }));
  const list = el('ul', { style: 'padding-left:18px;margin:0;' });
  const items = Array.isArray(order.items) ? order.items : [];
  if (items.length === 0) list.appendChild(el('li', { text: 'No item details saved for this order.' }));
  items.forEach(it => list.appendChild(el('li', { text: `${it.name} x${it.quantity} - ${peso(it.price)}` })));
  wrap.appendChild(list);
  wrap.appendChild(el('p', { text: 'Total: ' + peso(order.total_amount), style: 'font-weight:bold;margin-top:12px;' }));
  return wrap;
}
function renderOrder(order) { showResult(buildOrder(order)); }

// ---------- My Orders (logged-in customers) ----------
async function loadMyOrders() {
  const r = await api('GET', '/api/orders/mine');
  if (!r.ok) return;
  document.getElementById('myOrdersBox').style.display = 'block';
  const box = document.getElementById('myOrders');
  box.replaceChildren();
  if (r.data.orders.length === 0) {
    box.appendChild(el('p', { text: 'You have no orders yet. Orders you place while logged in will appear here.' }));
    return;
  }
  r.data.orders.forEach(o => {
    const card = buildOrder(o);
    card.className = 'order-result';
    card.style.cssText = 'display:block;margin-bottom:18px;';
    box.appendChild(card);
  });
}

let tracking = false;
async function trackOrder() {
  if (tracking) return;
  const orderNumber = document.getElementById('orderNumberInput').value.trim();
  const email = document.getElementById('emailInput').value.trim();
  if (!orderNumber) return showMessage('Please enter your order number.', true);
  if (!email) return showMessage('Please enter the email used during purchase.', true);

  tracking = true;
  const r = await api('POST', '/api/orders/track', { orderNumber, email });
  tracking = false;
  if (!r.ok) return showMessage(r.data.error || 'Could not look up the order.', true);
  renderOrder(r.data.order);
}

window.addEventListener('DOMContentLoaded', async () => {
  const numberInput = document.getElementById('orderNumberInput');
  const emailInput = document.getElementById('emailInput');

  const last = sessionStorage.getItem('lastOrderNumber');   // from the checkout you just made
  if (last) numberInput.value = last;
  const user = await getCurrentUser();
  if (user && user.email) emailInput.value = user.email;
  if (user) { loadMyOrders(); setInterval(loadMyOrders, 30000); }   // refresh statuses every 30 s

  document.getElementById('trackBtn').addEventListener('click', trackOrder);
  [numberInput, emailInput].forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') trackOrder(); }));
});
