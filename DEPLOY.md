# Putting MOSSTECH online with HTTPS

Pick ONE path. Path A takes 5 minutes and is perfect for your defense/demo. Path B gives a permanent web address.

Before any of them, make sure the site works on your computer (`npm.cmd start`, then http://localhost:3000).

---

## Path A: public HTTPS link from your own laptop (Cloudflare Tunnel)

Free, no account needed, HTTPS included. The link works only while your laptop and the server window are running, and the address changes each time.

1. Install the tool once (PowerShell): `winget install --id Cloudflare.cloudflared` then close and reopen PowerShell.
2. In `.env` set these three lines, save, and start the server with `npm.cmd start`:
   ```
   NODE_ENV=production
   TRUST_PROXY=1
   HOST=127.0.0.1
   ```
3. Open a **second** PowerShell tab and run:
   ```
   cloudflared tunnel --url http://localhost:3000
   ```
4. It prints an address like `https://something-random.trycloudflare.com`. Open it on any phone or computer. That is your live HTTPS site.

---

## Path B: Render (permanent address, free plan)

### 1. Put the project on GitHub (private repository)
Create an empty **private** repo on github.com, then in PowerShell inside the project folder:
```
git init
git add .
git commit -m "MOSSTECH"
git branch -M main
git remote add origin https://github.com/YOUR-NAME/mosstech.git
git push -u origin main
```
`.gitignore` already keeps `.env`, `data/` and `node_modules/` out of GitHub. Check that `public/pics/` and the CSS files **are** included. **Never upload your real `.env`.**

### 2. Email: use Brevo (not Gmail SMTP)
Render's free plan blocks outbound SMTP ports (25, 465, 587), so Gmail/SMTP emails fail there. Use an HTTPS email API instead:
1. Make a free account at brevo.com and verify a sender email address (your Gmail works).
2. In Brevo, create an **API key** (SMTP & API section).
3. You will paste it as `BREVO_API_KEY` below. `MAIL_FROM` must be the verified sender, like `MOSSTECH <you@gmail.com>`.

### 3. Create the service on Render
1. render.com -> sign up with GitHub -> **New -> Blueprint** -> choose your repo. (It reads `render.yaml`.)
   Or: **New -> Web Service**, build command `npm install`, start command `npm start`, and add the variables yourself.
2. Fill in the environment variables when asked:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `TRUST_PROXY` | `1` |
| `HOST` | `0.0.0.0` |
| `ADMIN_PASSKEY` | your secret (12+ chars, upper, lower, number, symbol, no `#`) |
| `REQUIRE_EMAIL_VERIFICATION` | `1` |
| `REQUIRE_ADMIN_2FA` | `1` (administrators must turn on 2FA) |
| `BREVO_API_KEY` | from Brevo |
| `MAIL_FROM` | `MOSSTECH <your-verified-email>` |
| `SEED_ADMIN_USERNAME`, `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` | your admin account (see the note below) |

3. Deploy. Render gives you `https://your-name.onrender.com` with a free HTTPS certificate. Check `https://your-name.onrender.com/healthz` shows `ok`.

### What the free plan means for you
- **It sleeps** after 15 minutes without visitors; the next visit takes up to about a minute to wake up. Open the site a few minutes before a presentation.
- **The database is wiped** every time the service restarts, redeploys or sleeps, because the free plan has no permanent disk. Accounts, orders and stock changes are lost. Products come back automatically from `product.html`, and your admin account comes back because of the `SEED_ADMIN_*` variables. Customers must sign up again.
- For permanent data, switch the service to a paid instance, add a disk, and set `DB_PATH=/var/data/mosstech.db` (the lines are already in `render.yaml`, commented out). Paid instances also allow SMTP, if you prefer Gmail.
- Prices and limits change, so check render.com/docs/free before you rely on them.

---

## Checklist after going live
1. The address starts with `https://` and shows the padlock.
2. Browser DevTools -> Application -> Cookies: the `mt_sid` cookie shows **HttpOnly**, **Secure** and **SameSite = Strict**.
3. Sign up with a real email. The 6-digit code should arrive by email.
4. Log in as admin, go to **Settings -> Two-Factor Authentication**, and turn on 2FA. Save the backup codes.
5. Change `ADMIN_PASSKEY` if it was ever shown on screen or in a screenshot.
6. Keep `.env` private. If a password or key leaked, change it.
