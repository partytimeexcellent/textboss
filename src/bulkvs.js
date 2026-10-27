// Everything specific to the BulkVS REST API lives in this file.
//
// Confirmed from the BulkVS API documentation (portal.bulkvs.com/api/v1.0/openapi):
//   POST /messageSend  body { From, To: [..], Message, MediaURLs?: [..] }
//                      200 { RefId, From, MessageType, Fragments, Results: [{ To, Status }] }
//   Webhooks are registered in the portal (or PUT /webHooks) with a URL, Method
//   POST and an optional Dlr flag for delivery receipts.
//
// Credentials are the "REST API" Username and Password from the portal's
// API -> API Credentials page, sent as HTTP Basic auth.
//
// NOT in the documentation, so handled defensively below:
//   - The exact inbound webhook body. parseWebhook() accepts the same field
//     names as messageSend in any letter case, and every raw body is stored in
//     the webhook_log table so the parser can be adjusted against real traffic.

import { config } from './config.js';
import { normalizePhone, toBulkvsRecipient } from './phone.js';
import { bulkvsCredentials } from './provider.js';

export class BulkvsError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

const authHeader = ({ username, password }) =>
  `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

// Checks credentials with GET /accountDetail. Pass creds to test unsaved values.
export async function testConnection(creds = bulkvsCredentials()) {
  if (!creds.username || !creds.password) return { ok: false, message: 'Enter both the API username and password' };
  let res;
  try {
    res = await fetch(`${creds.apiBase}/accountDetail`, {
      headers: { Accept: 'application/json', Authorization: authHeader(creds) },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return { ok: false, message: `Could not reach BulkVS: ${err.message}` };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, message: 'BulkVS rejected these credentials. Use the REST API username and password/token from API → API Credentials.' };
  }
  if (!res.ok) return { ok: false, message: `BulkVS returned ${res.status} ${res.statusText}` };
  return { ok: true, message: 'Connected to BulkVS' };
}

export async function sendMessage({ from, to, body, mediaUrls = [] }) {
  if (config.clone) throw new Error('Practice copy: texts are never sent');
  const creds = bulkvsCredentials();
  const { apiBase } = creds;
  const payload = {
    From: normalizePhone(from),
    To: to.map(toBulkvsRecipient),
    Message: body,
  };
  if (mediaUrls.length) payload.MediaURLs = mediaUrls;

  const res = await fetch(`${apiBase}/messageSend`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: authHeader(creds),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  });

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}

  if (!res.ok) {
    const detail = json?.Description || json?.Status || text.slice(0, 200) || res.statusText;
    throw new BulkvsError(`BulkVS ${res.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`, res.status, text);
  }

  const results = (json?.Results ?? []).map((r) => ({
    to: normalizePhone(r.To),
    ok: String(r.Status).toUpperCase() === 'SUCCESS',
    status: r.Status,
  }));
  return { refId: json?.RefId ?? null, results };
}

// Look up a key case-insensitively, ignoring underscores and dashes
function pick(obj, ...names) {
  const wanted = new Set(names.map((n) => n.toLowerCase().replace(/[_-]/g, '')));
  for (const [k, v] of Object.entries(obj)) {
    if (wanted.has(k.toLowerCase().replace(/[_-]/g, ''))) return v;
  }
  return undefined;
}

function asArray(v) {
  if (v == null || v === '') return [];
  if (Array.isArray(v)) return v;
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

// Some gateways URL-encode the text. Only decode when it clearly looks encoded.
function maybeDecode(text) {
  if (typeof text !== 'string') return '';
  if (/\s/.test(text) || !/(%[0-9A-Fa-f]{2}|\+)/.test(text)) return text;
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    return text;
  }
}

const DLR_FAILED = /UNDELIV|REJECT|EXPIRED|FAIL|DELETED|UNKNOWN/i;
const DLR_DELIVERED = /DELIVRD|DELIVERED/i;

export function parseWebhook(body) {
  if (!body || typeof body !== 'object') return null;

  const receipt = pick(body, 'DeliveryReceipt', 'Dlr', 'DlrStatus');
  const message = pick(body, 'Message', 'Text', 'Body');
  const refId = pick(body, 'RefId', 'RefID', 'MessageId', 'Id');

  if (receipt != null && message == null) {
    const s = String(receipt);
    const stat = /stat:(\w+)/i.exec(s)?.[1] ?? s;
    return {
      kind: 'receipt',
      refId: refId != null ? String(refId) : null,
      to: normalizePhone(pick(body, 'To', 'Destination') ?? ''),
      // The person the original text went to, for matching when RefId doesn't
      recipient: normalizePhone(pick(body, 'From', 'Source', 'To', 'Destination') ?? ''),
      status: DLR_DELIVERED.test(stat) ? 'delivered' : DLR_FAILED.test(stat) ? 'failed' : 'sent',
      detail: s,
    };
  }

  const from = normalizePhone(pick(body, 'From', 'Source') ?? '');
  const to = asArray(pick(body, 'To', 'Destination')).map(normalizePhone).filter(Boolean);
  const media = asArray(pick(body, 'MediaURLs', 'MediaUrl', 'Media')).map(String);
  if (!from || !to.length) return null;

  return { kind: 'message', from, to, body: maybeDecode(message ?? ''), media };
}
