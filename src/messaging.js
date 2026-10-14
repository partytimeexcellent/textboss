import {
  db,
  tx,
  getOrCreateConversation,
  userIdsForNumber,
  allUserIds,
  serializeMessage,
  isOptedOut,
  isBlocked,
} from './db.js';
import { publish } from './events.js';
import { isMockMode, activeProvider } from './provider.js';
import { normalizePhone, participantsKey } from './phone.js';
import { setOptOut, fullName, reactivatePhones } from './contacts.js';
import { pushToUsers } from './push.js';
import * as bulkvs from './bulkvs.js';
import * as voipms from './voipms.js';

const providerApi = () => (activeProvider() === 'voipms' ? voipms : bulkvs);

const MESSAGE_SELECT = `
  SELECT m.*, u.display_name AS sent_by_name
  FROM messages m LEFT JOIN users u ON u.id = m.sent_by`;

// Carrier-standard keywords. Carriers expect these to be honored on 10DLC.
const STOP_WORDS = /^(stop|stopall|unsubscribe|cancel|end|quit|optout|opt out|revoke)$/i;
const START_WORDS = /^(start|unstop|subscribe|optin|opt in)$/i;
const AWAY_INTERVAL = 12 * 3600_000;

export class OptOutError extends Error {
  constructor(phones) {
    super(`Opted out: ${phones.join(', ')}`);
    this.status = 409;
    this.code = 'opted_out';
    this.phones = phones;
  }
}

export function getMessage(id) {
  return serializeMessage(db.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`).get(id));
}

export function listMessages(conversationId, beforeId, limit = 50) {
  const rows = db
    .prepare(
      `${MESSAGE_SELECT} WHERE m.conversation_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?`,
    )
    .all(conversationId, beforeId ?? Number.MAX_SAFE_INTEGER, limit);
  return rows.reverse().map(serializeMessage);
}

function announce(conversation, message) {
  const users = userIdsForNumber(conversation.number_id);
  publish(users, 'message', message);
}

function insertMessage(conversation, fields) {
  const now = Date.now();
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO messages
        (conversation_id, direction, from_phone, body, media, status, ref_id, sent_by, kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      conversation.id,
      fields.direction,
      fields.from,
      fields.body,
      JSON.stringify(fields.media ?? []),
      fields.status,
      fields.refId ?? null,
      fields.sentBy ?? null,
      fields.kind ?? null,
      now,
    );
  db.prepare('UPDATE conversations SET last_message_at = ?, archived = 0 WHERE id = ?').run(
    now,
    conversation.id,
  );
  // Texting with an inactive contact makes them active again
  reactivatePhones(conversation.participants.split(','));
  return Number(lastInsertRowid);
}

// Inbound message from the webhook. `to` may hold several numbers for a group
// MMS; we file it under whichever of them is one of our numbers.
export function recordInbound({ from, to, body, media, refId = null }) {
  // Providers retry a callback they think failed; don't store the same text twice
  if (refId && db.prepare('SELECT 1 FROM messages WHERE ref_id = ?').get(refId)) return { ok: true, duplicate: true };
  const ours = db.prepare('SELECT * FROM numbers WHERE phone = ?');
  const number = to.map((p) => ours.get(normalizePhone(p))).find(Boolean);
  if (!number) return { ok: false, reason: `none of ${to.join(', ')} is a configured number` };

  const sender = normalizePhone(from);
  if (isBlocked(sender)) return { ok: true, blocked: true, reason: `blocked sender ${sender}` };

  const others = [from, ...to].filter((p) => normalizePhone(p) !== number.phone);
  const { conversation, id } = tx(() => {
    const conversation = getOrCreateConversation(number.id, participantsKey(others));
    const id = insertMessage(conversation, { direction: 'in', from, body, media, status: 'received', refId });
    return { conversation, id };
  });
  announce(conversation, getMessage(id));
  notifyDevices(conversation, number, sender, body, media).catch((err) => console.warn('push failed', err.message));

  const text = String(body ?? '').trim();
  if (STOP_WORDS.test(text)) {
    setOptOut(sender, true, 'STOP');
    publish(allUserIds(), 'contacts', {});
  } else if (START_WORDS.test(text)) {
    setOptOut(sender, false, 'START');
    publish(allUserIds(), 'contacts', {});
  } else {
    autoReply(conversation, number, sender, text).catch((err) => console.error('auto-reply failed', err));
  }
  return { ok: true, messageId: id };
}

// Lock-screen alert + app badge on every device that turned notifications on
async function notifyDevices(conversation, number, sender, body, media) {
  const contact = db.prepare('SELECT first_name, last_name, nickname FROM contacts WHERE phone = ? ORDER BY id LIMIT 1').get(sender);
  const name = (contact && fullName(contact)) || formatPhone(sender);
  const text = String(body ?? '').trim() || (media?.length ? 'Sent an attachment' : '');
  await pushToUsers(userIdsForNumber(number.id), (_user, preview) => ({
    title: preview ? name : 'TextBoss',
    body: preview ? text : 'New message',
    url: `/#/c/${conversation.id}`,
    tag: `conv-${conversation.id}`,
  }));
}

