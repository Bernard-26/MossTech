'use strict';
// PostgreSQL access layer (node-postgres). Every call is async: always `await` it.
//
// Connection settings come from the environment:
//   DATABASE_URL                       postgres://user:pass@host:5432/dbname   (wins if set; URL-encode odd characters in the password)
//   or DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD
//   DB_SSL=1                           use TLS (managed databases); DB_SSL_REJECT_UNAUTHORIZED=0 only for self-signed certs
//   DB_POOL_MAX, DB_CONNECT_TIMEOUT_MS
//   DB_CONNECT_RETRIES, DB_CONNECT_DELAY_MS   how long waitForDb() keeps trying at startup
const { Pool, types } = require('pg');

// pg returns BIGINT and NUMERIC as strings by default. This app only stores values that fit safely in a
// JS number (millisecond timestamps, prices with 2 decimals, row counts), so hand them back as numbers.
types.setTypeParser(20, (v) => Number(v));     // int8 / bigint (also COUNT(*))
types.setTypeParser(1700, (v) => Number(v));   // numeric

function sslOption() {
  const mode = String(process.env.DB_SSL || '').toLowerCase();
  if (!mode || ['0', 'false', 'off', 'disable'].includes(mode)) return undefined;
  return { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== '0' };
}

function poolConfig() {
  const common = {
    max: Number(process.env.DB_POOL_MAX) || 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS) || 5000,
    application_name: 'mosstech',
    ssl: sslOption()
  };
  if (process.env.DATABASE_URL) return { ...common, connectionString: process.env.DATABASE_URL };
  return {
    ...common,
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'mosstech',
    user: process.env.DB_USER || 'mosstech',
    password: process.env.DB_PASSWORD
  };
}

const pool = new Pool(poolConfig());
// Without this listener a dropped idle connection (database restart) would crash the whole process.
pool.on('error', (err) => console.error('PostgreSQL idle client error:', err.message));

// Same small API for the pool and for a transaction client.
const api = (executor) => ({
  query: (text, params) => executor.query(text, params),
  async all(text, params) { return (await executor.query(text, params)).rows; },
  async one(text, params) { return (await executor.query(text, params)).rows[0] || null; },
  async run(text, params) { const r = await executor.query(text, params); return { rowCount: r.rowCount, rows: r.rows }; }
});
const db = api(pool);

// Run fn(t) inside one all-or-nothing transaction. Use t.one / t.all / t.run for every query inside it.
async function tx(fn) {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    const result = await fn(api(client));
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { broken = true; }   // connection is dead: do not reuse it
    throw e;
  } finally {
    client.release(broken);
  }
}

async function getSetting(key, fallback = null) {
  const row = await db.one('SELECT value FROM settings WHERE key = $1', [key]);
  return row ? row.value : fallback;
}
async function setSetting(key, value) {
  await db.run('INSERT INTO settings(key, value) VALUES($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, String(value)]);
}

// Wait for PostgreSQL to accept connections (it can take a few seconds after `docker compose up`).
// Retries with a growing delay; gives up at once for errors that waiting cannot fix.
const FATAL = { '28P01': 'wrong database user or password', '28000': 'database user is not allowed to connect', '3D000': 'that database does not exist' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForDb({ retries = Number(process.env.DB_CONNECT_RETRIES) || 30, delayMs = Number(process.env.DB_CONNECT_DELAY_MS) || 2000 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query('SELECT 1');
      if (attempt > 1) console.log(`PostgreSQL is reachable (attempt ${attempt}).`);
      return;
    } catch (e) {
      if (FATAL[e.code]) throw new Error(`PostgreSQL refused the connection: ${FATAL[e.code]} (${e.message})`);
      if (attempt >= retries) throw new Error(`Could not connect to PostgreSQL after ${attempt} attempts: ${e.message}`);
      const wait = Math.min(delayMs * Math.pow(1.5, attempt - 1), 10000);
      console.warn(`PostgreSQL not ready (attempt ${attempt}/${retries}): ${e.message || e.code}. Retrying in ${Math.round(wait / 1000)}s...`);
      await sleep(wait);
    }
  }
}

const close = () => pool.end();

module.exports = { db, pool, tx, getSetting, setSetting, waitForDb, close };
