'use strict';
// SQLite database (built into Node 22.13+, no extra install needed)
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'mosstech.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role       TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  pw_hash    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS products (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT NOT NULL,
  price     REAL NOT NULL CHECK (price >= 0),
  stock     INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  image_url TEXT NOT NULL DEFAULT 'pics/default.jpg',
  category  TEXT NOT NULL DEFAULT 'other',
  brand     TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS orders (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number     TEXT NOT NULL UNIQUE,
  user_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  customer_name    TEXT NOT NULL,
  customer_email   TEXT NOT NULL,
  customer_phone   TEXT NOT NULL,
  customer_address TEXT NOT NULL,
  payment_method   TEXT NOT NULL,
  total_amount     REAL NOT NULL,
  order_date       TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'Processing'
);
CREATE TABLE IF NOT EXISTS order_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER,
  name       TEXT NOT NULL,
  price      REAL NOT NULL,
  quantity   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_email ON orders(customer_email);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS email_verifications (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  tries      INTEGER NOT NULL DEFAULT 0,
  sent_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS totp_backup (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used      INTEGER NOT NULL DEFAULT 0
);
-- Failed-attempt counters / lockouts live in the database so a server restart does not clear them
CREATE TABLE IF NOT EXISTS lockouts (
  key       TEXT PRIMARY KEY,
  count     INTEGER NOT NULL DEFAULT 0,
  last_fail INTEGER NOT NULL,
  until     INTEGER NOT NULL DEFAULT 0
);
-- Security audit trail (logins, resets, admin actions). Never stores passwords, codes or tokens.
CREATE TABLE IF NOT EXISTS audit_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       INTEGER NOT NULL,
  user_id  INTEGER,
  username TEXT,
  action   TEXT NOT NULL,
  detail   TEXT NOT NULL DEFAULT '',
  ip       TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
`);

// Upgrade an existing database in place (adds new columns without losing data)
function addColumnIfMissing(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (cols.includes(column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  return true;
}
// Accounts that existed before email verification was added are treated as verified
if (addColumnIfMissing('users', 'email_verified', 'INTEGER NOT NULL DEFAULT 0')) db.exec('UPDATE users SET email_verified = 1');
// Discounts: a whole-number percentage per product. First upgrade also loads the starting deals.
if (addColumnIfMissing('products', 'discount_percent', 'INTEGER NOT NULL DEFAULT 0 CHECK (discount_percent BETWEEN 0 AND 90)')) {
  const { DEFAULT_DEALS } = require('./pricing');
  const setDeal = db.prepare('UPDATE products SET discount_percent = ? WHERE id = ?');
  for (const [id, pct] of Object.entries(DEFAULT_DEALS)) setDeal.run(pct, Number(id));
}
addColumnIfMissing('users', 'totp_secret', 'TEXT');
addColumnIfMissing('users', 'totp_enabled', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('users', 'totp_last_step', 'INTEGER NOT NULL DEFAULT 0');

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}
// Run fn() inside one all-or-nothing transaction
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { db, getSetting, setSetting, tx };
