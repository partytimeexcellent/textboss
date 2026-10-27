// Make a practice copy of a live TextBoss from one of its backups, to work on
// (e.g. the Textable history review) without touching the clinic.
//
//   npm run clone:make -- path/to/textboss-backup.tar.gz [data-folder]
//   npm run clone:start
//
// The copy is cleaned so it can't reach anyone: texting provider, email and
// push-notification settings are removed, devices are unsubscribed, everyone
// is signed out, and running bulk sends are cancelled. clone:start also runs
// with TEXTBOSS_CLONE=1, which blocks texts, email and push even if
// credentials are added back.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { stageRestore, applyPendingRestore } from './backup.js';
import { scrubClone } from './clone.js';

const [backupFile, folder = 'clone-data'] = process.argv.slice(2);
if (!backupFile) {
  console.log('Usage: npm run clone:make -- path/to/textboss-backup.tar.gz [data-folder]');
  console.log('Download the backup from the live TextBoss under Admin settings → Backup.');
  process.exit(1);
}

const dataDir = path.resolve(folder);
if (dataDir === path.resolve(process.env.DATA_DIR || 'data')) {
  console.error(`Refusing to write the copy into ${dataDir}: that's this install's own data folder.`);
  process.exit(1);
}
fs.mkdirSync(dataDir, { recursive: true });

const manifest = stageRestore(fs.readFileSync(backupFile), dataDir);
applyPendingRestore(dataDir);

const db = new DatabaseSync(path.join(dataDir, 'textboss.db'));
const { removed, devices, broadcasts } = scrubClone(db);
db.prepare('DELETE FROM sessions').run();
db.prepare(`INSERT INTO settings (key, value) VALUES ('clone.madeAt', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(String(Date.now()));
db.close();

const c = manifest.counts ?? {};
console.log(`Practice copy made in ${dataDir} from the backup of ${manifest.createdAt}`);
console.log(`  ${c.users ?? '?'} users, ${c.conversations ?? '?'} conversations, ${c.messages ?? '?'} messages`);
console.log(`  Removed ${removed} provider/email/push settings and ${devices} notification devices; cancelled ${broadcasts} running bulk sends.`);
console.log('\nStart it with:  npm run clone:start   (http://localhost:3300)');
console.log('Sign in with your usual username and password. Passkeys only work on the live address;');
console.log('if you can\'t get past two-factor sign-in, run:');
console.log(`  DATA_DIR=${folder} node src/cli.js reset-2fa <username>`);
