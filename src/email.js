// Outgoing email over the SMTP server set in Admin settings → Email, and the
// six-digit codes it delivers: "Forgot password?" and the emailed sign-in code
// that stands in for a passkey or authenticator app you don't have with you.

import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { db, getSetting, setSetting } from './db.js';
import { config } from './config.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS email_codes (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose    TEXT NOT NULL,
    code_hash  TEXT NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, purpose)
  );
`);
if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'email')) db.exec("ALTER TABLE users ADD COLUMN email TEXT NOT NULL DEFAULT ''");

// ---------- SMTP settings ----------

const SECURITY = ['starttls', 'tls', 'none'];

export function smtpSettings() {
  return {
    host: getSetting('smtp.host') ?? '',
    port: Number(getSetting('smtp.port')) || 587,
    security: getSetting('smtp.security') ?? 'starttls',
    username: getSetting('smtp.username') ?? '',
    hasPassword: !!getSetting('smtp.password'),
    from: getSetting('smtp.from') ?? '',
  };
}

export const emailConfigured = () => !!(getSetting('smtp.host') && getSetting('smtp.from'));

// Blank password keeps the saved one
export function saveSmtp(body = {}) {
  const host = String(body.host ?? '').trim();
  const from = String(body.from ?? '').trim();
  const port = Number(body.port) || 587;
  if (!host) throw new Error('Enter the SMTP server');
  if (!validEmail(from.match(/<([^>]+)>/)?.[1] ?? from)) throw new Error('Enter the address emails come from, like textboss@yourpractice.com');
  if (port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535');
  setSetting('smtp.host', host);
  setSetting('smtp.port', String(port));
  setSetting('smtp.security', SECURITY.includes(body.security) ? body.security : 'starttls');
  setSetting('smtp.username', String(body.username ?? '').trim());
  if (body.password) setSetting('smtp.password', String(body.password));
  setSetting('smtp.from', from);
}

export function removeSmtp() {
  for (const k of ['host', 'port', 'security', 'username', 'password', 'from']) setSetting(`smtp.${k}`, null);
}

function transport() {
  const s = smtpSettings();
  const pass = getSetting('smtp.password');
  return nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.security === 'tls',
    requireTLS: s.security === 'starttls',
    ignoreTLS: s.security === 'none',
    auth: s.username ? { user: s.username, pass: pass ?? '' } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
}

export const validEmail = (v) => /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(String(v ?? '').trim());

export async function sendMail({ to, subject, text }) {
  if (!emailConfigured()) throw new Error('Email is not set up. An admin can add it under Admin settings → Email.');
  await transport().sendMail({ from: smtpSettings().from, to, subject, text });
}

// Show "j•••@gmail.com" so people know where to look without revealing the address
export function maskEmail(email) {
  const [name, domain] = String(email).split('@');
  return `${name.slice(0, 1)}${'•'.repeat(Math.min(5, Math.max(1, name.length - 1)))}@${domain}`;
}

// ---------- One-time email codes ----------

const CODE_TTL = 10 * 60_000;
const RESEND_AFTER = 30_000;
const MAX_ATTEMPTS = 5;
const hash = (userId, purpose, code) => crypto.createHash('sha256').update(`${userId}:${purpose}:${code}`).digest('hex');

// purpose: 'login' (second step) or 'reset' (forgot password)
export async function sendEmailCode(user, purpose) {
  if (!user.email) throw new Error('No email address is saved for this account');
  const existing = db.prepare('SELECT created_at FROM email_codes WHERE user_id = ? AND purpose = ?').get(user.id, purpose);
  if (existing && Date.now() - existing.created_at < RESEND_AFTER) return { throttled: true };

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const now = Date.now();
  db.prepare(`INSERT INTO email_codes (user_id, purpose, code_hash, attempts, expires_at, created_at) VALUES (?, ?, ?, 0, ?, ?)
    ON CONFLICT (user_id, purpose) DO UPDATE SET code_hash = excluded.code_hash, attempts = 0, expires_at = excluded.expires_at, created_at = excluded.created_at`)
    .run(user.id, purpose, hash(user.id, purpose, code), now + CODE_TTL, now);

  const site = new URL(config.publicUrl).host;
  const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
  const what = purpose === 'reset' ? 'reset your TextBoss password' : 'finish signing in to TextBoss';
  await sendMail({
    to: user.email,
    subject: `${spaced} is your TextBoss ${purpose === 'reset' ? 'password reset' : 'sign-in'} code`,
    text: `Hi ${user.display_name},\n\nEnter this code to ${what} (${site}):\n\n    ${spaced}\n\nIt expires in 10 minutes and works once.\n\nIf you didn't ask for this, someone may know your username${purpose === 'login' ? ' and password' : ''}. You can ignore this email${purpose === 'login' ? ', but consider changing your password' : ''}.\n`,
  });
  return { sent: true };
}

// True once for the right code; wrong guesses count, and five use the code up
export function checkEmailCode(userId, purpose, code) {
  const clean = String(code ?? '').replace(/\D/g, '');
  const row = db.prepare('SELECT * FROM email_codes WHERE user_id = ? AND purpose = ?').get(userId, purpose);
  if (!row || clean.length !== 6) return false;
  if (row.expires_at < Date.now() || row.attempts >= MAX_ATTEMPTS) {
    db.prepare('DELETE FROM email_codes WHERE user_id = ? AND purpose = ?').run(userId, purpose);
    return false;
  }
  const ok = crypto.timingSafeEqual(Buffer.from(row.code_hash), Buffer.from(hash(userId, purpose, clean)));
  if (ok) db.prepare('DELETE FROM email_codes WHERE user_id = ? AND purpose = ?').run(userId, purpose);
  else db.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE user_id = ? AND purpose = ?').run(userId, purpose);
  return ok;
}
