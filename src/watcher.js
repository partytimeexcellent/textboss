// Watched folder: any .xls/.xlsx/.csv dropped into IMPORT_DIR is imported as
// contacts, then moved to processed/ or failed/. Polling (not fs.watch) so it
// works on Docker bind mounts and network shares.

import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { parseContactFile, upsertContacts, logImport } from './contacts.js';
import { publish } from './events.js';
import { allUserIds } from './db.js';

const EXTENSIONS = /\.(xlsx?|csv)$/i;
const POLL_MS = 30_000;
const lastSize = new Map(); // a file is imported once its size is stable across two polls

function move(file, sub) {
  const dir = path.join(config.importDir, sub);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.renameSync(file, path.join(dir, `${stamp}-${path.basename(file)}`));
}

function poll() {
  let names;
  try {
    names = fs.readdirSync(config.importDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!EXTENSIONS.test(name) || name.startsWith('.') || name.startsWith('~$')) continue;
    const file = path.join(config.importDir, name);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (lastSize.get(file) !== stat.size) {
      lastSize.set(file, stat.size);
      continue;
    }
    lastSize.delete(file);

    try {
      const { records } = parseContactFile(fs.readFileSync(file));
      const result = upsertContacts(records);
      logImport('folder', name, result);
      move(file, 'processed');
      console.log(`Imported ${name}: ${result.created} new, ${result.updated} updated, ${result.skipped} skipped`);
      publish(allUserIds(), 'contacts', {});
    } catch (err) {
      logImport('folder', name, null, err.message);
      console.warn(`Import of ${name} failed: ${err.message}`);
      try {
        move(file, 'failed');
      } catch {}
    }
  }
}

export function startWatcher() {
  fs.mkdirSync(config.importDir, { recursive: true });
  console.log(`Watching ${config.importDir} for contact files`);
  setInterval(poll, POLL_MS).unref();
  poll();
}
