'use strict';
// Checks that backups are real, restorable copies and that old ones are deleted.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-backup-'));
process.env.DB_PATH = path.join(dir, 'test.db');
process.env.BACKUP_KEEP = '2';
const { DatabaseSync } = require('node:sqlite');
const { db, setSetting, getSetting } = require('../server/db');
const B = require('../server/backup');

setSetting('backup_test', 'hello');
const f = B.backupNow();
assert(fs.existsSync(f), 'backup file exists');
const copy = new DatabaseSync(f);
const tables = (d) => d.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get().n;
assert.strictEqual(tables(copy), tables(db), 'same tables in the copy');
assert.strictEqual(copy.prepare("SELECT value FROM settings WHERE key='backup_test'").get().value, 'hello', 'data is in the copy');
copy.close();
B.backupNow(); B.backupNow(); B.backupNow();
assert.strictEqual(B.list().length, 2, 'only the newest 2 backups are kept');
console.log('BACKUP TESTS PASSED');
fs.rmSync(dir, { recursive: true, force: true });
process.exit(0);
