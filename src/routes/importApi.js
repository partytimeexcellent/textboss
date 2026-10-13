// Contact import API for other software, authenticated with an API key:
//   Authorization: Bearer tbk_...
//
//   POST /api/v1/contacts
//     JSON: { "contacts": [ { firstName, lastName, phone, dob, email, patientId, notes, optedOut } ] }
//           (a bare array or a single object also works)
//     or a spreadsheet: Content-Type application/vnd.ms-excel, .xlsx or text/csv, raw file as the body
//
//   ?dryRun=1 reports what would change without saving.

import crypto from 'node:crypto';
import express from 'express';
import { db, allUserIds } from '../db.js';
import { fail } from '../http.js';
import { publish } from '../events.js';
import { parseContactFile, upsertContacts, logImport } from '../contacts.js';

export const router = express.Router();

export const hashKey = (key) => crypto.createHash('sha256').update(key).digest('hex');

export function createApiKey(name) {
  const key = `tbk_${crypto.randomBytes(24).toString('base64url')}`;
  db.prepare('INSERT INTO api_keys (name, prefix, key_hash, created_at) VALUES (?, ?, ?, ?)').run(
    name,
    key.slice(0, 10),
    hashKey(key),
    Date.now(),
  );
  return key;
}

router.use((req, _res, next) => {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
  const row = m && db.prepare('SELECT id FROM api_keys WHERE key_hash = ?').get(hashKey(m[1]));
  if (!row) fail(401, 'Missing or invalid API key');
  db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(Date.now(), row.id);
  next();
});

const SPREADSHEET = /(spreadsheet|excel|csv|octet-stream)/i;

router.post(
  '/contacts',
  express.json({ limit: '20mb' }),
  express.raw({ type: (req) => SPREADSHEET.test(req.headers['content-type'] ?? ''), limit: '20mb' }),
  (req, res) => {
    const dryRun = req.query.dryRun === '1';
    let records;
    if (Buffer.isBuffer(req.body)) {
      records = parseContactFile(req.body).records;
    } else {
      const body = req.body;
      records = Array.isArray(body) ? body : Array.isArray(body?.contacts) ? body.contacts : body ? [body] : [];
    }
    if (!records.length) fail(400, 'No contacts in the request');
    if (records.length > 50000) fail(400, 'Send at most 50,000 contacts per request');
    const result = upsertContacts(records, { dryRun });
    if (!dryRun) {
      logImport('api', null, result);
      publish(allUserIds(), 'contacts', {});
    }
    res.json({
      dryRun,
      created: result.created,
      updated: result.updated,
      unchanged: result.unchanged,
      skipped: result.skipped,
      issueCount: result.issueCount,
      issues: result.issues,
      changes: result.changes,
      errors: result.errors,
    });
  },
);
