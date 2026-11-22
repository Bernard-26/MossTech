'use strict';
// One-off: copy an existing SQLite database (data/mosstech.db) into PostgreSQL.
//   npm run import:sqlite -- path/to/mosstech.db
// Needs Node 22.13+ (built-in node:sqlite). Run it AFTER PostgreSQL is up. The target tables must be empty.
// Sessions and lockout counters are not copied (everybody simply logs in again).
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { pool, waitForDb, close } = require('../server/db');
const { migrate } = require('../server/migrate');

const file = process.argv[2];
if (!file || !fs.existsSync(file)) { console.error('Usage: npm run import:sqlite -- path/to/mosstech.db'); process.exit(1); }

// parents before children
const TABLES = ['users', 'products', 'settings', 'orders', 'order_items', 'email_verifications', 'totp_backup', 'audit_log'];
const HAS_ID_SEQUENCE = ['users', 'products', 'orders', 'order_items', 'totp_backup', 'audit_log'];

(async () => {
  await waitForDb();
  await migrate();
  const src = new DatabaseSync(file, { readOnly: true });
  const client = await pool.connect();
  try {
    for (const t of TABLES) {
      const n = (await client.query(`SELECT COUNT(*) AS n FROM ${t}`)).rows[0].n;
      if (Number(n) > 0) throw new Error(`Table "${t}" in PostgreSQL is not empty. Import into a fresh database.`);
    }
    await client.query('BEGIN');
    for (const t of TABLES) {
      const exists = src.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(t);
      if (!exists) { console.log(`- ${t}: not in the SQLite file, skipped`); continue; }
      const pgCols = (await client.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1", [t])).rows.map((r) => r.column_name);
      const rows = src.prepare(`SELECT * FROM ${t}`).all();
      for (const row of rows) {
        const cols = Object.keys(row).filter((c) => pgCols.includes(c));
        const vals = cols.map((c) => {
          const v = row[c];
          // SQLite stored "YYYY-MM-DD HH:MM:SS" (UTC) as text
          return t === 'users' && c === 'created_at' && typeof v === 'string' ? new Date(v.replace(' ', 'T') + 'Z') : v;
        });
        await client.query(`INSERT INTO ${t}(${cols.join(',')}) VALUES(${cols.map((_, i) => '$' + (i + 1)).join(',')})`, vals);
      }
      console.log(`- ${t}: ${rows.length} row(s) copied`);
    }
    // explicit ids were inserted, so move every id counter past them
    for (const t of HAS_ID_SEQUENCE) {
      await client.query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${t}), 1), (SELECT COUNT(*) > 0 FROM ${t}))`);
    }
    await client.query('COMMIT');
    console.log('Import finished.');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw e;
  } finally {
    client.release();
    src.close();
  }
})().then(close).catch((e) => { console.error('Import failed:', e.message); process.exit(1); });
