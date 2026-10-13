// Two-factor sign-in: authenticator-app codes (TOTP, RFC 6238), one-time
// backup codes, and passkeys / security keys (WebAuthn, via SimpleWebAuthn).

import crypto from 'node:crypto';
import QRCode from 'qrcode';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { db, getSetting } from './db.js';
import { config } from './config.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS backup_codes (
    id        INTEGER PRIMARY KEY,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    used_at   INTEGER
  );
  CREATE TABLE IF NOT EXISTS passkeys (
    id            INTEGER PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credential_id TEXT NOT NULL UNIQUE,
    public_key    TEXT NOT NULL,
    counter       INTEGER NOT NULL DEFAULT 0,
    transports    TEXT NOT NULL DEFAULT '[]',
    name          TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    last_used_at  INTEGER
  );
`);
for (const [col, def] of [['totp_secret', 'TEXT'], ['totp_pending', 'TEXT'], ['totp_last_step', 'INTEGER NOT NULL DEFAULT 0']]) {
  if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === col)) db.exec(`ALTER TABLE users ADD COLUMN ${col} ${def}`);
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

// ---------- Status ----------

export function mfaStatus(userId) {
  const u = db.prepare('SELECT totp_secret FROM users WHERE id = ?').get(userId);
  const passkeys = db.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?').get(userId).n;
  const backupLeft = db.prepare('SELECT COUNT(*) AS n FROM backup_codes WHERE user_id = ? AND used_at IS NULL').get(userId).n;
  return { totp: !!u?.totp_secret, passkeys, backupLeft, enabled: !!u?.totp_secret || passkeys > 0 };
}

export const mfaRequired = () => getSetting('security.require2fa') === '1';

export function resetMfa(userId) {
  db.prepare('UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_last_step = 0 WHERE id = ?').run(userId);
  db.prepare('DELETE FROM passkeys WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM backup_codes WHERE user_id = ?').run(userId);
}

// ---------- TOTP ----------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of str.replace(/[\s=]/g, '').toUpperCase()) {
    const i = B32.indexOf(ch);
    if (i < 0) continue;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function totpAt(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, '0');
}

// Returns the matched time step, or null. Accepts one step of clock drift either
// way and refuses a step already used, so a code can't be replayed.
function matchTotp(secret, code, lastStep) {
  const clean = String(code ?? '').replace(/\D/g, '');
  if (clean.length !== 6) return null;
  const now = Math.floor(Date.now() / 30_000);
  for (const step of [now - 1, now, now + 1]) {
    if (step <= lastStep) continue;
    if (crypto.timingSafeEqual(Buffer.from(totpAt(secret, step)), Buffer.from(clean))) return step;
  }
  return null;
}

export async function startTotpSetup(user) {
  const secret = base32Encode(crypto.randomBytes(20));
  db.prepare('UPDATE users SET totp_pending = ? WHERE id = ?').run(secret, user.id);
  const host = new URL(config.publicUrl).hostname;
  const label = encodeURIComponent(`TextBoss (${host}):${user.username}`);
  const uri = `otpauth://totp/${label}?secret=${secret}&issuer=TextBoss&algorithm=SHA1&digits=6&period=30`;
  const qrSvg = await QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  return { secret: secret.replace(/(.{4})/g, '$1 ').trim(), uri, qrSvg };
}

// Confirms the first code from the app, then turns TOTP on
export function finishTotpSetup(userId, code) {
  const u = db.prepare('SELECT totp_pending FROM users WHERE id = ?').get(userId);
  if (!u?.totp_pending) return false;
  const step = matchTotp(u.totp_pending, code, 0);
  if (step == null) return false;
  db.prepare('UPDATE users SET totp_secret = totp_pending, totp_pending = NULL, totp_last_step = ? WHERE id = ?').run(step, userId);
  return true;
}

export function disableTotp(userId) {
  db.prepare('UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_last_step = 0 WHERE id = ?').run(userId);
}

// ---------- Backup codes ----------

const hashCode = (code) => crypto.createHash('sha256').update(String(code).toLowerCase().replace(/[^a-z0-9]/g, '')).digest('hex');

// Ten new codes like "7kq2-m9xr"; replaces any old ones. Shown once.
export function newBackupCodes(userId) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'; // no look-alikes (0/o, 1/l/i)
  const codes = Array.from({ length: 10 }, () => {
    const bytes = crypto.randomBytes(8);
    const raw = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  });
  db.prepare('DELETE FROM backup_codes WHERE user_id = ?').run(userId);
  const ins = db.prepare('INSERT INTO backup_codes (user_id, code_hash) VALUES (?, ?)');
  for (const c of codes) ins.run(userId, hashCode(c));
  return codes;
}

// ---------- Second step after the password ----------

// A code from the authenticator app or an unused backup code
export function verifySecondFactorCode(userId, code) {
  const u = db.prepare('SELECT totp_secret, totp_last_step FROM users WHERE id = ?').get(userId);
  if (u?.totp_secret) {
    const step = matchTotp(u.totp_secret, code, u.totp_last_step);
    if (step != null) {
      db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, userId);
      return 'totp';
    }
  }
  const backup = db.prepare('SELECT id FROM backup_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL').get(userId, hashCode(code));
  if (backup) {
    db.prepare('UPDATE backup_codes SET used_at = ? WHERE id = ?').run(Date.now(), backup.id);
    return 'backup';
  }
  return null;
}

