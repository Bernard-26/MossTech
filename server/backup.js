'use strict';
// Automatic database backups with pg_dump (custom format: compressed, restore with pg_restore).
// Files go to BACKUP_DIR (a Docker volume in docker-compose.yml) and old ones are deleted.
// pg_dump must exist in the container (the Dockerfile installs it). If it is missing, backups are skipped
// and you can still back up from the host: see DOCKER.md.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const DIR = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');
const KEEP = Math.max(1, Number(process.env.BACKUP_KEEP) || 7);
const EVERY_HOURS = process.env.BACKUP_EVERY_HOURS === undefined ? 24 : Number(process.env.BACKUP_EVERY_HOURS);
const NAME = /^mosstech-.+\.dump$/;

function list() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).filter((f) => NAME.test(f)).sort();
}

function connectionArgs() {
  if (process.env.DATABASE_URL) return { args: ['--dbname', process.env.DATABASE_URL], env: {} };
  return {
    args: [],
    env: {
      PGHOST: process.env.DB_HOST || 'localhost', PGPORT: String(process.env.DB_PORT || 5432),
      PGDATABASE: process.env.DB_NAME || 'mosstech', PGUSER: process.env.DB_USER || 'mosstech',
      ...(process.env.DB_PASSWORD ? { PGPASSWORD: process.env.DB_PASSWORD } : {})
    }
  };
}

function runPgDump(file) {
  return new Promise((resolve, reject) => {
    const { args, env } = connectionArgs();
    const child = spawn('pg_dump', ['--format=custom', '--no-owner', '--file', file, ...args], { env: { ...process.env, ...env } });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      if (e.code === 'ENOENT') { const x = new Error('pg_dump is not installed'); x.code = 'NO_PG_DUMP'; return reject(x); }
      reject(e);
    });
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`pg_dump failed (${code}): ${err.trim().slice(-300)}`)));
  });
}

async function backupNow() {
  fs.mkdirSync(DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(DIR, `mosstech-${stamp}-${crypto.randomBytes(2).toString('hex')}.dump`);
  try { await runPgDump(file); } catch (e) { fs.rmSync(file, { force: true }); throw e; }
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
  let timer;
  const check = async () => {
    try { if (dueNow()) console.log('Backup saved:', path.basename(await backupNow())); }
    catch (e) {
      console.error('Backup failed:', e.message);
      if (e.code === 'NO_PG_DUMP') clearInterval(timer);   // no point trying again every hour
    }
  };
  setTimeout(check, 60 * 1000).unref();            // one minute after start
  timer = setInterval(check, 60 * 60 * 1000);      // then check every hour
  timer.unref();
}

module.exports = { backupNow, schedule, list, DIR };
if (require.main === module) {
  backupNow().then((f) => { console.log('Backup saved:', f); }).catch((e) => { console.error(e.message); process.exit(1); });
}