const formatPhone = (p) => (/^\d{10}$/.test(p) ? `(${p.slice(0, 3)}) ${p.slice(3, 6)}-${p.slice(6)}` : p);

function firstContactFor(phone) {
  return db.prepare('SELECT first_name, last_name, nickname FROM contacts WHERE phone = ? ORDER BY id LIMIT 1').get(phone);
}

export function mergeFields(text, contact) {
  const first = contact?.first_name ?? contact?.firstName ?? '';
  const last = contact?.last_name ?? contact?.lastName ?? '';
  const nick = contact?.nickname || first;
  return text
    .replace(/\{nickname\}/gi, nick)
    .replace(/\{first_name\}/gi, first)
    .replace(/\{last_name\}/gi, last)
    .replace(/\{full_name\}/gi, [first, last].filter(Boolean).join(' '))
    .replace(/ {2,}/g, ' ')
    .replace(/ ([,.!?])/g, '$1');
}

// Keyword match first; otherwise the active away message, at most once per
// conversation every 12 hours. Group threads and opted-out senders get nothing.
async function autoReply(conversation, number, sender, text) {
  if (conversation.participants.includes(',') || isOptedOut(sender)) return;

  let reply = text
    ? db.prepare(`SELECT * FROM canned_responses WHERE keyword != '' AND keyword = ? COLLATE NOCASE LIMIT 1`).get(text)
    : null;

  if (!reply) {
    reply = db.prepare('SELECT * FROM canned_responses WHERE is_away = 1 LIMIT 1').get();
    if (!reply) return;
    const last = db.prepare('SELECT sent_at FROM away_sent WHERE conversation_id = ?').get(conversation.id);
    if (last && Date.now() - last.sent_at < AWAY_INTERVAL) return;
    db.prepare(
      'INSERT INTO away_sent (conversation_id, sent_at) VALUES (?, ?) ON CONFLICT (conversation_id) DO UPDATE SET sent_at = excluded.sent_at',
    ).run(conversation.id, Date.now());
  }

  await sendOutbound({
    conversation,
    number,
    user: null,
    body: mergeFields(reply.body, firstContactFor(sender)),
    media: JSON.parse(reply.media),
    kind: 'auto',
    confirmOptOut: false,
  });
}

export async function sendOutbound({ conversation, number, user, body, media = [], kind = null, confirmOptOut = false }) {
  const recipients = conversation.participants.split(',');
  const optedOut = recipients.filter(isOptedOut);
  if (optedOut.length && !confirmOptOut) throw new OptOutError(optedOut);

  const id = tx(() =>
    insertMessage(conversation, {
      direction: 'out',
      from: number.phone,
      body,
      media,
      status: 'sending',
      sentBy: user?.id ?? null,
      kind,
    }),
  );
  announce(conversation, getMessage(id));

  const setStatus = (status, error = null, refId = null) => {
    db.prepare(
      'UPDATE messages SET status = ?, error = ?, ref_id = COALESCE(?, ref_id) WHERE id = ?',
    ).run(status, error, refId, id);
    announce(conversation, getMessage(id));
  };

  if (isMockMode()) {
    setStatus('sent', null, `mock-${id}`);
    setTimeout(() => setStatus('delivered'), 800);
    if (kind !== 'auto' && kind !== 'bulk') {
      setTimeout(
        () =>
          recordInbound({
            from: recipients[0],
            to: [number.phone, ...recipients.slice(1)],
            body: `(mock reply) Got your message: "${body.slice(0, 60)}"`,
            media: [],
          }),
        2000,
      );
    }
    return getMessage(id);
  }

  try {
    const { refId, results } = await providerApi().sendMessage({
      from: number.phone,
      to: recipients,
      body,
      mediaUrls: media,
    });
    const failed = results.filter((r) => !r.ok);
    if (results.length && failed.length === results.length) {
      setStatus('failed', failed.map((r) => `${r.to}: ${r.status}`).join('; '), refId);
    } else {
      setStatus('sent', failed.length ? failed.map((r) => `${r.to}: ${r.status}`).join('; ') : null, refId);
    }
  } catch (err) {
    setStatus('failed', err.message);
  }
  return getMessage(id);
}

export function applyReceipt({ refId, status, detail }) {
  if (!refId) return { ok: false, reason: 'receipt without RefId' };
  const rows = db.prepare('SELECT id, conversation_id FROM messages WHERE ref_id = ?').all(refId);
  if (!rows.length) return { ok: false, reason: `no message with RefId ${refId}` };
  for (const row of rows) {
    db.prepare('UPDATE messages SET status = ?, error = ? WHERE id = ?').run(
      status,
      status === 'failed' ? detail : null,
      row.id,
    );
    const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(row.conversation_id);
    announce(conversation, getMessage(row.id));
  }
  return { ok: true };
}

