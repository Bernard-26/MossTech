'use strict';
// Automatic database backups. Copies are written next to the database (on the same
// persistent disk) and old ones are deleted. Admins can also download a fresh copy.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db } = require('./db');

const DB_FILE = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'mosstech.db');
const DIR = process.env.BACKUP_DIR || path.join(path.dirname(DB_FILE), 'backups');
const KEEP = Math.max(1, Number(process.env.BACKUP_KEEP) || 7);
const EVERY_HOURS = process.env.BACKUP_EVERY_HOURS === undefined ? 24 : Number(process.env.BACKUP_EVERY_HOURS);
const NAME = /^mosstech-.+\.db$/;

function list() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).filter((f) => NAME.test(f)).sort();
}

function backupNow() {
  fs.mkdirSync(DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(DIR, `mosstech-${stamp}-${crypto.randomBytes(2).toString('hex')}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`); // consistent snapshot, safe while the app runs
  const files = list();
  while (files.length > KEEP) fs.unlinkSync(path.join(DIR, files.shift()));
  return file;
}

function dueNow() {
  const files = list();
  if (!files.length) return true;
  const age = Date.now() - fs.statSync(path.join(DIR, files[files.length - 1])).mtimeMs;
  return age >= EVERY_HOURS * 3600 * 1000;
}

function schedule() {
  if (!(EVERY_HOURS > 0)) return; // BACKUP_EVERY_HOURS=0 turns it off
  const check = () => { try { if (dueNow()) console.log('Backup saved:', path.basename(backupNow())); } catch (e) { console.error('Backup failed:', e.message); } };
  setTimeout(check, 60 * 1000).unref();            // one minute after start
  setInterval(check, 60 * 60 * 1000).unref();      // then check every hour
}

module.exports = { backupNow, schedule, list, DIR };
if (require.main === module) console.log('Backup saved:', backupNow());
