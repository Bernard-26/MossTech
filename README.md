# MOSSTECH – Express + SQLite back-end

## 1. Setup (Windows / Mac / Linux)

1. Install **Node.js 22.13 or newer** (https://nodejs.org – the LTS version is fine). Check with `node -v`.
2. Copy your **CSS files and the `pics/` folder** into `public/` (next to the HTML files):
   `home.css, about.css, help.css, login.css, product.css, cart.css, order.css, admin.css, pics/`
3. In this folder run:
   ```
   npm install
   copy .env.example .env      (Mac/Linux: cp .env.example .env)
   ```
4. Open `.env` and change `ADMIN_PASSKEY` (this is the secret needed to create an administrator account).
5. Start the server:
   ```
   npm start
   ```
6. Open **http://localhost:3000** – always use this address, not the HTML files directly (double-clicking the files is what caused the `ERR_UNEXPECTED` error before).

First start: the 25 products in `public/product.html` are copied into the database (stock 10 each) and the admin passkey is stored hashed.
After that, the **admin dashboard controls products, prices and stock**.

Create your admin account on the Sign Up tab: *Account Type → Administrator* + the passkey from `.env`.

Run the logic tests with `npm test`.

Online hosting: see **DEPLOY.md**.

## 2. Project layout

```
server.js               app setup, security headers, routes, error handling
server/db.js            SQLite tables (users, sessions, products, orders, order_items, settings)
server/security.js      password hashing, sessions, CSRF, rate limits, headers, validation
server/totp.js          authenticator-app codes (2FA), no extra package
server/twofactor.js     checks an authenticator or backup code
server/mailer.js        sends email (Brevo API, SMTP, or prints to the console)
server/services.js      order rules (server-side prices + stock)
server/pricing.js       discount price calculation + starting deals
server/seed.js          first-run import of products from product.html
server/routes/auth.js   signup, login, logout, me, forgot/reset password
server/routes/shop.js   products list, place order, track order
server/routes/admin.js  admin-only: users, products, orders, settings, passkey
public/                 your website (HTML/CSS/JS). common.js is new and shared by every page
data/mosstech.db        created automatically (never commit it)
```

## 3. What changed in the front-end

* `localStorage` no longer holds users, passwords, orders, products, sessions or the passkey. Only the cart (`id` + `quantity`) stays in the browser.
* New `common.js` (loaded by every page): `api()` helper, `el()` helper, Sign In/Sign Out button.
* `login.js, product.js, cart.js, order.js, admin.js` were rewritten to call the API.
* `about/help/home.html`: the old inline script was replaced by `common.js`.
* `Order.html` is now `order.html` (your links already used the lowercase name).
* Admin product form now also has **Category** and **Brand** (so new products appear under the right filters).
* **Discounts are real:** each product has a *Discount (%)* (0-90) that the admin sets in the product form. The server charges the discounted price at checkout, product cards and the cart show the old price crossed out, and the home page "Best Sellers & Deals" tiles are built from the products on sale. Starting deals: Lenovo Legion 5 (20%), Infinix Note 50 (15%), Redmi Note 15 (10%), Samsung Galaxy Tab A9+ (19%).

## 4. Security features

| Area | What it does |
|---|---|
| Passwords & admin passkey | Hashed with scrypt + random salt on the server. Never stored or sent in plain text. |
| Sessions | Random 256-bit token in an `HttpOnly`, `SameSite=Strict` cookie (JavaScript cannot read it). Only a hash of the token is stored. New session on every login. 8 h max; idle logout after 15 min (admin) / 2 h (customer). Password reset logs out all devices. |
| Authorization | Role is checked **on the server on every request**. `/api/admin/*` is admin-only, and `/admin.html` itself is only served to a logged-in admin. Editing the browser's storage no longer gives access. |
| Prices & stock | The browser sends only product ids and quantities. The server looks up prices, checks stock and deducts it in one database transaction (no overselling, no underpaying). |
| Order tracking | Needs order number **and** email. Customer name is masked. Failed lookups are throttled. |
| Brute force | Per-account lockout (5 fails = 60 s), per-IP rate limits on login, signup, reset, orders, tracking, plus a global API limit. Same response time and message whether or not an account exists. |
| CSRF | SameSite cookie + required `X-Requested-With` header + `Origin` check on every POST/PUT/PATCH/DELETE. |
| Injection / XSS | All SQL uses prepared statements. Pages build the DOM with `textContent` (no `innerHTML`). Input is validated and length-limited on the server. Image URLs must be `pics/...` or `https://...`. |
| Headers | CSP, `X-Frame-Options`, `nosniff`, Referrer-Policy, Permissions-Policy, HSTS (production), `Cache-Control: no-store` on the API, no `X-Powered-By`. |
| Errors | Details go to the server log; the browser only gets a generic message. |
| Email verification | New accounts must enter a 6-digit code emailed to them (valid 15 min, 5 tries, resend every 60 s). Turn off with `REQUIRE_EMAIL_VERIFICATION=0`. Existing accounts are treated as verified. |
| Admin two-factor (2FA) | Optional. Admins turn it on under Settings -> Two-Factor Authentication using an authenticator app (Google/Microsoft Authenticator, Authy). Login then needs the 6-digit code; 8 one-time backup codes are given. A used code cannot be replayed. Setup and removal need the admin password. |
| HTTPS | In production the server redirects HTTP to HTTPS, sends HSTS, and marks the session cookie `Secure`. See `DEPLOY.md`. |

## 5. Things to know

* **Email** (verification + password reset): with nothing configured, emails are printed in the **server window** (`[DEMO EMAIL]`), which is fine for testing. For real emails set `BREVO_API_KEY` (works everywhere) or the `SMTP_*` values (works on your own computer) in `.env`. Render's free plan blocks SMTP, so use Brevo there.
* **Going live:** follow `DEPLOY.md` (Cloudflare Tunnel for a quick demo link, or Render for a permanent address).
* Rate-limit counters and reset codes live in memory, so they reset when the server restarts. Fine for a capstone; use Redis for a large deployment.
* `login.html` and `admin.html` still use inline `onclick="..."` attributes, so the CSP has `script-src-attr 'unsafe-inline'`. To tighten it, replace those attributes with `addEventListener` calls and delete that CSP line in `server/security.js`.
* The "Default Shipping Fee" setting is saved, but checkout does not add shipping yet (it did not before either).
* Back up `data/mosstech.db` (it also creates `-wal`/`-shm` files while running).
