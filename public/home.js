/* =====================================================
   MOSSTECH Home - home.js
   "Best Sellers & Deals" is built from the database: every product the admin
   has put on sale (discount > 0 and in stock) appears here, biggest discount first.
   If the server cannot be reached, the tiles written in home.html stay as they are.
   ===================================================== */
'use strict';

async function loadDeals() {
  const box = document.querySelector('.deals');
  if (!box) return;
  const r = await api('GET', '/api/products');
  if (!r.ok) return;

  const deals = r.data.products
    .filter(p => Number(p.discount_percent) > 0 && Number(p.stock) > 0)
    .sort((a, b) => b.discount_percent - a.discount_percent || a.id - b.id)
    .slice(0, 8);

  box.replaceChildren();
  box.style.flexWrap = 'wrap';
  if (deals.length === 0) {
    box.appendChild(el('p', { text: 'No deals right now. Check back soon!' }));
    return;
  }
  deals.forEach(p => {
    box.appendChild(el('div', { class: 'deal' }, [
      el('div', { class: 'percent' }, [p.discount_percent + '%', el('br'), 'Off']),
      el('a', { href: 'product.html?q=' + encodeURIComponent(p.name), text: p.name }),
      el('img', { src: safeImageUrl(p.image_url), alt: p.name }),
      el('p', { style: 'margin:6px 0 0;font-size:.95rem;' }, [
        el('strong', { text: peso(p.sale_price, 0) }), ' ',
        el('s', { text: peso(p.price, 0), style: 'color:var(--text-muted);font-size:.85em;' })
      ])
    ]));
  });
}

window.addEventListener('DOMContentLoaded', loadDeals);
