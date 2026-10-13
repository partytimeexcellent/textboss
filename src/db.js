import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { applyPendingRestore } from './backup.js';

fs.mkdirSync(config.dataDir, { recursive: true });
applyPendingRestore(config.dataDir);

export const db = new DatabaseSync(path.join(config.dataDir, 'textboss.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name  TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin      INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );

  -- Phone numbers owned in BulkVS that this app sends and receives on
  CREATE TABLE IF NOT EXISTS numbers (
    id         INTEGER PRIMARY KEY,
    phone      TEXT NOT NULL UNIQUE,
    label      TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );

  -- Which users can see and send from which numbers
  CREATE TABLE IF NOT EXISTS user_numbers (
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    number_id INTEGER NOT NULL REFERENCES numbers(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, number_id)
  );

  -- A conversation is one of our numbers plus the set of other participants
  -- (one phone for a 1:1 thread, several for a group MMS).
  CREATE TABLE IF NOT EXISTS conversations (
    id              INTEGER PRIMARY KEY,
    number_id       INTEGER NOT NULL REFERENCES numbers(id) ON DELETE CASCADE,
    participants    TEXT NOT NULL,
    last_message_at INTEGER NOT NULL DEFAULT 0,
    archived        INTEGER NOT NULL DEFAULT 0,
    UNIQUE (number_id, participants)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    direction       TEXT NOT NULL CHECK (direction IN ('in', 'out')),
    from_phone      TEXT NOT NULL,
    body            TEXT NOT NULL DEFAULT '',
    media           TEXT NOT NULL DEFAULT '[]',
    status          TEXT NOT NULL DEFAULT 'received',
    error           TEXT,
    ref_id          TEXT,
    sent_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at      INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_conv ON messages(conversation_id, id);
  CREATE INDEX IF NOT EXISTS messages_ref ON messages(ref_id);

  -- Per-user read position in each conversation
  CREATE TABLE IF NOT EXISTS reads (
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    last_read_id    INTEGER NOT NULL,
    PRIMARY KEY (user_id, conversation_id)
  );

  -- Raw webhook bodies, kept so payload parsing can be checked and fixed
  CREATE TABLE IF NOT EXISTS webhook_log (
    id          INTEGER PRIMARY KEY,
    received_at INTEGER NOT NULL,
    body        TEXT NOT NULL,
    result      TEXT
  );
`);

// v1 had a phone -> name address book. Convert it to full contacts.
const contactCols = db.prepare('PRAGMA table_info(contacts)').all().map((c) => c.name);
if (contactCols.includes('name') && !contactCols.includes('first_name')) {
  db.exec('ALTER TABLE contacts RENAME TO contacts_v1');
}

db.exec(`
  -- Several contacts can share a phone (e.g. a parent and children)
  CREATE TABLE IF NOT EXISTS contacts (
    id         INTEGER PRIMARY KEY,
    first_name TEXT NOT NULL DEFAULT '',
    last_name  TEXT NOT NULL DEFAULT '',
    phone      TEXT NOT NULL DEFAULT '',
    dob        TEXT NOT NULL DEFAULT '',
    email      TEXT NOT NULL DEFAULT '',
    patient_id TEXT NOT NULL DEFAULT '',
    notes      TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS contacts_phone ON contacts(phone);
  CREATE INDEX IF NOT EXISTS contacts_patient ON contacts(patient_id);
  CREATE INDEX IF NOT EXISTS contacts_name ON contacts(last_name COLLATE NOCASE, first_name COLLATE NOCASE);

  -- Opt-out is per phone number: STOP from a phone covers every contact on it
  CREATE TABLE IF NOT EXISTS opt_outs (
    phone      TEXT PRIMARY KEY,
    source     TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  -- Inbound texts from these numbers are dropped
  CREATE TABLE IF NOT EXISTS blocked (
    phone      TEXT PRIMARY KEY,
    blocked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS lists (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS list_members (
    list_id    INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    PRIMARY KEY (list_id, contact_id)
  );

  CREATE TABLE IF NOT EXISTS canned_responses (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    body       TEXT NOT NULL,
    media      TEXT NOT NULL DEFAULT '[]',
    keyword    TEXT NOT NULL DEFAULT '',
    is_away    INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  -- Bulk sends: one row per run, one item per recipient phone
  CREATE TABLE IF NOT EXISTS broadcasts (
    id         INTEGER PRIMARY KEY,
    number_id  INTEGER NOT NULL REFERENCES numbers(id) ON DELETE CASCADE,
    body       TEXT NOT NULL,
    media      TEXT NOT NULL DEFAULT '[]',
    status     TEXT NOT NULL DEFAULT 'running',
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS broadcast_items (
    id           INTEGER PRIMARY KEY,
    broadcast_id INTEGER NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
    phone        TEXT NOT NULL,
    body         TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending',
    error        TEXT
  );

  -- Keys for the contact import API (only a hash is stored)
  CREATE TABLE IF NOT EXISTS api_keys (
    id           INTEGER PRIMARY KEY,
    name         TEXT NOT NULL,
    prefix       TEXT NOT NULL,
    key_hash     TEXT NOT NULL UNIQUE,
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS import_log (
    id         INTEGER PRIMARY KEY,
    source     TEXT NOT NULL,
    filename   TEXT,
    created    INTEGER NOT NULL DEFAULT 0,
    updated    INTEGER NOT NULL DEFAULT 0,
    skipped    INTEGER NOT NULL DEFAULT 0,
    error      TEXT,
    created_at INTEGER NOT NULL
  );

  -- Last automatic away reply per conversation, to avoid repeating it
  CREATE TABLE IF NOT EXISTS away_sent (
    conversation_id INTEGER PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
    sent_at         INTEGER NOT NULL
  );
`);

// Columns added after the first release
function addColumn(table, column, definition) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
addColumn('messages', 'kind', 'TEXT'); // 'auto' = keyword/away reply, 'bulk' = broadcast
addColumn('conversations', 'pinned', 'INTEGER NOT NULL DEFAULT 0');
addColumn('conversations', 'flagged', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'theme', 'TEXT');
addColumn('import_log', 'issues', 'INTEGER NOT NULL DEFAULT 0');

db.exec(`
  -- Admin-editable settings (e.g. BulkVS credentials); these override .env
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

export function getSetting(key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
}

export function setSetting(key, value) {
  if (value == null || value === '') db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  else db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
}

if (contactCols.includes('name') && !contactCols.includes('first_name')) {
  const now = Date.now();
  const ins = db.prepare(
    'INSERT INTO contacts (first_name, last_name, phone, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  );
  for (const { phone, name } of db.prepare('SELECT phone, name FROM contacts_v1').all()) {
    const [first, ...rest] = name.trim().split(/\s+/);
    ins.run(first ?? '', rest.join(' '), phone, now, now);
  }
  db.exec('DROP TABLE contacts_v1');
}

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getOrCreateConversation(numberId, participants) {
  db.prepare(
    'INSERT OR IGNORE INTO conversations (number_id, participants) VALUES (?, ?)',
  ).run(numberId, participants);
  return db
    .prepare('SELECT * FROM conversations WHERE number_id = ? AND participants = ?')
    .get(numberId, participants);
}

export function userNumberIds(user) {
  if (user.is_admin) return db.prepare('SELECT id FROM numbers').all().map((r) => r.id);
  return db
    .prepare('SELECT number_id FROM user_numbers WHERE user_id = ?')
    .all(user.id)
    .map((r) => r.number_id);
}

export function userCanAccessNumber(user, numberId) {
  if (user.is_admin) return true;
  return !!db
    .prepare('SELECT 1 FROM user_numbers WHERE user_id = ? AND number_id = ?')
    .get(user.id, numberId);
}

// Users who should be notified about activity on a number
export function userIdsForNumber(numberId) {
  return db
    .prepare(
      `SELECT id FROM users WHERE is_admin = 1
       UNION SELECT user_id FROM user_numbers WHERE number_id = ?`,
    )
    .all(numberId)
    .map((r) => r.id);
}

export function allUserIds() {
  return db.prepare('SELECT id FROM users').all().map((u) => u.id);
}

export function isOptedOut(phone) {
  return !!db.prepare('SELECT 1 FROM opt_outs WHERE phone = ?').get(phone);
}

export function isBlocked(phone) {
  return !!db.prepare('SELECT 1 FROM blocked WHERE phone = ?').get(phone);
}

export function serializeMessage(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    direction: row.direction,
    from: row.from_phone,
    body: row.body,
    media: JSON.parse(row.media),
    status: row.status,
    error: row.error,
    sentBy: row.kind === 'auto' ? 'Auto-reply' : row.sent_by_name ?? null,
    kind: row.kind ?? null,
    createdAt: row.created_at,
  };
}