// ---------- Bulk messages ----------

const sendInterval = () => (isMockMode() ? 150 : 1000);

export function serializeBroadcast(id) {
  const b = db.prepare(
    `SELECT b.*, u.display_name AS created_by_name,
       (SELECT COUNT(*) FROM broadcast_items i WHERE i.broadcast_id = b.id) AS total,
       (SELECT COUNT(*) FROM broadcast_items i WHERE i.broadcast_id = b.id AND i.status = 'sent') AS sent,
       (SELECT COUNT(*) FROM broadcast_items i WHERE i.broadcast_id = b.id AND i.status = 'failed') AS failed,
       (SELECT COUNT(*) FROM broadcast_items i WHERE i.broadcast_id = b.id AND i.status = 'skipped') AS skipped
     FROM broadcasts b LEFT JOIN users u ON u.id = b.created_by WHERE b.id = ?`,
  ).get(id);
  if (!b) return null;
  return {
    id: b.id,
    numberId: b.number_id,
    body: b.body,
    status: b.status,
    createdBy: b.created_by_name,
    createdAt: b.created_at,
    total: b.total,
    sent: b.sent,
    failed: b.failed,
    skipped: b.skipped,
  };
}

// Builds one item per phone. Contacts sharing a phone get one text when the
// merged text is identical, otherwise one each. Opted-out phones are skipped.
export function createBroadcast({ number, user, contactIds, body, media }) {
  const contacts = contactIds.length
    ? db.prepare(`SELECT * FROM contacts WHERE id IN (${contactIds.map(() => '?').join(',')})`).all(...contactIds)
    : [];
  const items = [];
  const seen = new Set();
  let noPhone = 0;
  for (const c of contacts) {
    if (!c.phone) {
      noPhone++;
      continue;
    }
    const text = mergeFields(body, c);
    const key = `${c.phone}\n${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ phone: c.phone, body: text, status: isOptedOut(c.phone) || isBlocked(c.phone) ? 'skipped' : 'pending' });
  }
  if (!items.some((i) => i.status === 'pending')) {
    throw Object.assign(new Error('None of the selected contacts can be texted (no phone, opted out or blocked)'), { status: 400 });
  }

  const id = tx(() => {
    const { lastInsertRowid } = db
      .prepare('INSERT INTO broadcasts (number_id, body, media, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(number.id, body, JSON.stringify(media), user.id, Date.now());
    const ins = db.prepare('INSERT INTO broadcast_items (broadcast_id, phone, body, status, error) VALUES (?, ?, ?, ?, ?)');
    for (const it of items) {
      ins.run(lastInsertRowid, it.phone, it.body, it.status, it.status === 'skipped' ? 'opted out or blocked' : null);
    }
    return Number(lastInsertRowid);
  });
  runBroadcast(id);
  return { ...serializeBroadcast(id), noPhone };
}

const running = new Set();

async function runBroadcast(id) {
  if (running.has(id)) return;
  running.add(id);
  try {
    const b = db.prepare('SELECT * FROM broadcasts WHERE id = ?').get(id);
    const number = db.prepare('SELECT * FROM numbers WHERE id = ?').get(b?.number_id);
    if (!b || !number) return;
    const users = userIdsForNumber(number.id);
    const next = db.prepare(`SELECT * FROM broadcast_items WHERE broadcast_id = ? AND status = 'pending' ORDER BY id LIMIT 1`);
    let item;
    while ((item = next.get(id))) {
      if (db.prepare('SELECT status FROM broadcasts WHERE id = ?').get(id)?.status === 'cancelled') break;
      let status = 'sent';
      let error = null;
      if (isOptedOut(item.phone)) {
        status = 'skipped';
        error = 'opted out';
      } else {
        try {
          const conversation = getOrCreateConversation(number.id, participantsKey([item.phone]));
          const msg = await sendOutbound({
            conversation,
            number,
            user: { id: b.created_by },
            body: item.body,
            media: JSON.parse(b.media),
            kind: 'bulk',
          });
          if (msg.status === 'failed') {
            status = 'failed';
            error = msg.error;
          }
        } catch (err) {
          status = 'failed';
          error = err.message;
        }
      }
      db.prepare('UPDATE broadcast_items SET status = ?, error = ? WHERE id = ?').run(status, error, item.id);
      publish(users, 'broadcast', serializeBroadcast(id));
      await new Promise((r) => setTimeout(r, sendInterval()));
    }
    db.prepare(`UPDATE broadcasts SET status = CASE status WHEN 'cancelled' THEN 'cancelled' ELSE 'done' END WHERE id = ?`).run(id);
    publish(users, 'broadcast', serializeBroadcast(id));
  } finally {
    running.delete(id);
  }
}

// Resume bulk sends interrupted by a restart
export function resumeBroadcasts() {
  for (const { id } of db.prepare(`SELECT id FROM broadcasts WHERE status = 'running'`).all()) runBroadcast(id);
}
