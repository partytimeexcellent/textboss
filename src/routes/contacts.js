// Contacts, lists, canned responses and bulk messages (signed-in users)

import express from 'express';
import { db, tx, allUserIds, userCanAccessNumber } from '../db.js';
import { fail, placeholders } from '../http.js';
import { publish } from '../events.js';
import { config } from '../config.js';
import {
  CONTACT_SELECT,
  serializeContact,
  getContact,
  cleanContact,
  validateContact,
  createContact,
  updateContact,
  setOptOut,
  contactNames,
  contactMergeNames,
  setInactive,
  reactivate,
  fullName,
  setDisplayContact,
  isDisplayContact,
} from '../contacts.js';
import { createBroadcast, serializeBroadcast } from '../messaging.js';

export const router = express.Router();

const notifyContacts = () => publish(allUserIds(), 'contacts', {});

// ----- Contacts -----

// Compact lookups for the conversation list: phone -> names, opted-out and blocked phones
router.get('/contacts/index', (_req, res) => {
  res.json({
    names: contactNames(),
    people: contactMergeNames(),
    optedOut: db.prepare('SELECT phone FROM opt_outs').all().map((r) => r.phone),
    blocked: db.prepare('SELECT phone FROM blocked').all().map((r) => r.phone),
  });
});

