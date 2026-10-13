import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config, mockMode } from './config.js';
import {
  db,
  getOrCreateConversation,
  userNumberIds,
  userCanAccessNumber,
} from './db.js';
import {
  loadUser,
  requireUser,
  requireAdmin,
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
} from './auth.js';
import { subscribe, publish } from './events.js';
import { normalizePhone, isValidPhone, participantsKey } from './phone.js';
import { parseWebhook } from './bulkvs.js';
import { recordInbound, sendOutbound, applyReceipt, listMessages } from './messaging.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const mediaDir = path.join(config.dataDir, 'media');
fs.mkdirSync(mediaDir, { recursive: true });

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new HttpError(status, message);
};

// ---------- Inbound webhook (no session; protected by the secret path) ----------

app.post(
  '/webhook/bulkvs/:secret',
  express.json({ limit: '1mb' }),
  express.urlencoded({ extended: true, limit: '1mb' }),
  (req, res) => {
    const secret = Buffer.from(req.params.secret);
    const expected = Buffer.from(config.webhookSecret);
    if (!config.webhookSecret || secret.length !== expected.length || !crypto.timingSafeEqual(secret, expected)) {
      return res.sendStatus(404);
    }

    const raw = JSON.stringify(req.body ?? {});
    let result;
    try {
      const event = parseWebhook(req.body);
      if (!event) result = { ok: false, reason: 'unrecognized payload' };
      else if (event.kind === 'message') result = recordInbound(event);
      else result = applyReceipt(event);
    } catch (err) {
      result = { ok: false, reason: err.message };
    }
    db.prepare('INSERT INTO webhook_log (received_at, body, result) VALUES (?, ?, ?)').run(
      Date.now(),
      raw,
      JSON.stringify(result),
    );
    db.prepare('DELETE FROM webhook_log WHERE id <= (SELECT MAX(id) - 500 FROM webhook_log)').run();
    if (!result.ok) console.warn('webhook not applied:', result.reason, raw.slice(0, 500));
    // Always 200 so BulkVS does not keep retrying a payload we cannot use
    res.json({ ok: true });
  },
);

// ---------- Public media (MMS attachments must be fetchable by carriers) ----------

app.use(
  '/media',
  express.static(mediaDir, { fallthrough: false, maxAge: '365d', immutable: true }),
);

// ---------- App ----------

app.use(express.json({ limit: '1mb' }));
app.use(loadUser);
// no-cache = revalidate each load, so browsers pick up new app code after a deploy
app.use(express.static(path.join(root, 'public'), { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

const api = express.Router();
app.use('/api', api);

// First-run setup: create the initial admin when there are no users yet
api.get('/setup', (_req, res) => {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  res.json({ needed: n === 0, mockMode });
});

api.post('/setup', (req, res) => {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  if (n > 0) fail(409, 'Setup is already done');
  const { username, password, displayName } = req.body ?? {};
  validateNewUser(username, password);
  const { lastInsertRowid } = db
    .prepare(
      'INSERT INTO users (username, display_name, password_hash, is_admin, created_at) VALUES (?, ?, ?, 1, ?)',
    )
    .run(username.trim(), (displayName || username).trim(), hashPassword(password), Date.now());
  createSession(res, Number(lastInsertRowid));
  res.json({ ok: true });
});

api.post('/login', (req, res) => {
  const { username, password } = req.body ?? {};
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username ?? '').trim());
  if (!user || !verifyPassword(String(password ?? ''), user.password_hash)) {
    fail(401, 'Wrong username or password');
  }
  createSession(res, user.id);
  res.json({ ok: true });
});

api.post('/logout', (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});

api.use(requireUser);

api.get('/me', (req, res) => {
  const ids = userNumberIds(req.user);
  const numbers = ids.length
    ? db
        .prepare(`SELECT id, phone, label FROM numbers WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY label, phone`)
        .all(...ids)
    : [];
  res.json({
    user: {
      id: req.user.id,
      username: req.user.username,
      displayName: req.user.display_name,
      isAdmin: req.user.is_admin,
    },
    numbers,
    mockMode,
  });
});

api.post('/me/password', (req, res) => {
  const { current, next } = req.body ?? {};
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(String(current ?? ''), row.password_hash)) fail(400, 'Current password is wrong');
  if (!next || String(next).length < 8) fail(400, 'New password must be at least 8 characters');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), req.user.id);
  res.json({ ok: true });
});

