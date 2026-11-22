'use strict';
// The tests WIPE the database they connect to, so they only run against TEST_DATABASE_URL and only when
// the database name contains "test". Example (a throwaway container):
//   docker run --rm -d --name mt-test -p 5433:5432 -e POSTGRES_PASSWORD=test -e POSTGRES_DB=mosstech_test postgres:17-alpine
//   $env:TEST_DATABASE_URL="postgres://postgres:test@localhost:5433/mosstech_test"; npm.cmd test
const url = process.env.TEST_DATABASE_URL;
if (!url) { console.error('Set TEST_DATABASE_URL to a throwaway PostgreSQL database (its name must contain "test"). See test/helpers.js.'); process.exit(1); }
let dbName = '';
try { dbName = decodeURIComponent(new URL(url).pathname.slice(1)); } catch (_) { /* handled below */ }
if (!/test/i.test(dbName)) { console.error(`Refusing to wipe "${dbName}": the database name must contain "test".`); process.exit(1); }
process.env.DATABASE_URL = url;

async function resetDatabase() {
  const { pool, waitForDb } = require('../server/db');
  const { migrate } = require('../server/migrate');
  await waitForDb({ retries: 5, delayMs: 500 });
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
}
module.exports = { resetDatabase, url };