router.get('/contacts', (req, res) => {
  const where = [];
  const params = [];
  const q = String(req.query.q ?? '').trim();
  if (q) {
    // Every word must match some field, so "smith jo" finds John Smith
    for (const word of q.split(/\s+/).slice(0, 5)) {
      const digits = word.replace(/\D/g, '');
      const like = `%${word}%`;
      where.push(`(c.first_name LIKE ? OR c.last_name LIKE ? OR c.nickname LIKE ? OR c.email LIKE ? OR c.patient_id LIKE ? OR c.dob LIKE ?${
        digits.length >= 3 ? ' OR c.phone LIKE ?' : ''
      })`);
      params.push(like, like, like, like, like, like);
      if (digits.length >= 3) params.push(`%${digits}%`);
    }
  }
  if (req.query.list) {
    where.push('c.id IN (SELECT contact_id FROM list_members WHERE list_id = ?)');
    params.push(Number(req.query.list));
  }
  // Inactive contacts only show when asked for (Admin settings → Contacts & Import)
  if (req.query.status === 'inactive') where.push('c.inactive_at IS NOT NULL');
  else if (req.query.status !== 'all') where.push('c.inactive_at IS NULL');
  if (req.query.reason) {
    where.push('c.inactive_reason = ?');
    params.push(String(req.query.reason));
  }
  if (req.query.filter === 'optedOut') where.push(`c.phone IN (SELECT phone FROM opt_outs)`);
  if (req.query.filter === 'noPhone') where.push(`c.phone = ''`);

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const offset = Number(req.query.offset) || 0;
  const { total } = db.prepare(`SELECT COUNT(*) AS total FROM contacts c ${whereSql}`).get(...params);
  const order = req.query.status === 'inactive' ? 'c.inactive_at DESC, ' : '';
  const rows = db
    .prepare(`${CONTACT_SELECT} ${whereSql} ORDER BY ${order}c.last_name COLLATE NOCASE, c.first_name COLLATE NOCASE, c.id LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);
  const result = { total, contacts: rows.map(serializeContact) };
  // "Select all N matching" needs every id, not just the visible page
  if (req.query.ids === '1') {
    result.ids = db.prepare(`SELECT c.id FROM contacts c ${whereSql}`).all(...params).map((r) => r.id);
  }
  res.json(result);
});

// Use this contact's name for a phone number several contacts share
router.post('/contacts/:id/display-name', (req, res) => {
  if (!setDisplayContact(Number(req.params.id))) fail(400, 'This contact has no phone number');
  notifyContacts();
  res.json({ ok: true });
});

// Mark contacts inactive (hidden from the list) or active again
router.post('/contacts/status', (req, res) => {
  const ids = (req.body?.ids ?? []).map(Number).filter(Boolean).slice(0, 20000);
  if (!ids.length) fail(400, 'Choose at least one contact');
  const reason = ['import', 'manual'].includes(req.body?.reason) ? req.body.reason : 'manual';
  const changed = req.body?.inactive ? setInactive(ids, reason) : reactivate(ids);
  res.json({ ok: true, changed });
});

// Contacts by id, for the bulk message recipient summary
router.post('/contacts/lookup', (req, res) => {
  const ids = (req.body?.ids ?? []).map(Number).filter(Boolean).slice(0, 5000);
  if (!ids.length) return res.json([]);
  const rows = [];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    rows.push(...db.prepare(`${CONTACT_SELECT} WHERE c.id IN (${placeholders(chunk)})`).all(...chunk));
  }
  res.json(rows.map(serializeContact));
});

router.get('/contacts/:id', (req, res) => {
  const contact = getContact(Number(req.params.id));
  if (!contact) fail(404, 'Contact not found');
  contact.lists = db
    .prepare('SELECT l.id, l.name FROM lists l JOIN list_members m ON m.list_id = l.id WHERE m.contact_id = ? ORDER BY l.name')
    .all(contact.id);
  // Other contacts with the same phone number (family members, or a duplicate)
  contact.sharedWith = contact.phone
    ? db.prepare(`SELECT id, first_name, last_name, nickname, inactive_at FROM contacts WHERE phone = ? AND id != ?
        ORDER BY last_name COLLATE NOCASE, first_name COLLATE NOCASE`).all(contact.phone, contact.id)
        .map((r) => ({ id: r.id, name: fullName(r) || '(no name)', inactive: !!r.inactive_at }))
    : [];
  contact.sharedPhone = contact.sharedWith.length;
  contact.isDisplayName = contact.sharedPhone > 0 && isDisplayContact(contact.id);
  res.json(contact);
});

function saveOptOut(c, body) {
  if (body?.optedOut !== undefined && c.phone) setOptOut(c.phone, !!body.optedOut, 'manual');
}

router.post('/contacts', (req, res) => {
  const c = cleanContact(req.body ?? {});
  const err = validateContact(c);
  if (err) fail(400, err);
  const id = createContact(c);
  saveOptOut(c, req.body);
  notifyContacts();
  res.json(getContact(id));
});

router.patch('/contacts/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = getContact(id);
  if (!existing) fail(404, 'Contact not found');
  const c = cleanContact(req.body ?? {});
  const err = validateContact({ ...existing, ...c });
  if (err) fail(400, err);
  updateContact(id, c);
  saveOptOut({ phone: c.phone ?? existing.phone }, req.body);
  notifyContacts();
  res.json(getContact(id));
});

router.delete('/contacts/:id', (req, res) => {
  if (!req.user.is_admin) fail(403, 'Only admins can delete contacts');
  db.prepare('DELETE FROM contacts WHERE id = ?').run(Number(req.params.id));
  notifyContacts();
  res.json({ ok: true });
});

router.post('/contacts/delete', (req, res) => {
  const ids = (req.body?.ids ?? []).map(Number).filter(Boolean);
  if (!req.user.is_admin) fail(403, 'Only admins can delete contacts in bulk');
  if (ids.length) db.prepare(`DELETE FROM contacts WHERE id IN (${placeholders(ids)})`).run(...ids);
  notifyContacts();
  res.json({ ok: true, deleted: ids.length });
});

// ----- Opt-out and blocking by phone (used from conversations) -----

router.put('/phones/:phone/opt-out', (req, res) => {
  setOptOut(req.params.phone.replace(/\D/g, ''), !!req.body?.optedOut, 'manual');
  notifyContacts();
  res.json({ ok: true });
});

router.put('/phones/:phone/block', (req, res) => {
  if (!req.user.is_admin) fail(403, 'Only admins can block or unblock senders');
  const phone = req.params.phone.replace(/\D/g, '');
  if (req.body?.blocked) {
    db.prepare('INSERT OR IGNORE INTO blocked (phone, blocked_by, created_at) VALUES (?, ?, ?)').run(phone, req.user.id, Date.now());
  } else {
    db.prepare('DELETE FROM blocked WHERE phone = ?').run(phone);
  }
  notifyContacts();
  res.json({ ok: true });
});

// ----- Lists -----

router.get('/lists', (_req, res) => {
  res.json(
    db.prepare(
      `SELECT l.id, l.name, l.created_at AS createdAt, u.display_name AS createdBy,
         (SELECT COUNT(*) FROM list_members m JOIN contacts c ON c.id = m.contact_id WHERE m.list_id = l.id AND c.inactive_at IS NULL) AS count
       FROM lists l LEFT JOIN users u ON u.id = l.created_by ORDER BY l.created_at DESC`,
    ).all(),
  );
});

router.post('/lists', (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) fail(400, 'Give the list a name');
  const ids = (req.body?.contactIds ?? []).map(Number).filter(Boolean);
  const id = tx(() => {
    const { lastInsertRowid } = db
      .prepare('INSERT INTO lists (name, created_by, created_at) VALUES (?, ?, ?)')
      .run(name, req.user.id, Date.now());
    const ins = db.prepare('INSERT OR IGNORE INTO list_members (list_id, contact_id) SELECT ?, id FROM contacts WHERE id = ?');
    for (const cid of ids) ins.run(lastInsertRowid, cid);
    return Number(lastInsertRowid);
  });
  notifyContacts();
  res.json({ id, name, count: ids.length });
});

router.patch('/lists/:id', (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) fail(400, 'Give the list a name');
  db.prepare('UPDATE lists SET name = ? WHERE id = ?').run(name, Number(req.params.id));
  notifyContacts();
  res.json({ ok: true });
});

router.delete('/lists/:id', (req, res) => {
  db.prepare('DELETE FROM lists WHERE id = ?').run(Number(req.params.id));
  notifyContacts();
  res.json({ ok: true });
});

router.post('/lists/:id/members', (req, res) => {
  const listId = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM lists WHERE id = ?').get(listId)) fail(404, 'List not found');
  const add = (req.body?.add ?? []).map(Number).filter(Boolean);
  const remove = (req.body?.remove ?? []).map(Number).filter(Boolean);
  tx(() => {
    const ins = db.prepare('INSERT OR IGNORE INTO list_members (list_id, contact_id) SELECT ?, id FROM contacts WHERE id = ?');
    for (const id of add) ins.run(listId, id);
    if (remove.length) {
      db.prepare(`DELETE FROM list_members WHERE list_id = ? AND contact_id IN (${placeholders(remove)})`).run(listId, ...remove);
    }
  });
  notifyContacts();
  res.json({ ok: true });
});

// ----- Canned responses -----

function serializeCanned(r) {
  return { id: r.id, name: r.name, body: r.body, media: JSON.parse(r.media), keyword: r.keyword, isAway: !!r.is_away };
}

function cleanCanned(body) {
  const name = String(body?.name ?? '').trim();
  const text = String(body?.body ?? '').trim();
  const keyword = String(body?.keyword ?? '').trim();
  const media = (Array.isArray(body?.media) ? body.media : []).map(String);
  if (!name) fail(400, 'Friendly name is required');
  if (!text) fail(400, 'Message body is required');
  if (text.length > 1600) fail(400, 'Message is too long (1600 characters max)');
  if (/\s/.test(keyword)) fail(400, 'Keywords must be a single word');
  if (/^(stop|stopall|unsubscribe|cancel|end|quit|start|unstop|help)$/i.test(keyword)) {
    fail(400, `"${keyword}" is reserved by carriers and cannot be a keyword`);
  }
  if (media.some((url) => !url.startsWith(`${config.publicUrl}/media/`))) fail(400, 'Attachments must be uploaded first');
  return { name, body: text, keyword, media, isAway: !!body?.isAway };
}

function saveCanned(id, c) {
  return tx(() => {
    if (c.keyword) {
      const clash = db.prepare('SELECT name FROM canned_responses WHERE keyword = ? COLLATE NOCASE AND id != ?').get(c.keyword, id ?? 0);
      if (clash) fail(409, `"${clash.name}" already uses the keyword ${c.keyword}`);
    }
    // Only one away message can be on at a time
    if (c.isAway) db.prepare('UPDATE canned_responses SET is_away = 0').run();
    if (id) {
      db.prepare('UPDATE canned_responses SET name = ?, body = ?, media = ?, keyword = ?, is_away = ? WHERE id = ?')
        .run(c.name, c.body, JSON.stringify(c.media), c.keyword, c.isAway ? 1 : 0, id);
      return id;
    }
    return Number(
      db.prepare('INSERT INTO canned_responses (name, body, media, keyword, is_away, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(c.name, c.body, JSON.stringify(c.media), c.keyword, c.isAway ? 1 : 0, Date.now()).lastInsertRowid,
    );
  });
}

router.get('/canned', (_req, res) => {
  res.json(db.prepare('SELECT * FROM canned_responses ORDER BY name COLLATE NOCASE').all().map(serializeCanned));
});

router.post('/canned', (req, res) => {
  const id = saveCanned(null, cleanCanned(req.body));
  publish(allUserIds(), 'canned', {});
  res.json(serializeCanned(db.prepare('SELECT * FROM canned_responses WHERE id = ?').get(id)));
});

router.put('/canned/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM canned_responses WHERE id = ?').get(id)) fail(404, 'Not found');
  saveCanned(id, cleanCanned(req.body));
  publish(allUserIds(), 'canned', {});
  res.json(serializeCanned(db.prepare('SELECT * FROM canned_responses WHERE id = ?').get(id)));
});

router.delete('/canned/:id', (req, res) => {
  db.prepare('DELETE FROM canned_responses WHERE id = ?').run(Number(req.params.id));
  publish(allUserIds(), 'canned', {});
  res.json({ ok: true });
});

// ----- Bulk messages -----

router.post('/broadcasts', (req, res) => {
  const numberId = Number(req.body?.numberId);
  const number = db.prepare('SELECT * FROM numbers WHERE id = ?').get(numberId);
  if (!number || !userCanAccessNumber(req.user, numberId)) fail(403, 'You cannot send from that number');
  const contactIds = (req.body?.contactIds ?? []).map(Number).filter(Boolean);
  if (!contactIds.length) fail(400, 'Select at least one contact');
  if (contactIds.length > 2000) fail(400, 'Bulk messages are limited to 2,000 contacts at a time');
  const body = String(req.body?.body ?? '').trim();
  const media = (Array.isArray(req.body?.media) ? req.body.media : []).map(String);
  if (!body && !media.length) fail(400, 'Message is empty');
  if (body.length > 1600) fail(400, 'Message is too long (1600 characters max)');
  if (media.some((url) => !url.startsWith(`${config.publicUrl}/media/`))) fail(400, 'Attachments must be uploaded first');
  res.json(createBroadcast({ number, user: req.user, contactIds, body, media }));
});

router.get('/broadcasts', (req, res) => {
  const rows = db.prepare('SELECT id, number_id FROM broadcasts ORDER BY id DESC LIMIT 20').all();
  res.json(rows.filter((r) => userCanAccessNumber(req.user, r.number_id)).map((r) => serializeBroadcast(r.id)));
});

router.get('/broadcasts/:id', (req, res) => {
  const b = serializeBroadcast(Number(req.params.id));
  if (!b || !userCanAccessNumber(req.user, b.numberId)) fail(404, 'Not found');
  b.items = db.prepare('SELECT phone, body, status, error FROM broadcast_items WHERE broadcast_id = ? ORDER BY id').all(b.id);
  res.json(b);
});

router.post('/broadcasts/:id/cancel', (req, res) => {
  const b = serializeBroadcast(Number(req.params.id));
  if (!b || !userCanAccessNumber(req.user, b.numberId)) fail(404, 'Not found');
  db.prepare(`UPDATE broadcasts SET status = 'cancelled' WHERE id = ? AND status = 'running'`).run(b.id);
  res.json({ ok: true });
});
