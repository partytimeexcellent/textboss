// Backup and restore, for moving TextBoss to another server.
//
// A backup is a .tar.gz holding manifest.json, textboss.db (a consistent
// snapshot made with VACUUM INTO) and media/* (uploaded attachments).
// A restore is unpacked into DATA_DIR/restore-pending and swapped in by
// applyPendingRestore() at the next startup, before the database is opened.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';

const DB_FILE = 'textboss.db';
const MEDIA_NAME = /^[0-9a-f]{32}\.[a-z0-9]{2,4}$/;
const ICON_NAME = /^[0-9a-f]{16}-(180|192|512|maskable)\.png$/;

// ---------- tar (ustar) ----------

function tarHeader(name, size, mtime) {
  const buf = Buffer.alloc(512);
  const put = (str, offset, len) => buf.write(str, offset, len, 'utf8');
  const octal = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0';
  put(name, 0, 100);
  put(octal(0o644, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(size, 12), 124, 12);
  put(octal(Math.floor(mtime / 1000), 12), 136, 12);
  put('        ', 148, 8); // checksum is computed with spaces here
  put('0', 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  let sum = 0;
  for (const b of buf) sum += b;
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return buf;
}

const pad = (size) => Buffer.alloc((512 - (size % 512)) % 512);

function* tarEntries(entries) {
  for (const { name, data, file, mtime = Date.now() } of entries) {
    const body = data ?? fs.readFileSync(file);
    yield tarHeader(name, body.length, mtime);
    yield body;
    yield pad(body.length);
  }
  yield Buffer.alloc(1024);
}

function parseTar(buf) {
  const files = new Map();
  let off = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const str = (s, l) => header.subarray(s, s + l).toString('utf8').replace(/\0.*$/s, '');
    const prefix = str(345, 155);
    const name = (prefix ? `${prefix}/` : '') + str(0, 100);
    const size = parseInt(str(124, 12).trim() || '0', 8);
    const type = str(156, 1) || '0';
    off += 512;
    if (type === '0') files.set(name.replace(/^\.\//, ''), buf.subarray(off, off + size));
    off += size + ((512 - (size % 512)) % 512);
  }
  return files;
}

// ---------- Export ----------

export function backupStream(db, dataDir, meta) {
  const tmp = path.join(os.tmpdir(), `textboss-backup-${process.pid}-${Date.now()}.db`);
  db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);

  const mediaDir = path.join(dataDir, 'media');
  const media = fs.existsSync(mediaDir) ? fs.readdirSync(mediaDir).filter((n) => MEDIA_NAME.test(n)) : [];
  const iconDir = path.join(dataDir, 'icons');
  const icons = fs.existsSync(iconDir) ? fs.readdirSync(iconDir).filter((n) => ICON_NAME.test(n)) : [];
  const manifest = { app: 'textboss', format: 1, createdAt: new Date().toISOString(), mediaFiles: media.length, ...meta };

  const entries = [
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) },
    { name: DB_FILE, file: tmp },
    ...media.map((n) => ({ name: `media/${n}`, file: path.join(mediaDir, n), mtime: fs.statSync(path.join(mediaDir, n)).mtimeMs })),
    ...icons.map((n) => ({ name: `icons/${n}`, file: path.join(iconDir, n) })),
  ];
  const stream = Readable.from(tarEntries(entries)).pipe(zlib.createGzip());
  const cleanup = () => fs.rm(tmp, { force: true }, () => {});
  stream.on('end', cleanup);
  stream.on('error', cleanup);
  stream.on('close', cleanup);
  return stream;
}

// ---------- Restore ----------

// Checks the upload and writes it to DATA_DIR/restore-pending. Throws with a
// readable message if it is not a TextBoss backup.
export function stageRestore(upload, dataDir) {
  let tar;
  try {
    tar = zlib.gunzipSync(upload, { maxOutputLength: 4 * 1024 ** 3 });
  } catch {
    throw new Error('That file is not a TextBoss backup (.tar.gz)');
  }
  const files = parseTar(tar);
  let manifest;
  try {
    manifest = JSON.parse(files.get('manifest.json')?.toString() ?? '');
  } catch {}
  if (manifest?.app !== 'textboss' || !files.has(DB_FILE)) throw new Error('That file is not a TextBoss backup');

  const pending = path.join(dataDir, 'restore-pending');
  fs.rmSync(pending, { recursive: true, force: true });
  fs.mkdirSync(path.join(pending, 'media'), { recursive: true });
  fs.mkdirSync(path.join(pending, 'icons'), { recursive: true });
  fs.writeFileSync(path.join(pending, DB_FILE), files.get(DB_FILE));

  // Make sure the database inside actually opens and looks like ours
  try {
    const check = new DatabaseSync(path.join(pending, DB_FILE), { readOnly: true });
    const ok = check.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('users', 'messages', 'conversations')`).get().n === 3;
    const counts = ok
      ? {
          users: check.prepare('SELECT COUNT(*) AS n FROM users').get().n,
          conversations: check.prepare('SELECT COUNT(*) AS n FROM conversations').get().n,
          messages: check.prepare('SELECT COUNT(*) AS n FROM messages').get().n,
        }
      : null;
    check.close();
    if (!ok) throw new Error('missing tables');
    manifest.counts = counts;
  } catch {
    fs.rmSync(pending, { recursive: true, force: true });
    throw new Error('The database in that backup is damaged or not from TextBoss');
  }

  let mediaCount = 0;
  for (const [name, data] of files) {
    const m = /^media\/(.+)$/.exec(name);
    if (m && MEDIA_NAME.test(m[1])) {
      fs.writeFileSync(path.join(pending, 'media', m[1]), data);
      mediaCount++;
    }
    const icon = /^icons\/(.+)$/.exec(name);
    if (icon && ICON_NAME.test(icon[1])) fs.writeFileSync(path.join(pending, 'icons', icon[1]), data);
  }
  manifest.mediaRestored = mediaCount;
  fs.writeFileSync(path.join(pending, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

// Runs at startup before the database opens. The data being replaced is moved
// to DATA_DIR/pre-restore-<time> rather than deleted.
export function applyPendingRestore(dataDir) {
  const pending = path.join(dataDir, 'restore-pending');
  if (!fs.existsSync(path.join(pending, DB_FILE))) return;

  const keep = path.join(dataDir, `pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(keep, { recursive: true });
  for (const name of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`, 'media', 'icons']) {
    const from = path.join(dataDir, name);
    if (fs.existsSync(from)) fs.renameSync(from, path.join(keep, name));
  }
  fs.renameSync(path.join(pending, DB_FILE), path.join(dataDir, DB_FILE));
  fs.renameSync(path.join(pending, 'media'), path.join(dataDir, 'media'));
  if (fs.existsSync(path.join(pending, 'icons'))) fs.renameSync(path.join(pending, 'icons'), path.join(dataDir, 'icons'));
  fs.rmSync(pending, { recursive: true, force: true });
  console.log(`Restored backup. The previous data was moved to ${keep}`);
}
