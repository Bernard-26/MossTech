'use strict';
// Price after a percentage discount, rounded to whole centavos. Used for the store, the cart and every order.
function salePrice(price, discountPercent) {
  const d = Number(discountPercent) || 0;
  return Math.round(Number(price) * (100 - d)) / 100;
}
// Discounts the shop starts with (product id -> percent). The admin can change them any time.
// 5 = Lenovo Legion 5, 11 = Infinix Note 50, 17 = Redmi Note 15, 19 = Samsung Galaxy Tab A9+
const DEFAULT_DEALS = { 5: 20, 11: 15, 17: 10, 19: 19 };
module.exports = { salePrice, DEFAULT_DEALS };
