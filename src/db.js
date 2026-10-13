import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });

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

  -- Shared address book
  CREATE TABLE IF NOT EXISTS contacts (
    phone TEXT PRIMARY KEY,
    name  TEXT NOT NULL
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
    sentBy: row.sent_by_name ?? null,
    createdAt: row.created_at,
  };
}
