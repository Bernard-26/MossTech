'use strict';
// Applies db/migrations/*.sql in order, once each (tracked in the schema_migrations table).
// Safe to run on every start and from several containers at once (a PostgreSQL advisory lock serialises them).
//   npm run migrate
const fs = require('fs');
const path = require('path');
const { pool, waitForDb, close } = require('./db');

const DIR = path.join(__dirname, '..', 'db', 'migrations');
const LOCK_ID = 727274; // arbitrary constant shared by every MOSSTECH instance

async function migrate() {
  const files = fs.readdirSync(DIR).filter((f) => /^\d+.*\.sql$/.test(f)).sort();
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const done = new Set((await client.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
    let applied = 0;
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(DIR, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(version) VALUES($1)', [file]);
        await client.query('COMMIT');
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) { /* connection already gone */ }
        throw new Error(`Migration ${file} failed: ${e.message}`);
      }
      console.log('Applied migration', file);
      applied++;
    }
    return applied;
  } finally {
    try { await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]); } catch (_) { /* ignore */ }
    client.release();
  }
}

module.exports = { migrate };

if (require.main === module) {
  waitForDb()
    .then(migrate)
    .then((n) => { console.log(n ? `Database schema is up to date (${n} migration(s) applied).` : 'Database schema is already up to date.'); return close(); })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