api.get('/events', subscribe);

// ----- Conversations -----

function loadConversation(req) {
  const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(Number(req.params.id));
  if (!conversation || !userCanAccessNumber(req.user, conversation.number_id)) {
    fail(404, 'Conversation not found');
  }
  return conversation;
}

api.get('/conversations', (req, res) => {
  let ids = userNumberIds(req.user);
  if (req.query.numberId) {
    const wanted = Number(req.query.numberId);
    ids = ids.filter((id) => id === wanted);
  }
  if (!ids.length) return res.json([]);

  const params = [req.user.id, ...ids];
  let where = `c.number_id IN (${ids.map(() => '?').join(',')}) AND c.archived = ?`;
  params.push(req.query.archived === '1' ? 1 : 0);

  const q = String(req.query.q ?? '').trim();
  if (q) {
    const digits = q.replace(/\D/g, '');
    where += ` AND (
      EXISTS (SELECT 1 FROM messages m2 WHERE m2.conversation_id = c.id AND m2.body LIKE ?)
      OR EXISTS (SELECT 1 FROM contacts ct WHERE ct.name LIKE ? AND (',' || c.participants || ',') LIKE ('%,' || ct.phone || ',%'))
      ${digits.length >= 3 ? 'OR c.participants LIKE ?' : ''}
    )`;
    params.push(`%${q}%`, `%${q}%`);
    if (digits.length >= 3) params.push(`%${digits}%`);
  }

  const rows = db
    .prepare(
      `SELECT c.id, c.number_id, c.participants, c.last_message_at, c.archived,
         lm.body AS last_body, lm.direction AS last_direction, lm.media AS last_media, lm.status AS last_status,
         (SELECT COUNT(*) FROM messages mu
            WHERE mu.conversation_id = c.id AND mu.direction = 'in'
              AND mu.id > COALESCE((SELECT last_read_id FROM reads r WHERE r.user_id = ? AND r.conversation_id = c.id), 0)
         ) AS unread
       FROM conversations c
       LEFT JOIN messages lm ON lm.id = (SELECT MAX(id) FROM messages WHERE conversation_id = c.id)
       WHERE ${where}
       ORDER BY c.last_message_at DESC
       LIMIT 200`,
    )
    .all(...params);

  res.json(
    rows.map((r) => ({
      id: r.id,
      numberId: r.number_id,
      participants: r.participants.split(','),
      lastMessageAt: r.last_message_at,
      archived: !!r.archived,
      unread: r.unread,
      last: r.last_body == null
        ? null
        : {
            body: r.last_body,
            direction: r.last_direction,
            hasMedia: JSON.parse(r.last_media).length > 0,
            status: r.last_status,
          },
    })),
  );
});

api.post('/conversations', (req, res) => {
  const numberId = Number(req.body?.numberId);
  if (!userCanAccessNumber(req.user, numberId) || !db.prepare('SELECT 1 FROM numbers WHERE id = ?').get(numberId)) {
    fail(403, 'You cannot send from that number');
  }
  const to = (Array.isArray(req.body?.to) ? req.body.to : [req.body?.to]).filter(Boolean);
  if (!to.length) fail(400, 'Enter at least one recipient');
  const bad = to.filter((p) => !isValidPhone(p));
  if (bad.length) fail(400, `Not a valid phone number: ${bad.join(', ')}`);
  if (to.length > 10) fail(400, 'Group messages are limited to 10 recipients');

  const conversation = getOrCreateConversation(numberId, participantsKey(to));
  res.json({ id: conversation.id });
});

