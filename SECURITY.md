# MOSSTECH security notes

## What protects the system
- **Passwords / admin passkey**: salted scrypt, constant-time comparison, no user-enumeration timing.
- **Sessions**: random token in an `HttpOnly`, `SameSite=Strict` (`Secure` in production) cookie; only a hash is stored; 8 h max, 15 min idle for admins.
- **CSRF**: strict cookie + custom header + Origin check.
- **Admin**: server-side role check on every request; admin pages/scripts are only served to admins; **2FA (authenticator app) is mandatory** (`REQUIRE_ADMIN_2FA=1`).
- **Admin password reset** needs the passkey **and**, if the admin has 2FA, an authenticator/backup code.
- **Lockouts** are stored in the database (survive restarts) and keyed by IP + account, so a stranger cannot lock a real user out.
- **Account deletion** needs the current password; the last administrator cannot be deleted.
- **CSP** blocks inline scripts (no `onclick="..."` anywhere), plus HSTS, `X-Frame-Options`, `nosniff`, etc.
- **Audit log** (Admin > Settings): logins, failures, resets, 2FA changes, product/order/settings changes. No secrets are ever logged.
- **Static files**: only normal web file types are served from `public/`; private files live in `docs/`.

## Before sharing or deploying
1. **Never zip or upload `.env` or `data/`.** They hold your email password and real user data.
2. If a `.env` was ever shared, **rotate**: the Gmail app password (`SMTP_PASS`), `ADMIN_PASSKEY`, and any `SEED_ADMIN_PASSWORD`.
   After changing `ADMIN_PASSKEY`, also change it inside the app (Admin > Settings), because the hash is stored in the database.
3. Behind Render/nginx/Cloudflare set `TRUST_PROXY=1`, otherwise all visitors share one IP.
4. Run `npm audit` on a machine with internet and update dependencies when it reports problems.
5. Log in as admin once and finish the forced 2FA setup; save the backup codes.

## Known limits (accepted for this project)
- Rate-limit counters (not lockouts) are in memory and reset on restart.
- Inline `style="..."` attributes are still allowed by the CSP (the pages use many).
- Whoever holds `ADMIN_PASSKEY` can create admin accounts, so keep it secret and long.
