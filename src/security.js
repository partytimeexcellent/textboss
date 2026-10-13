// Brute-force protection and HTTP security headers.

import { config } from './config.js';
import { HttpError } from './http.js';

// ---------- Login throttling ----------
//
// Failed sign-in attempts are counted per username and per IP address over a
// 15-minute window. Past the limit, further attempts are refused (even with
// the right password) until the lock expires. Kept in memory: a restart clears it.

const WINDOW_MS = 15 * 60_000;
const LIMITS = { user: 8, ip: 30, mfa: 6 };
const buckets = new Map(); // key -> { count, first, lockedUntil }

function bucket(key) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || (now - b.first > WINDOW_MS && (!b.lockedUntil || b.lockedUntil < now))) {
    b = { count: 0, first: now, lockedUntil: 0 };
    buckets.set(key, b);
  }
  return b;
}

const keysFor = (req, username) => [
  [`ip:${req.ip}`, LIMITS.ip],
  ...(username ? [[`user:${String(username).trim().toLowerCase()}`, LIMITS.user]] : []),
];

// Throws 429 if this IP or username is locked out
export function assertNotLocked(req, username, extraKeys = []) {
  const now = Date.now();
  for (const [key] of [...keysFor(req, username), ...extraKeys]) {
    const b = buckets.get(key);
    if (b?.lockedUntil > now) {
      const minutes = Math.ceil((b.lockedUntil - now) / 60_000);
      throw new HttpError(429, `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`, { code: 'locked' });
    }
  }
}

export function recordFailure(req, username, extraKeys = []) {
  for (const [key, limit] of [...keysFor(req, username), ...extraKeys]) {
    const b = bucket(key);
    b.count++;
    if (b.count >= limit) b.lockedUntil = Date.now() + WINDOW_MS;
  }
}

export function recordSuccess(req, username) {
  if (username) buckets.delete(`user:${String(username).trim().toLowerCase()}`);
}

export const mfaKey = (userId) => [`mfa:${userId}`, LIMITS.mfa];

// Forget stale entries so the map doesn't grow forever
setInterval(() => {
  const now = Date.now();
  for (const [key, b] of buckets) if (now - b.first > WINDOW_MS && b.lockedUntil < now) buckets.delete(key);
}, 5 * 60_000).unref();

// ---------- Security headers ----------

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'", // the UI sets some inline style attributes
  "img-src 'self' data: blob: https:", // incoming MMS pictures are hosted by BulkVS
  "media-src 'self' blob: https:",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  // Uploaded files and icons can never run anything, even if opened directly
  const isFile = req.path.startsWith('/media/') || req.path.startsWith('/icons/');
  res.setHeader('Content-Security-Policy', isFile ? "default-src 'none'; img-src 'self'; media-src 'self'; sandbox" : CSP);
  if (req.secure || String(req.headers['x-forwarded-proto'] ?? '').startsWith('https') || config.publicUrl.startsWith('https://')) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
  next();
}