api.get('/conversations/:id', (req, res) => {
  const c = loadConversation(req);
  res.json({ id: c.id, numberId: c.number_id, participants: c.participants.split(','), archived: !!c.archived });
});

api.get('/conversations/:id/messages', (req, res) => {
  const c = loadConversation(req);
  const before = req.query.before ? Number(req.query.before) : undefined;
  res.json(listMessages(c.id, before));
});

api.post('/conversations/:id/messages', async (req, res) => {
  const conversation = loadConversation(req);
  const body = String(req.body?.body ?? '').trim();
  const media = (Array.isArray(req.body?.media) ? req.body.media : []).map(String);
  if (!body && !media.length) fail(400, 'Message is empty');
  if (body.length > 1600) fail(400, 'Message is too long (1600 characters max)');
  if (media.some((url) => !url.startsWith(`${config.publicUrl}/media/`))) fail(400, 'Attachments must be uploaded first');

  const number = db.prepare('SELECT * FROM numbers WHERE id = ?').get(conversation.number_id);
  const message = await sendOutbound({ conversation, number, user: req.user, body, media });
  res.json(message);
});

api.post('/conversations/:id/read', (req, res) => {
  const c = loadConversation(req);
  const { max } = db.prepare('SELECT MAX(id) AS max FROM messages WHERE conversation_id = ?').get(c.id);
  db.prepare(
    `INSERT INTO reads (user_id, conversation_id, last_read_id) VALUES (?, ?, ?)
     ON CONFLICT (user_id, conversation_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)`,
  ).run(req.user.id, c.id, max ?? 0);
  publish([req.user.id], 'read', { conversationId: c.id });
  res.json({ ok: true });
});

api.post('/conversations/:id/archive', (req, res) => {
  const c = loadConversation(req);
  db.prepare('UPDATE conversations SET archived = ? WHERE id = ?').run(req.body?.archived ? 1 : 0, c.id);
  res.json({ ok: true });
});

// ----- Attachments -----

const MEDIA_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'application/pdf': 'pdf',
  'text/vcard': 'vcf',
};

api.post('/upload', express.raw({ type: () => true, limit: '5mb' }), (req, res) => {
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  const ext = MEDIA_TYPES[type];
  if (!ext) fail(415, `Unsupported attachment type: ${type || 'unknown'}`);
  if (!req.body?.length) fail(400, 'Empty file');
  const name = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(mediaDir, name), req.body);
  res.json({ url: `${config.publicUrl}/media/${name}`, type });
});

// ----- Contacts (shared by all users) -----

api.get('/contacts', (_req, res) => {
  res.json(db.prepare('SELECT phone, name FROM contacts ORDER BY name COLLATE NOCASE').all());
});

api.put('/contacts/:phone', (req, res) => {
  const phone = normalizePhone(req.params.phone);
  const name = String(req.body?.name ?? '').trim();
  if (!isValidPhone(phone)) fail(400, 'Not a valid phone number');
  if (!name) {
    db.prepare('DELETE FROM contacts WHERE phone = ?').run(phone);
  } else {
    db.prepare(
      'INSERT INTO contacts (phone, name) VALUES (?, ?) ON CONFLICT (phone) DO UPDATE SET name = excluded.name',
    ).run(phone, name);
  }
  publish(db.prepare('SELECT id FROM users').all().map((u) => u.id), 'contacts', {});
  res.json({ ok: true });
});

// ----- Admin -----

const admin = express.Router();
api.use('/admin', requireAdmin, admin);

function validateNewUser(username, password) {
  if (!username || !/^[a-zA-Z0-9._@-]{2,64}$/.test(String(username).trim())) {
    fail(400, 'Username must be 2-64 letters, digits, or . _ @ -');
  }
  if (!password || String(password).length < 8) fail(400, 'Password must be at least 8 characters');
}

function userWithNumbers(u) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    isAdmin: !!u.is_admin,
    numberIds: db.prepare('SELECT number_id FROM user_numbers WHERE user_id = ?').all(u.id).map((r) => r.number_id),
  };
}

