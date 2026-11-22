'use strict';
// Checks that backups are real files and that old ones are deleted. Needs pg_dump; skipped if it is not installed.
const { spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
require('./helpers');
if (spawnSync('pg_dump', ['--version']).error) { console.log('BACKUP TESTS SKIPPED (pg_dump not installed on this machine)'); process.exit(0); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-backup-'));
process.env.BACKUP_DIR = dir;
process.env.BACKUP_KEEP = '2';
const { resetDatabase } = require('./helpers');
const { setSetting, close } = require('../server/db');
const B = require('../server/backup');

(async () => {
  await resetDatabase();
  await setSetting('backup_test', 'hello');
  const f = await B.backupNow();
  assert(fs.existsSync(f) && fs.statSync(f).size > 0, 'backup file exists');
  await B.backupNow(); await B.backupNow(); await B.backupNow();
  assert.strictEqual(B.list().length, 2, 'only the newest 2 backups are kept');
  console.log('BACKUP TESTS PASSED');
  fs.rmSync(dir, { recursive: true, force: true });
  await close(); process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
