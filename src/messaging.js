import {
  db,
  tx,
  getOrCreateConversation,
  userIdsForNumber,
  serializeMessage,
} from './db.js';
import { publish } from './events.js';
import { mockMode } from './config.js';
import { normalizePhone, participantsKey } from './phone.js';
import * as bulkvs from './bulkvs.js';

const MESSAGE_SELECT = `
  SELECT m.*, u.display_name AS sent_by_name
  FROM messages m LEFT JOIN users u ON u.id = m.sent_by`;

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
        (conversation_id, direction, from_phone, body, media, status, ref_id, sent_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      now,
    );
  db.prepare('UPDATE conversations SET last_message_at = ?, archived = 0 WHERE id = ?').run(
    now,
    conversation.id,
  );
  return Number(lastInsertRowid);
}

// Inbound message from the webhook. `to` may hold several numbers for a group
// MMS; we file it under whichever of them is one of our numbers.
export function recordInbound({ from, to, body, media }) {
  const ours = db.prepare('SELECT * FROM numbers WHERE phone = ?');
  const number = to.map((p) => ours.get(normalizePhone(p))).find(Boolean);
  if (!number) return { ok: false, reason: `none of ${to.join(', ')} is a configured number` };

  const others = [from, ...to].filter((p) => normalizePhone(p) !== number.phone);
  const { conversation, id } = tx(() => {
    const conversation = getOrCreateConversation(number.id, participantsKey(others));
    const id = insertMessage(conversation, { direction: 'in', from, body, media, status: 'received' });
    return { conversation, id };
  });
  announce(conversation, getMessage(id));
  return { ok: true, messageId: id };
}

export async function sendOutbound({ conversation, number, user, body, media = [] }) {
  const recipients = conversation.participants.split(',');
  const id = tx(() =>
    insertMessage(conversation, {
      direction: 'out',
      from: number.phone,
      body,
      media,
      status: 'sending',
      sentBy: user.id,
    }),
  );
  announce(conversation, getMessage(id));

  const setStatus = (status, error = null, refId = null) => {
    db.prepare(
      'UPDATE messages SET status = ?, error = ?, ref_id = COALESCE(?, ref_id) WHERE id = ?',
    ).run(status, error, refId, id);
    announce(conversation, getMessage(id));
  };

  if (mockMode) {
    setStatus('sent', null, `mock-${id}`);
    setTimeout(() => setStatus('delivered'), 800);
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
    return getMessage(id);
  }

  try {
    const { refId, results } = await bulkvs.sendMessage({
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