admin.get('/users', (_req, res) => {
  res.json(db.prepare('SELECT * FROM users ORDER BY username').all().map(userWithNumbers));
});

admin.post('/users', (req, res) => {
  const { username, password, displayName, isAdmin, numberIds = [] } = req.body ?? {};
  validateNewUser(username, password);
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username.trim())) fail(409, 'That username is taken');
  const { lastInsertRowid } = db
    .prepare(
      'INSERT INTO users (username, display_name, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(username.trim(), (displayName || username).trim(), hashPassword(password), isAdmin ? 1 : 0, Date.now());
  setUserNumbers(Number(lastInsertRowid), numberIds);
  res.json(userWithNumbers(db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid)));
});

function setUserNumbers(userId, numberIds) {
  db.prepare('DELETE FROM user_numbers WHERE user_id = ?').run(userId);
  const ins = db.prepare('INSERT OR IGNORE INTO user_numbers (user_id, number_id) SELECT ?, id FROM numbers WHERE id = ?');
  for (const id of numberIds) ins.run(userId, Number(id));
}

admin.patch('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) fail(404, 'User not found');
  const { displayName, password, isAdmin, numberIds } = req.body ?? {};
  if (displayName != null) db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(String(displayName).trim() || user.username, id);
  if (password) {
    if (String(password).length < 8) fail(400, 'Password must be at least 8 characters');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND user_id != ?').run(id, req.user.id);
  }
  if (isAdmin != null) {
    if (!isAdmin && id === req.user.id) fail(400, 'You cannot remove your own admin access');
    db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, id);
  }
  if (Array.isArray(numberIds)) setUserNumbers(id, numberIds);
  res.json(userWithNumbers(db.prepare('SELECT * FROM users WHERE id = ?').get(id)));
});

admin.delete('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) fail(400, 'You cannot delete yourself');
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

admin.get('/numbers', (_req, res) => {
  res.json(db.prepare('SELECT id, phone, label FROM numbers ORDER BY label, phone').all());
});

admin.post('/numbers', (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(phone)) fail(400, 'Enter a 10-digit US/Canada number');
  if (db.prepare('SELECT 1 FROM numbers WHERE phone = ?').get(phone)) fail(409, 'That number is already added');
  const { lastInsertRowid } = db
    .prepare('INSERT INTO numbers (phone, label, created_at) VALUES (?, ?, ?)')
    .run(phone, String(req.body?.label ?? '').trim(), Date.now());
  res.json(db.prepare('SELECT id, phone, label FROM numbers WHERE id = ?').get(lastInsertRowid));
});

admin.patch('/numbers/:id', (req, res) => {
  db.prepare('UPDATE numbers SET label = ? WHERE id = ?').run(String(req.body?.label ?? '').trim(), Number(req.params.id));
  res.json({ ok: true });
});

admin.delete('/numbers/:id', (req, res) => {
  db.prepare('DELETE FROM numbers WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

admin.get('/webhook-log', (_req, res) => {
  res.json({
    url: config.webhookSecret ? `${config.publicUrl}/webhook/bulkvs/${config.webhookSecret}` : null,
    entries: db.prepare('SELECT * FROM webhook_log ORDER BY id DESC LIMIT 50').all(),
  });
});

// Lets an admin push a fake inbound message through the real webhook parser
admin.post('/simulate-inbound', (req, res) => {
  const event = parseWebhook(req.body);
  if (!event || event.kind !== 'message') fail(400, 'Payload did not parse as an inbound message');
  const result = recordInbound(event);
  if (!result.ok) fail(400, result.reason);
  res.json(result);
});

// ---------- Errors ----------

api.use((_req, _res) => fail(404, 'Not found'));

app.use((err, _req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Server error' : err.message });
});

app.listen(config.port, () => {
  console.log(`Textline listening on http://localhost:${config.port}`);
  console.log(mockMode ? 'Mock mode: no BulkVS credentials set, messages are not really sent.' : 'BulkVS mode.');
  if (!config.webhookSecret) console.log('WEBHOOK_SECRET is not set, so inbound messages are disabled.');
});