// Password accepted, second factor still needed: a short-lived ticket for the next step
const pending = new Map(); // token -> { userId, expires }

export function createPendingLogin(userId) {
  const token = crypto.randomBytes(24).toString('base64url');
  pending.set(token, { userId, expires: Date.now() + 5 * 60_000 });
  return token;
}

export function pendingLogin(token) {
  const p = pending.get(String(token ?? ''));
  if (!p || p.expires < Date.now()) {
    pending.delete(token);
    return null;
  }
  return p;
}

export const endPendingLogin = (token) => pending.delete(token);

// ---------- Passkeys (WebAuthn) ----------
//
// Passkeys are bound to the site's domain, taken from PUBLIC_URL, and only
// work over HTTPS (or http://localhost).

const rp = () => {
  const url = new URL(config.publicUrl);
  return { rpID: url.hostname, origin: url.origin };
};
export const passkeysAvailable = () => {
  const url = new URL(config.publicUrl);
  return url.protocol === 'https:' || url.hostname === 'localhost';
};

const challenges = new Map(); // key -> { challenge, expires }
function remember(key, challenge) {
  challenges.set(key, { challenge, expires: Date.now() + 5 * 60_000 });
}
function recall(key) {
  const c = challenges.get(key);
  challenges.delete(key);
  return c && c.expires > Date.now() ? c.challenge : null;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, c] of challenges) if (c.expires < now) challenges.delete(k);
  for (const [k, p] of pending) if (p.expires < now) pending.delete(k);
}, 60_000).unref();

export function listPasskeys(userId) {
  return db.prepare('SELECT id, name, created_at AS createdAt, last_used_at AS lastUsedAt FROM passkeys WHERE user_id = ? ORDER BY id').all(userId);
}

export async function passkeyRegistrationOptions(user) {
  const existing = db.prepare('SELECT credential_id, transports FROM passkeys WHERE user_id = ?').all(user.id);
  const options = await generateRegistrationOptions({
    rpName: 'TextBoss',
    rpID: rp().rpID,
    userName: user.username,
    userDisplayName: user.display_name ?? user.username,
    userID: new TextEncoder().encode(`textboss-${user.id}`),
    attestationType: 'none',
    excludeCredentials: existing.map((c) => ({ id: c.credential_id, transports: JSON.parse(c.transports) })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });
  remember(`reg:${user.id}`, options.challenge);
  return options;
}

export async function finishPasskeyRegistration(user, response, name) {
  const expectedChallenge = recall(`reg:${user.id}`);
  if (!expectedChallenge) throw new Error('That took too long. Try adding the passkey again.');
  const { origin, rpID } = rp();
  const result = await verifyRegistrationResponse({ response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: false });
  if (!result.verified || !result.registrationInfo) throw new Error('The passkey could not be verified');
  const { credential } = result.registrationInfo;
  db.prepare(
    'INSERT INTO passkeys (user_id, credential_id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(user.id, credential.id, b64url(credential.publicKey), credential.counter, JSON.stringify(credential.transports ?? []),
    String(name || 'Passkey').slice(0, 60), Date.now());
}

// forUserId: the password was already entered (passkey as second factor).
// Without it, it's a passwordless sign-in and the passkey must verify the person (PIN/biometric).
export async function passkeyLoginOptions(forUserId) {
  const allow = forUserId
    ? db.prepare('SELECT credential_id, transports FROM passkeys WHERE user_id = ?').all(forUserId)
    : [];
  const options = await generateAuthenticationOptions({
    rpID: rp().rpID,
    allowCredentials: allow.map((c) => ({ id: c.credential_id, transports: JSON.parse(c.transports) })),
    userVerification: forUserId ? 'preferred' : 'required',
  });
  const challengeId = crypto.randomBytes(16).toString('base64url');
  remember(`auth:${challengeId}`, options.challenge);
  return { options, challengeId };
}

// Returns the user id the passkey belongs to
export async function finishPasskeyLogin(challengeId, response, forUserId) {
  const expectedChallenge = recall(`auth:${challengeId}`);
  if (!expectedChallenge) throw new Error('That took too long. Try again.');
  const row = db.prepare('SELECT * FROM passkeys WHERE credential_id = ?').get(String(response?.id ?? ''));
  if (!row) throw new Error('That passkey is not registered with TextBoss');
  if (forUserId && row.user_id !== forUserId) throw new Error('That passkey belongs to a different account');
  const { origin, rpID } = rp();
  const result = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    credential: {
      id: row.credential_id,
      publicKey: Buffer.from(row.public_key, 'base64url'),
      counter: row.counter,
      transports: JSON.parse(row.transports),
    },
    requireUserVerification: !forUserId,
  });
  if (!result.verified) throw new Error('The passkey could not be verified');
  db.prepare('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?').run(result.authenticationInfo.newCounter, Date.now(), row.id);
  return row.user_id;
}

export function removePasskey(userId, id) {
  db.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?').run(Number(id), userId);
}

// For tests and the CLI
export const _test = { totpAt, base32Decode, base32Encode, matchTotp };
