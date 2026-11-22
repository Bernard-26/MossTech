# Running MOSSTECH with PostgreSQL and Docker

Commands are for **PowerShell** (Windows + Docker Desktop). On Linux/macOS they are identical except for `Copy-Item` (use `cp`).

## What changed
* The database is **PostgreSQL** (driver: `pg`). All settings come from environment variables: `DATABASE_URL` **or** `DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD`.
* On start the app **waits for PostgreSQL** (30 tries with a growing delay), creates the tables from `db/migrations/*.sql`, then listens. `docker compose` also waits for the postgres health check.
* `/healthz` = the web server is alive. `/readyz` = the web server **and** the database answer (used by the Docker health check).
* Backups use `pg_dump` (custom format) instead of copying the SQLite file.

## 0. One-time: refresh the lock file
The Dockerfile uses `npm ci`, which needs `package-lock.json` to contain the new `pg` package. In the project folder:
```powershell
npm.cmd install
```
Commit the updated `package-lock.json`.

## 1. Configure
```powershell
Copy-Item .env.example .env
notepad .env
```
Set at least `POSTGRES_PASSWORD` (long, random, no `#` or `$`) and `ADMIN_PASSKEY`. Keep `NODE_ENV=development` for testing on `http://localhost`.

## 2. Build and start
```powershell
docker compose build
docker compose up -d
docker compose ps          # postgres and app should become "healthy"
docker compose logs -f app # Ctrl+C to stop following
```
Open http://localhost:3000. The first start creates the tables, saves the admin passkey (hashed) and loads the products from `public/product.html`.

Tables are created automatically (`AUTO_MIGRATE=1`). To run it by hand (for example after setting `AUTO_MIGRATE=0`):
```powershell
docker compose run --rm app npm run migrate
```

## 3. Move your existing SQLite data (only if you have real data)
Do this **before** the app's first start (the app loads starter products into an empty database, and the import needs empty tables):
```powershell
docker compose up -d postgres
docker compose run --rm -v "${PWD}/data:/import:ro" app node scripts/import-sqlite.js /import/mosstech.db
docker compose up -d
```
Sessions are not copied, so everyone logs in again. Already started the app? `docker compose down -v` wipes the PostgreSQL volume (all its data), then repeat the steps above.

## 4. Everyday commands
```powershell
docker compose logs --tail 100 app        # app log (verification codes print here when no email is configured)
docker compose logs --tail 100 postgres
docker compose restart app
docker compose up -d --build              # after changing code
docker compose down                       # stop (data is kept in the pgdata volume)
docker compose exec postgres psql -U mosstech -d mosstech   # SQL prompt  (\dt lists tables, \q quits)
```

## 5. Backups and restore
Automatic: the app writes a `pg_dump` file to the `app_backups` volume every `BACKUP_EVERY_HOURS` (default 24) and keeps the newest `BACKUP_KEEP` (7).

Manual, from the host (works even if `pg_dump` is missing in the app image). Single quotes matter in PowerShell:
```powershell
docker compose exec postgres sh -c 'pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB" -f /tmp/mosstech.dump'
docker compose cp postgres:/tmp/mosstech.dump .\mosstech.dump
```
Restore into the running database (replaces what is there):
```powershell
docker compose cp .\mosstech.dump postgres:/tmp/mosstech.dump
docker compose exec postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner /tmp/mosstech.dump'
docker compose restart app
```
Copy backups off this computer (the volume lives on the same disk as the database).

## 6. Putting it online with HTTPS
1. Point a domain's DNS A record at your server's public IP, open ports 80 and 443.
2. In `.env`: `NODE_ENV=production`, `TRUST_PROXY=1`, `DOMAIN=shop.example.com`.
3. `docker compose --profile proxy up -d --build`. Caddy gets the certificate automatically.

Keep `APP_BIND=127.0.0.1` so only Caddy can reach the app. Do not publish port 5432.

## 7. Tests
The tests **wipe** the database they use, so they only accept a database whose name contains `test`:
```powershell
docker run --rm -d --name mt-test -p 5433:5432 -e POSTGRES_PASSWORD=test -e POSTGRES_DB=mosstech_test postgres:17-alpine
$env:TEST_DATABASE_URL = "postgres://postgres:test@localhost:5433/mosstech_test"
npm.cmd test
docker stop mt-test
```

## Troubleshooting
| Symptom | Cause / fix |
|---|---|
| `POSTGRES_PASSWORD` error when running compose | `.env` is missing or the value is empty. |
| App log: `PostgreSQL not ready (attempt n/30)` repeating, then exit | Database not up. `docker compose ps`, `docker compose logs postgres`. The container restarts itself and retries. |
| App log: `wrong database user or password` | You changed `POSTGRES_PASSWORD` **after** the first start. The volume keeps the old password. Change it inside (`ALTER USER mosstech PASSWORD '...'` via psql) or, if the data is disposable, `docker compose down -v`. |
| `database "x" does not exist` | `POSTGRES_DB` was changed after the volume was created. Same fix as above, or `CREATE DATABASE`. |
| `npm ci` fails during build: lock file out of sync | Run `npm.cmd install` (step 0) and rebuild. |
| `extension "citext" ... permission denied` | Managed database without rights to create extensions: enable `citext` in its dashboard, or connect as the owner. |
| Page opens but login immediately fails / loops | `NODE_ENV=production` over plain `http://` (Secure cookies). Use `development` locally, or serve HTTPS. |
| `port is already allocated` | Change `APP_PORT` in `.env`, or stop whatever uses 3000/5432. |
| `pg_dump` errors with "server version mismatch" | The `pg_dump` in the app image must be the same version as the server or newer (image: 17, server: `postgres:17`). |
| Everyone shares one IP / rate limits misfire behind a proxy | Set `TRUST_PROXY=1` when using Caddy/Cloudflare. |
| Slow first start | Normal: Postgres initialises its data directory once. |

## Limits to know
* Rate-limit counters, 2FA login challenges and password-reset codes are kept in the app's memory. That is fine for **one** app container; if you run several replicas, move them to the database or Redis.
* Changing the PostgreSQL major version (17 → 18) needs a dump/restore; do not just change the image tag.
