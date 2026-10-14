// Everything specific to the VoIP.ms API lives in this file.
//
// Outgoing: POST form fields to https://voip.ms/api/v1/rest.php with
//   api_username (the VoIP.ms login email) and api_password (the separate API
//   password), method=sendSMS (up to 160 characters) or sendMMS (up to 2048
//   characters, media1..media3 as URLs). Replies are JSON: { status: "success",
//   sms|mms: "<id>" } or { status: "<error code>" }.
//   The API must be enabled and this server's IP allowed in the VoIP.ms portal
//   (Main Menu → SOAP and REST/JSON API).
//
// Incoming: each DID's "SMS URL Callback" makes VoIP.ms request a URL with
//   {TO} {FROM} {MESSAGE} {ID} {TIMESTAMP} {MEDIA} filled in, and it expects the
//   plain text "ok" back. Some accounts separate the fields with ";" instead of
//   "&", so both are accepted. VoIP.ms has no delivery receipts and no group
//   texts.

import { normalizePhone } from './phone.js';
import { providerCredentials } from './provider.js';

const API = 'https://voip.ms/api/v1/rest.php';
export const SMS_LIMIT = 160;
export const MMS_LIMIT = 2048;
export const MAX_MEDIA = 3;

// Plain-English versions of the status codes VoIP.ms returns
const ERRORS = {
  invalid_credentials: 'VoIP.ms rejected the username or API password. Use your VoIP.ms login email and the API password (not your account password).',
  missing_credentials: 'Enter your VoIP.ms login email and API password.',
  api_not_enabled: 'The API is turned off in your VoIP.ms account. Turn it on under Main Menu → SOAP and REST/JSON API → Enable/Disable API.',
  ip_not_enabled: 'VoIP.ms blocked this server\'s IP address. Add it under Main Menu → SOAP and REST/JSON API → Enabled IP Addresses.',
  sms_toolong: 'The message is too long for VoIP.ms.',
  invalid_did: 'This number isn\'t a VoIP.ms DID on this account, or SMS isn\'t turned on for it.',
  invalid_dst: 'VoIP.ms says the destination number isn\'t valid.',
  missing_did: 'No sending number was given.',
  sms_failed: 'VoIP.ms could not send the text.',
  mms_failed: 'VoIP.ms could not send the picture message.',
  limit_reached: 'VoIP.ms says this account reached its messaging limit.',
  message_empty: 'The message is empty.',
};
const explain = (status) => ERRORS[status] ?? `VoIP.ms error: ${status}`;

// VoIP.ms wants 10-digit North American numbers
const tenDigits = (phone) => {
  const n = normalizePhone(phone);
  return n.length === 11 && n.startsWith('1') ? n.slice(1) : n;
};

async function call(creds, method, fields = {}) {
  const form = new URLSearchParams({ api_username: creds.username, api_password: creds.password, method, ...fields });
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`VoIP.ms returned ${res.status} ${res.statusText}: ${text.slice(0, 120)}`);
  }
  return json;
}

// Checks credentials with getBalance. Pass creds to test unsaved values.
export async function testConnection(creds = providerCredentials('voipms')) {
  if (!creds.username || !creds.password) return { ok: false, message: 'Enter both your VoIP.ms login email and API password' };
  let json;
  try {
    json = await call(creds, 'getBalance');
  } catch (err) {
    return { ok: false, message: `Could not reach VoIP.ms: ${err.message}` };
  }
  if (json.status !== 'success') return { ok: false, message: explain(json.status) };
  return { ok: true, message: 'Connected to VoIP.ms' };
}

export async function sendMessage({ from, to, body, mediaUrls = [] }) {
  if (to.length > 1) throw new Error('VoIP.ms can\'t send group texts. Text each person separately.');
  if (mediaUrls.length > MAX_MEDIA) throw new Error(`VoIP.ms allows up to ${MAX_MEDIA} attachments per message.`);
  const mms = mediaUrls.length > 0 || body.length > SMS_LIMIT;
  if (mms && body.length > MMS_LIMIT) throw new Error(`VoIP.ms messages can be up to ${MMS_LIMIT} characters.`);

  const fields = { did: tenDigits(from), dst: tenDigits(to[0]), message: body };
  mediaUrls.forEach((url, i) => (fields[`media${i + 1}`] = url));
  const json = await call(providerCredentials('voipms'), mms ? 'sendMMS' : 'sendSMS', fields);
  if (json.status !== 'success') throw new Error(explain(json.status));
  const id = json.sms ?? json.mms;
  return { refId: id != null ? `voipms-${id}` : null, results: [{ to: normalizePhone(to[0]), ok: true, status: 'success' }] };
}

// Query string of the callback request, "&"- or ";"-separated
export function parseCallback(rawQuery) {
  const q = String(rawQuery ?? '').replace(/^[?;]/, '');
  const params = new URLSearchParams(q.includes('&') ? q : q.replace(/;/g, '&'));
  const from = normalizePhone(params.get('from') ?? '');
  const to = normalizePhone(params.get('to') ?? '');
  if (!from || !to) return null;
  const media = String(params.get('media') ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s));
  const id = params.get('id');
  return { kind: 'message', from, to: [to], body: params.get('message') ?? '', media, refId: id ? `voipms-in-${id}` : null };
}
