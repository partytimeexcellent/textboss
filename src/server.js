import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config.js';
import { isMockMode, providerCredentials, activeProvider, PROVIDERS } from './provider.js';
import {
  db,
  getOrCreateConversation,
  userNumberIds,
  userCanAccessNumber,
  allUserIds,
  userIdsForNumber,
  getSetting,
  setSetting,
} from './db.js';
import {
  loadUser,
  requireUser,
  requireAdmin,
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  sessionToken,
} from './auth.js';
import { subscribe, publish } from './events.js';
import { normalizePhone, isValidPhone, participantsKey } from './phone.js';
import { parseWebhook, testConnection as testBulkvs } from './bulkvs.js';
import { parseCallback as parseVoipms, testConnection as testVoipms } from './voipms.js';
import { recordInbound, sendOutbound, applyReceipt, listMessages, resumeBroadcasts, cleanUpStoredReceipts } from './messaging.js';
import { fail } from './http.js';
import { securityHeaders, assertNotLocked, recordFailure, recordSuccess, mfaKey } from './security.js';
import * as mfa from './mfa.js';
import {
  parseContactFile, upsertContacts, logImport, idleDays, idleCandidates, inactivateIdle, autoInactivateMissing, startIdleJob,
} from './contacts.js';
import { router as contactsRouter } from './routes/contacts.js';
import { router as importApi, createApiKey } from './routes/importApi.js';
import { startWatcher } from './watcher.js';
import { backupStream, stageRestore } from './backup.js';
import * as email from './email.js';
import { getHours, saveHours, hoursStatus } from './hours.js';
import { vapidPublicKey, saveSubscription, removeSubscription, subscriptionStatus, setPaused, pushToUsers, unreadTotal } from './push.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Changes whenever a deploy changes the web app, so open windows can offer a reload
const appVersion = (() => {
  const hash = crypto.createHash('sha256');
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      if (fs.statSync(file).isDirectory()) walk(file);
      else hash.update(name).update(fs.readFileSync(file));
    }
  };
  walk(path.join(root, 'public'));
  return hash.digest('hex').slice(0, 12);
})();
const mediaDir = path.join(config.dataDir, 'media');
const iconDir = path.join(config.dataDir, 'icons');
fs.mkdirSync(mediaDir, { recursive: true });

const app = express();
app.disable('x-powered-by');
// Trust X-Forwarded-* from a reverse proxy on the local/private network (e.g. Pangolin),
// so login throttling sees the real client IP
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback, linklocal, uniquelocal');
app.use(securityHeaders);

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

const secretMatches = (given) => {
  const a = Buffer.from(String(given));
  const b = Buffer.from(config.webhookSecret);
  return !!config.webhookSecret && a.length === b.length && crypto.timingSafeEqual(a, b);
};

function logWebhook(raw, result) {
  db.prepare('INSERT INTO webhook_log (received_at, body, result) VALUES (?, ?, ?)').run(Date.now(), raw, JSON.stringify(result));
  db.prepare('DELETE FROM webhook_log WHERE id <= (SELECT MAX(id) - 500 FROM webhook_log)').run();
  if (!result.ok) console.warn('webhook not applied:', result.reason, raw.slice(0, 500));
}

// VoIP.ms "SMS URL Callback": fields arrive in the URL, after "?" with "&" or
// straight after the secret with ";" (both are accepted), and VoIP.ms expects
// the plain text "ok" back or it retries.
app.all(
  '/webhook/voipms/:secret',
  express.urlencoded({ extended: false, limit: '1mb' }),
  (req, res) => {
    const marker = '/webhook/voipms/';
    const tail = req.originalUrl.slice(req.originalUrl.indexOf(marker) + marker.length);
    const secret = decodeURIComponent(tail.split(/[;?]/)[0]);
    if (!secretMatches(secret)) return res.sendStatus(404);

    let query = tail.slice(tail.split(/[;?]/)[0].length);
    if (req.method === 'POST' && req.body && Object.keys(req.body).length) query = `?${new URLSearchParams(req.body)}`;
    const raw = `${req.method} ${query}`;
    let result;
    try {
      const event = parseVoipms(query);
      result = event ? recordInbound(event) : { ok: false, reason: 'unrecognized callback (needs to and from)' };
    } catch (err) {
      result = { ok: false, reason: err.message };
    }
    logWebhook(raw, result);
    res.type('text/plain').send('ok');
  },
);

// ---------- Public media (MMS attachments must be fetchable by carriers) ----------

app.use(
  '/media',
  express.static(mediaDir, { fallthrough: false, maxAge: '365d', immutable: true }),
);

// ---------- Contact import API (API key, no session) ----------

app.use('/api/v1', importApi);

// ---------- App ----------

app.use(express.json({ limit: '1mb' }));
app.use(loadUser);
// no-cache = revalidate each load, so browsers pick up new app code after a deploy
// Per-user app manifest, so an installed app gets that user's custom icon
app.get('/manifest.webmanifest', (req, res) => {
  const base = JSON.parse(fs.readFileSync(path.join(root, 'public', 'manifest.webmanifest'), 'utf8'));
  const iconId = req.user && JSON.parse(db.prepare('SELECT theme FROM users WHERE id = ?').get(req.user.id)?.theme ?? 'null')?.iconId;
  if (iconId && fs.existsSync(path.join(iconDir, `${iconId}-maskable.png`))) {
    base.icons = [
      { src: `/icons/${iconId}-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: `/icons/${iconId}-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: `/icons/${iconId}-maskable.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ];
  }
  res.setHeader('Cache-Control', 'no-cache');
  res.type('application/manifest+json').send(JSON.stringify(base));
});
app.use('/icons', express.static(iconDir, { fallthrough: false, maxAge: '365d', immutable: true }));
app.use(express.static(path.join(root, 'public'), { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

const api = express.Router();
app.use('/api', api);

// First-run setup: create the initial admin when there are no users yet
api.get('/version', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ version: appVersion });
});

api.get('/setup', (_req, res) => {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  res.json({ needed: n === 0, mockMode: isMockMode(), passkeys: mfa.passkeysAvailable(), origin: new URL(config.publicUrl).origin, email: email.emailConfigured() });
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
  assertNotLocked(req, username);
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username ?? '').trim());
  if (!user || !verifyPassword(String(password ?? ''), user.password_hash)) {
    recordFailure(req, username);
    fail(401, 'Wrong username or password');
  }
  recordSuccess(req, username);
  const status = mfa.mfaStatus(user.id);
  if (status.enabled) {
    // Password is right; the second step finishes signing in
    return res.json({
      mfa: {
        token: mfa.createPendingLogin(user.id),
        totp: status.totp,
        passkey: status.passkeys > 0 && mfa.passkeysAvailable(),
        email: user.email && email.emailConfigured() ? email.maskEmail(user.email) : null,
      },
    });
  }
  createSession(res, user.id);
  res.json({ ok: true });
});

// Second step, emailed code: sends it
api.post('/login/email', async (req, res) => {
  const p = mfa.pendingLogin(req.body?.token);
  if (!p) fail(401, 'Your sign-in expired. Enter your password again.');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(p.userId);
  try {
    await email.sendEmailCode(user, 'login');
  } catch (err) {
    console.error('sign-in code email failed', err.message);
    fail(502, 'The email could not be sent. Ask your administrator to check Admin settings → Email.');
  }
  res.json({ ok: true, sentTo: email.maskEmail(user.email) });
});

// Second step: a code from the authenticator app or from the email
api.post('/login/mfa', (req, res) => {
  const p = mfa.pendingLogin(req.body?.token);
  if (!p) fail(401, 'Your sign-in expired. Enter your password again.');
  assertNotLocked(req, null, [mfaKey(p.userId)]);
  const ok = req.body?.method === 'email'
    ? email.checkEmailCode(p.userId, 'login', req.body?.code)
    : mfa.verifyTotpCode(p.userId, req.body?.code);
  if (!ok) {
    recordFailure(req, null, [mfaKey(p.userId)]);
    fail(401, req.body?.method === 'email'
      ? 'That code is not right or has expired. Check the latest email, or send a new code.'
      : 'That code is not right. Check the time on your phone, or email yourself a code instead.');
  }
  mfa.endPendingLogin(req.body.token);
  createSession(res, p.userId);
  res.json({ ok: true });
});

// ----- Forgot password: a code is emailed, then code + new password -----

const findLogin = (login) => {
  const v = String(login ?? '').trim();
  if (!v) return null;
  return db.prepare('SELECT * FROM users WHERE username = ?').get(v)
    ?? (email.validEmail(v) ? db.prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE AND email != ''").get(v) : null);
};

api.post('/password/forgot', async (req, res) => {
  if (!email.emailConfigured()) fail(400, 'Password reset by email is not set up. Ask your administrator to reset it.');
  assertNotLocked(req, null);
  const user = findLogin(req.body?.login);
  // Same answer whether or not the account exists, so this can't be used to find usernames
  if (user?.email) {
    try {
      await email.sendEmailCode(user, 'reset');
    } catch (err) {
      console.error('reset email failed', err.message);
      fail(502, 'The email could not be sent. Ask your administrator to check Admin settings → Email.');
    }
  }
  recordFailure(req, null); // every request counts toward the per-IP limit, so inboxes can't be flooded
  res.json({ ok: true });
});

api.post('/password/reset', (req, res) => {
  const user = findLogin(req.body?.login);
  const keys = user ? [mfaKey(user.id)] : [];
  assertNotLocked(req, null, keys);
  const { password } = req.body ?? {};
  if (!password || String(password).length < 8) fail(400, 'New password must be at least 8 characters');
  if (!user || !email.checkEmailCode(user.id, 'reset', req.body?.code)) {
    recordFailure(req, null, keys);
    fail(400, 'That code is not right or has expired. Check the latest email, or send a new code.');
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id); // sign out everywhere else
  recordSuccess(req, user.username);
  // Proving the email is the same as the emailed sign-in code, so sign straight in
  createSession(res, user.id);
  res.json({ ok: true });
});

// Passkey sign-in: after the password (token) or on its own (passwordless)
api.post('/login/passkey/options', async (req, res) => {
  if (!mfa.passkeysAvailable()) fail(400, 'Passkeys need TextBoss to be opened over HTTPS');
  const p = req.body?.token ? mfa.pendingLogin(req.body.token) : null;
  if (req.body?.token && !p) fail(401, 'Your sign-in expired. Enter your password again.');
  res.json(await mfa.passkeyLoginOptions(p?.userId));
});

api.post('/login/passkey', async (req, res) => {
  assertNotLocked(req, null);
  const p = req.body?.token ? mfa.pendingLogin(req.body.token) : null;
  if (req.body?.token && !p) fail(401, 'Your sign-in expired. Enter your password again.');
  let userId;
  try {
    userId = await mfa.finishPasskeyLogin(String(req.body?.challengeId ?? ''), req.body?.response, p?.userId);
  } catch (err) {
    recordFailure(req, null);
    fail(401, err.message);
  }
  if (p) mfa.endPendingLogin(req.body.token);
  createSession(res, userId);
  res.json({ ok: true });
});

api.post('/logout', (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});

api.use(requireUser);

// When the admin requires 2FA, people without it can only reach setup
const SETUP_PATHS = /^\/(me(\/(security|totp\/.*|passkeys.*|email))?|logout|version|setup)$/;
api.use((req, res, next) => {
  if (mfa.mfaRequired() && !mfa.mfaStatus(req.user.id).enabled && !SETUP_PATHS.test(req.path)) {
    fail(403, 'Your administrator requires two-factor sign-in. Set it up to continue.', { code: 'mfa_setup_required' });
  }
  next();
});

// Re-entering the password guards removing a sign-in method
function confirmPassword(req) {
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(String(req.body?.password ?? ''), row.password_hash)) fail(400, 'Your current password is not right');
}
// Keep at least one method while 2FA is required
function assertCanRemove(req, remaining) {
  if (mfa.mfaRequired() && remaining === 0) fail(400, 'Two-factor sign-in is required here, so keep at least one method. Add another before removing this one.');
}

api.get('/me/security', (req, res) => {
  res.json({
    ...mfa.mfaStatus(req.user.id),
    required: mfa.mfaRequired(),
    passkeysAvailable: mfa.passkeysAvailable(),
    origin: new URL(config.publicUrl).origin,
    passkeyList: mfa.listPasskeys(req.user.id),
    email: db.prepare('SELECT email FROM users WHERE id = ?').get(req.user.id).email,
    emailConfigured: email.emailConfigured(),
    sessions: db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?').get(req.user.id, Date.now()).n,
  });
});

api.post('/me/totp/setup', async (req, res) => res.json(await mfa.startTotpSetup(req.user)));

api.post('/me/totp/enable', (req, res) => {
  if (!mfa.finishTotpSetup(req.user.id, req.body?.code)) fail(400, 'That code is not right. Enter the current 6-digit code from the app.');
  res.json({ ok: true });
});

api.post('/me/totp/disable', (req, res) => {
  confirmPassword(req);
  const s = mfa.mfaStatus(req.user.id);
  assertCanRemove(req, s.passkeys);
  mfa.disableTotp(req.user.id);
  res.json({ ok: true });
});

// Your email: for "Forgot password?" and emailed sign-in codes
api.post('/me/email', (req, res) => {
  confirmPassword(req);
  const value = String(req.body?.email ?? '').trim();
  if (value && !email.validEmail(value)) fail(400, 'That email address doesn\'t look right');
  if (value && db.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE AND id != ?').get(value, req.user.id)) fail(409, 'Another user already has that email address');
  db.prepare('UPDATE users SET email = ? WHERE id = ?').run(value, req.user.id);
  res.json({ ok: true, email: value });
});

api.post('/me/email/test', async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user.email) fail(400, 'Save your email address first');
  try {
    await email.sendMail({ to: user.email, subject: 'TextBoss test email', text: `Hi ${user.display_name},\n\nEmail from TextBoss reaches you. "Forgot password?" and emailed sign-in codes will arrive here.\n` });
  } catch (err) {
    fail(502, `Couldn't send: ${err.message}`);
  }
  res.json({ ok: true });
});

api.post('/me/passkeys/options', async (req, res) => {
  if (!mfa.passkeysAvailable()) fail(400, 'Passkeys need TextBoss to be opened over HTTPS');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json(await mfa.passkeyRegistrationOptions(user));
});

api.post('/me/passkeys', async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  try {
    await mfa.finishPasskeyRegistration(user, req.body?.response, req.body?.name);
  } catch (err) {
    fail(400, err.message);
  }
  res.json({ ok: true });
});

api.post('/me/passkeys/:id/remove', (req, res) => {
  confirmPassword(req);
  const s = mfa.mfaStatus(req.user.id);
  assertCanRemove(req, (s.totp ? 1 : 0) + s.passkeys - 1);
  mfa.removePasskey(req.user.id, req.params.id);
  res.json({ ok: true });
});

// Sign out everywhere except this browser
api.post('/me/sessions/revoke-others', (req, res) => {
  const { changes } = db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, sessionToken(req));
  res.json({ ok: true, signedOut: changes });
});

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
    mockMode: isMockMode(),
    provider: activeProvider(),
    security: { required: mfa.mfaRequired(), enabled: mfa.mfaStatus(req.user.id).enabled },
    tourDone: !!db.prepare('SELECT tour_done_at FROM users WHERE id = ?').get(req.user.id).tour_done_at,
    theme: JSON.parse(db.prepare('SELECT theme FROM users WHERE id = ?').get(req.user.id).theme ?? 'null'),
  });
});

// The welcome tour is shown until someone finishes or closes it once
api.post('/me/tour', (req, res) => {
  db.prepare('UPDATE users SET tour_done_at = ? WHERE id = ?').run(Date.now(), req.user.id);
  res.json({ ok: true });
});

// Appearance: { preset, accent, highlight, mode, logo, labelOwn } chosen in the theme picker
api.put('/me/theme', (req, res) => {
  const t = req.body ?? {};
  const color = (v) => (/^#[0-9a-f]{6}$/i.test(v ?? '') ? v : undefined);
  const current = JSON.parse(db.prepare('SELECT theme FROM users WHERE id = ?').get(req.user.id).theme ?? '{}') ?? {};
  const l = t.logo;
  const theme = {
    preset: String(t.preset ?? 'custom').slice(0, 30),
    accent: color(t.accent),
    highlight: color(t.highlight),
    mode: ['auto', 'light', 'dark'].includes(t.mode) ? t.mode : 'auto',
    // App icon design (drawn in the browser; see public/js/logo.js)
    logo: l && typeof l === 'object'
      ? {
          preset: String(l.preset ?? 'custom').slice(0, 30),
          bg: (Array.isArray(l.bg) ? l.bg : []).slice(0, 3).map((c) => color(c) ?? null),
          angle: ['up', 'down', 'diag', 'solid'].includes(l.angle) ? l.angle : 'diag',
          c1: color(l.c1),
          c2: color(l.c2),
          scale: Math.min(1.3, Math.max(0.6, Number(l.scale) || 1)),
        }
      : current.logo,
    iconId: /^[0-9a-f]{16}$/.test(t.iconId ?? '') ? t.iconId : current.iconId,
    // Name tag on your own sent messages (other staff are always tagged)
    labelOwn: typeof t.labelOwn === 'boolean' ? t.labelOwn : !!current.labelOwn,
  };
  db.prepare('UPDATE users SET theme = ? WHERE id = ?').run(JSON.stringify(theme), req.user.id);
  res.json(theme);
});

// Home-screen icon PNGs drawn by the browser for this user's logo design.
// Stored by content hash, so the URLs are stable and safe to cache forever.
api.post('/me/icon', express.json({ limit: '3mb' }), (req, res) => {
  const pngs = {};
  for (const size of [180, 192, 512, 'maskable']) {
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(req.body?.[size] ?? '');
    const buf = m && Buffer.from(m[1], 'base64');
    if (!buf || buf.length > 1024 * 1024 || buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') fail(400, `Missing or invalid ${size}px icon`);
    pngs[size] = buf;
  }
  const hash = crypto.createHash('sha256');
  for (const buf of Object.values(pngs)) hash.update(buf);
  const iconId = hash.digest('hex').slice(0, 16);
  fs.mkdirSync(iconDir, { recursive: true });
  for (const [size, buf] of Object.entries(pngs)) fs.writeFileSync(path.join(iconDir, `${iconId}-${size}.png`), buf);
  res.json({ iconId });
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

// ----- Push notifications (per device) -----

api.get('/push/key', (_req, res) => res.json({ publicKey: vapidPublicKey() }));

api.post('/push/subscribe', (req, res) => {
  try {
    saveSubscription(req.user.id, req.body?.subscription, { preview: req.body?.preview !== false, userAgent: req.headers['user-agent'] });
  } catch (err) {
    fail(400, err.message);
  }
  res.json({ ok: true });
});

api.post('/push/unsubscribe', (req, res) => {
  if (req.body?.endpoint) removeSubscription(String(req.body.endpoint));
  res.json({ ok: true });
});

api.post('/push/status', (req, res) => res.json(subscriptionStatus(String(req.body?.endpoint ?? ''))));

// The bell button: pause or resume alerts on one device
api.post('/push/pause', (req, res) => {
  if (!setPaused(req.user.id, String(req.body?.endpoint ?? ''), !!req.body?.paused)) fail(400, 'Notifications are not turned on for this device yet');
  res.json({ ok: true, paused: !!req.body?.paused });
});

api.post('/push/test', async (req, res) => {
  const endpoint = String(req.body?.endpoint ?? '');
  const sub = db.prepare('SELECT 1 FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').get(req.user.id, endpoint);
  if (!sub) fail(400, 'Notifications are not turned on for this device yet');
  await pushToUsers([req.user.id], (_u, preview) => ({
    title: preview ? 'TextBoss test' : 'TextBoss',
    body: preview ? 'Notifications are working on this device.' : 'New message',
    url: '/#/',
    tag: 'test',
  }), { onlyEndpoint: endpoint });
  res.json({ ok: true });
});

// Total unread for the app-icon badge
api.get('/badge', (req, res) => res.json({ unread: unreadTotal(req.user) }));

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

  const unreadSql = `(SELECT COUNT(*) FROM messages mu
      WHERE mu.conversation_id = c.id AND mu.direction = 'in'
        AND mu.id > COALESCE((SELECT last_read_id FROM reads r WHERE r.user_id = ? AND r.conversation_id = c.id), 0))`;
  const filter = req.query.archived === '1' ? 'archived' : String(req.query.filter ?? '');

  const params = [req.user.id, ...ids];
  let where = `c.number_id IN (${ids.map(() => '?').join(',')}) AND c.archived = ?`;
  params.push(filter === 'archived' ? 1 : 0);
  if (filter === 'flagged') where += ' AND c.flagged = 1';
  if (filter === 'unread') {
    where += ` AND ${unreadSql} > 0`;
    params.push(req.user.id);
  }

  const q = String(req.query.q ?? '').trim();
  if (q) {
    const digits = q.replace(/\D/g, '');
    where += ` AND (
      EXISTS (SELECT 1 FROM messages m2 WHERE m2.conversation_id = c.id AND m2.body LIKE ?)
      OR EXISTS (SELECT 1 FROM contacts ct
                 WHERE (ct.first_name || ' ' || ct.last_name LIKE ? OR ct.last_name || ' ' || ct.first_name LIKE ? OR ct.nickname LIKE ? OR ct.patient_id = ?)
                   AND ct.phone != '' AND (',' || c.participants || ',') LIKE ('%,' || ct.phone || ',%'))
      ${digits.length >= 3 ? 'OR c.participants LIKE ?' : ''}
    )`;
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, q);
    if (digits.length >= 3) params.push(`%${digits}%`);
  }

  const rows = db
    .prepare(
      `SELECT c.id, c.number_id, c.participants, c.last_message_at, c.archived, c.pinned, c.flagged,
         lm.body AS last_body, lm.direction AS last_direction, lm.media AS last_media, lm.status AS last_status,
         ${unreadSql} AS unread
       FROM conversations c
       LEFT JOIN messages lm ON lm.id = (SELECT MAX(id) FROM messages WHERE conversation_id = c.id)
       WHERE ${where}
       ORDER BY c.pinned DESC, c.last_message_at DESC
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
      pinned: !!r.pinned,
      flagged: !!r.flagged,
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
  if (to.length > 1 && activeProvider() === 'voipms' && !isMockMode()) {
    fail(400, 'VoIP.ms can\'t send group texts. Text each person separately, or use a bulk message to reach several people.');
  }

  const conversation = getOrCreateConversation(numberId, participantsKey(to));
  res.json({ id: conversation.id });
});

api.get('/conversations/:id', (req, res) => {
  const c = loadConversation(req);
  res.json({
    id: c.id,
    numberId: c.number_id,
    participants: c.participants.split(','),
    archived: !!c.archived,
    pinned: !!c.pinned,
    flagged: !!c.flagged,
  });
});

// Pin to the top of the list, or flag as important. Shared by the whole team.
for (const field of ['pinned', 'flagged']) {
  api.post(`/conversations/:id/${field === 'pinned' ? 'pin' : 'flag'}`, (req, res) => {
    const c = loadConversation(req);
    const on = !!req.body?.[field];
    db.prepare(`UPDATE conversations SET ${field} = ? WHERE id = ?`).run(on ? 1 : 0, c.id);
    publish(userIdsForNumber(c.number_id), 'read', { conversationId: c.id });
    res.json({ ok: true, [field]: on });
  });
}

// Downloads an attachment. External (BulkVS-hosted) files are fetched by the
// server so the browser gets a real download instead of opening a new tab.
api.get('/messages/:id/media/:index', async (req, res) => {
  const msg = db.prepare('SELECT m.id, m.media, c.number_id FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = ?')
    .get(Number(req.params.id));
  if (!msg || !userCanAccessNumber(req.user, msg.number_id)) fail(404, 'Not found');
  const url = JSON.parse(msg.media)[Number(req.params.index)];
  if (!url) fail(404, 'Not found');

  const base = path.basename(new URL(url).pathname) || `attachment-${msg.id}`;
  const filename = base.replace(/[^\w.-]+/g, '_').slice(0, 100);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const localPrefix = `${config.publicUrl}/media/`;
  if (url.startsWith(localPrefix)) {
    const file = path.join(mediaDir, path.basename(url.slice(localPrefix.length)));
    if (!fs.existsSync(file)) fail(404, 'File no longer exists');
    return res.sendFile(file);
  }

  let upstream;
  try {
    upstream = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: 'follow' });
  } catch (err) {
    fail(502, `Could not fetch the attachment: ${err.message}`);
  }
  if (!upstream.ok) fail(502, `The attachment host returned ${upstream.status}`);
  const size = Number(upstream.headers.get('content-length') ?? 0);
  if (size > 50 * 1024 * 1024) fail(413, 'Attachment is too large to download here');
  res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'application/octet-stream');
  res.send(Buffer.from(await upstream.arrayBuffer()));
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
  const message = await sendOutbound({
    conversation,
    number,
    user: req.user,
    body,
    media,
    confirmOptOut: req.body?.confirmOptOut === true,
  });
  res.json(message);
});

// Marks the conversation unread for this user, from the latest inbound message on
api.post('/conversations/:id/unread', (req, res) => {
  const c = loadConversation(req);
  const last = db.prepare(`SELECT MAX(id) AS id FROM messages WHERE conversation_id = ? AND direction = 'in'`).get(c.id);
  if (last.id) {
    db.prepare(
      `INSERT INTO reads (user_id, conversation_id, last_read_id) VALUES (?, ?, ?)
       ON CONFLICT (user_id, conversation_id) DO UPDATE SET last_read_id = excluded.last_read_id`,
    ).run(req.user.id, c.id, last.id - 1);
  }
  publish([req.user.id], 'read', { conversationId: c.id });
  res.json({ ok: true });
});

api.delete('/conversations/:id', (req, res) => {
  if (!req.user.is_admin) fail(403, 'Only admins can delete conversations');
  const c = loadConversation(req);
  db.prepare('DELETE FROM conversations WHERE id = ?').run(c.id);
  publish(allUserIds(), 'read', { conversationId: c.id });
  res.json({ ok: true });
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

// ----- Contacts, lists, canned responses, bulk messages -----

api.use(contactsRouter);

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
  const m = mfa.mfaStatus(u.id);
  return {
    mfa: { totp: m.totp, passkeys: m.passkeys },
    id: u.id,
    username: u.username,
    email: u.email ?? '',
    displayName: u.display_name,
    isAdmin: !!u.is_admin,
    numberIds: db.prepare('SELECT number_id FROM user_numbers WHERE user_id = ?').all(u.id).map((r) => r.number_id),
  };
}

admin.post('/users/:id/reset-2fa', (req, res) => {
  const id = Number(req.params.id);
  mfa.resetMfa(id);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND user_id != ?').run(id, req.user.id);
  res.json({ ok: true });
});

admin.get('/security', (_req, res) => res.json({ require2fa: mfa.mfaRequired() }));

// ----- Office hours -----

admin.get('/hours', (_req, res) => {
  const cfg = getHours();
  res.json({ config: cfg, saved: !!getSetting('hours.config'), status: hoursStatus(Date.now(), cfg), away: !!db.prepare('SELECT 1 FROM canned_responses WHERE is_away = 1').get() });
});

admin.put('/hours', (req, res) => {
  let cfg;
  try {
    cfg = saveHours(req.body);
  } catch (err) {
    fail(400, err.message);
  }
  res.json({ config: cfg, status: hoursStatus(Date.now(), cfg) });
});

// ----- Email (SMTP) -----

admin.get('/email', (_req, res) => res.json({ ...email.smtpSettings(), configured: email.emailConfigured() }));

admin.put('/email', (req, res) => {
  try {
    email.saveSmtp(req.body);
  } catch (err) {
    fail(400, err.message);
  }
  res.json({ ...email.smtpSettings(), configured: email.emailConfigured() });
});

admin.delete('/email', (_req, res) => {
  email.removeSmtp();
  res.json({ ...email.smtpSettings(), configured: false });
});

admin.post('/email/test', async (req, res) => {
  const to = String(req.body?.to ?? '').trim();
  if (!email.validEmail(to)) fail(400, 'Enter an email address to send the test to');
  try {
    await email.sendMail({ to, subject: 'TextBoss test email', text: 'Email from TextBoss is working. Staff can now use "Forgot password?" and emailed sign-in codes.\n' });
  } catch (err) {
    fail(502, `Couldn't send: ${err.message}`);
  }
  res.json({ ok: true });
});

admin.put('/security', (req, res) => {
  if (req.body?.require2fa && !mfa.mfaStatus(req.user.id).enabled) {
    fail(400, 'Set up two-factor sign-in on your own account first (⋮ → Security), so you are not locked out.');
  }
  setSetting('security.require2fa', req.body?.require2fa ? '1' : null);
  res.json({ require2fa: mfa.mfaRequired() });
});

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
  if (req.body?.email) setUserEmail(Number(lastInsertRowid), req.body.email);
  res.json(userWithNumbers(db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid)));
});

function setUserEmail(userId, value) {
  const v = String(value ?? '').trim();
  if (v && !email.validEmail(v)) fail(400, 'That email address doesn\'t look right');
  if (v && db.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE AND id != ?').get(v, userId)) fail(409, 'Another user already has that email address');
  db.prepare('UPDATE users SET email = ? WHERE id = ?').run(v, userId);
}

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
  if (req.body?.email != null) setUserEmail(id, req.body.email);
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
  res.json(db.prepare('SELECT id, phone, label, active FROM numbers ORDER BY active DESC, label, phone').all().map((n) => ({ ...n, active: !!n.active })));
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
  const id = Number(req.params.id);
  if (req.body?.label !== undefined) {
    db.prepare('UPDATE numbers SET label = ? WHERE id = ?').run(String(req.body.label ?? '').trim(), id);
  }
  if (req.body?.active !== undefined) {
    db.prepare('UPDATE numbers SET active = ? WHERE id = ?').run(req.body.active ? 1 : 0, id);
    publish(allUserIds(), 'numbers', {});
  }
  res.json({ ok: true });
});

admin.delete('/numbers/:id', (req, res) => {
  db.prepare('DELETE FROM numbers WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ----- Backup and restore -----

admin.get('/backup', (req, res) => {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="textboss-backup-${stamp}.tar.gz"`);
  backupStream(db, config.dataDir, { createdBy: req.user.username })
    .on('error', (err) => {
      console.error('backup failed', err);
      res.destroy(err);
    })
    .pipe(res);
});

admin.post('/restore', express.raw({ type: () => true, limit: '2gb' }), (req, res) => {
  if (!req.body?.length) fail(400, 'Choose a backup file');
  let manifest;
  try {
    manifest = stageRestore(req.body, config.dataDir);
  } catch (err) {
    fail(400, err.message);
  }
  res.json({ ok: true, manifest });
  // Exit so the restore is applied on startup. Docker's restart policy brings the app back.
  console.log('Backup staged for restore; restarting.');
  setTimeout(() => process.exit(0), 800);
});

// ----- Texting provider (BulkVS or VoIP.ms) -----

const webhookUrls = () => (config.webhookSecret
  ? {
      bulkvs: `${config.publicUrl}/webhook/bulkvs/${config.webhookSecret}`,
      voipms: `${config.publicUrl}/webhook/voipms/${config.webhookSecret}?to={TO}&from={FROM}&message={MESSAGE}&id={ID}&date={TIMESTAMP}&media={MEDIA}`,
    }
  : { bulkvs: null, voipms: null });

// Passwords are never sent back; only whether one is saved and its last 4 characters
function providerStatus(id) {
  const creds = providerCredentials(id);
  return {
    name: PROVIDERS[id],
    source: creds.source, // 'admin' | 'env' | null
    username: creds.username ?? '',
    passwordSet: !!creds.password,
    passwordHint: creds.password ? `…${creds.password.slice(-4)}` : '',
    envConfigured: !!config[id].username,
  };
}
const providerOverview = () => ({
  active: activeProvider(),
  mockMode: isMockMode(),
  providers: Object.fromEntries(Object.keys(PROVIDERS).map((id) => [id, providerStatus(id)])),
  webhooks: webhookUrls(),
});
const providerId = (v) => {
  if (!PROVIDERS[v]) fail(400, 'Choose BulkVS or VoIP.ms');
  return v;
};

admin.get('/provider', (_req, res) => res.json(providerOverview()));

// Saves credentials and makes that provider the one in use. Blank fields mean
// "keep what's in use now" (saved in the app or from .env). Everything is
// validated before anything is written.
admin.put('/provider', (req, res) => {
  const id = providerId(req.body?.provider ?? 'bulkvs');
  const current = providerCredentials(id);
  const username = String(req.body?.username ?? '').trim() || current.username;
  const password = String(req.body?.password ?? '').trim();
  if (!username) fail(400, id === 'voipms' ? 'Enter your VoIP.ms login email' : 'Enter the API username');
  if (!password && !current.password) fail(400, id === 'voipms' ? 'Enter the VoIP.ms API password' : 'Enter the API password/token');
  setSetting(`${id}.username`, username);
  if (password) setSetting(`${id}.password`, password);
  setSetting('provider.active', id);
  res.json(providerOverview());
});

// Switch providers without changing credentials
admin.put('/provider/active', (req, res) => {
  setSetting('provider.active', providerId(req.body?.provider));
  res.json(providerOverview());
});

// Deliberately forget credentials saved in the app (falls back to .env, or mock mode)
admin.delete('/provider', (req, res) => {
  const id = providerId(req.query.provider ?? 'bulkvs');
  setSetting(`${id}.username`, null);
  setSetting(`${id}.password`, null);
  res.json(providerOverview());
});

admin.post('/provider/test', async (req, res) => {
  const id = providerId(req.body?.provider ?? activeProvider());
  const current = providerCredentials(id);
  const username = String(req.body?.username ?? '').trim();
  const password = String(req.body?.password ?? '').trim();
  // Test what's typed in the form, falling back to the saved password
  const creds = username
    ? { ...current, username, password: password || (username === current.username ? current.password : '') }
    : current;
  res.json(await (id === 'voipms' ? testVoipms(creds) : testBulkvs(creds)));
});

admin.get('/webhook-log', (_req, res) => {
  res.json({
    url: webhookUrls()[activeProvider()],
    entries: db.prepare('SELECT * FROM webhook_log ORDER BY id DESC LIMIT 50').all(),
  });
});

// ----- Contact import (upload), API keys, blocked numbers -----

admin.post('/import', express.raw({ type: () => true, limit: '20mb' }), (req, res) => {
  if (!req.body?.length) fail(400, 'Empty file');
  const filename = String(req.headers['x-filename'] ?? 'upload').slice(0, 200);
  const dryRun = req.query.dryRun === '1';
  let parsed;
  try {
    parsed = parseContactFile(req.body);
  } catch (err) {
    fail(400, `Could not read ${filename}: ${err.message}`);
  }
  const result = upsertContacts(parsed.records, { dryRun });
  if (!dryRun) {
    logImport('upload', filename, result);
    publish(allUserIds(), 'contacts', {});
  }
  res.json({ dryRun, columns: parsed.columns, rows: parsed.records.length, ...result });
});

admin.get('/imports', (_req, res) => {
  res.json({
    folder: config.importDir,
    entries: db.prepare(`SELECT id, source, filename, created, updated, skipped, issues, error, missing, missing_ids IS NOT NULL AS reviewable,
      problems IS NOT NULL AS has_problems, created_at FROM import_log ORDER BY id DESC LIMIT 30`).all(),
  });
});

// The "Problems to fix" list saved with an import
admin.get('/imports/:id/problems', (req, res) => {
  const row = db.prepare('SELECT id, source, filename, issues, problems, created_at FROM import_log WHERE id = ?').get(Number(req.params.id));
  if (!row) fail(404, 'Import not found');
  res.json({ id: row.id, source: row.source, filename: row.filename, createdAt: row.created_at, issueCount: row.issues, issues: JSON.parse(row.problems ?? '[]') });
});

// Clients who weren't in an earlier import and are still active
admin.get('/imports/:id/missing', (req, res) => {
  const row = db.prepare('SELECT missing_ids FROM import_log WHERE id = ?').get(Number(req.params.id));
  const ids = JSON.parse(row?.missing_ids ?? '[]');
  const found = [];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    found.push(...db.prepare(`SELECT id, first_name, last_name, nickname, patient_id, phone FROM contacts
      WHERE inactive_at IS NULL AND id IN (${chunk.map(() => '?').join(',')})`).all(...chunk));
  }
  found.sort((a, b) => a.last_name.localeCompare(b.last_name) || a.first_name.localeCompare(b.first_name));
  res.json(found.map((r) => ({ id: r.id, name: [r.nickname && `(${r.nickname})`, r.first_name, r.last_name].filter(Boolean).join(' '), patientId: r.patient_id, phone: r.phone })));
});

// Inactive contacts: idle timer and automatic folder-import clean-up
const inactiveSettings = () => ({
  idleDays: idleDays(),
  autoInactivateMissing: autoInactivateMissing(),
  counts: {
    active: db.prepare('SELECT COUNT(*) AS n FROM contacts WHERE inactive_at IS NULL').get().n,
    inactive: db.prepare('SELECT COUNT(*) AS n FROM contacts WHERE inactive_at IS NOT NULL').get().n,
  },
});
admin.get('/contacts/inactive-settings', (req, res) => {
  const preview = Number(req.query.previewDays);
  res.json({ ...inactiveSettings(), wouldInactivate: preview > 0 ? idleCandidates(preview) : null });
});
admin.put('/contacts/inactive-settings', (req, res) => {
  const days = Math.round(Number(req.body?.idleDays) || 0);
  if (days && (days < 30 || days > 3650)) fail(400, 'Choose between 30 and 3,650 days, or Off');
  setSetting('contacts.idleDays', days ? String(days) : null);
  setSetting('contacts.autoInactivateMissing', req.body?.autoInactivateMissing ? '1' : null);
  const changed = inactivateIdle();
  res.json({ ...inactiveSettings(), changed });
});

admin.get('/api-keys', (_req, res) => {
  res.json(db.prepare('SELECT id, name, prefix, created_at AS createdAt, last_used_at AS lastUsedAt FROM api_keys ORDER BY id').all());
});

admin.post('/api-keys', (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) fail(400, 'Give the key a name, e.g. the software that will use it');
  res.json({ key: createApiKey(name) });
});

admin.delete('/api-keys/:id', (req, res) => {
  db.prepare('DELETE FROM api_keys WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

admin.get('/blocked', (_req, res) => {
  res.json(
    db.prepare(
      `SELECT b.phone, b.created_at AS createdAt, u.display_name AS blockedBy
       FROM blocked b LEFT JOIN users u ON u.id = b.blocked_by ORDER BY b.created_at DESC`,
    ).all(),
  );
});

// Lets an admin push a fake inbound message through the real webhook parser
admin.post('/simulate-inbound', (req, res) => {
  const event = parseWebhook(req.body);
  if (!event || event.kind !== 'message') fail(400, 'Payload did not parse as an inbound message');
  const result = recordInbound(event);
  if (!result.ok) fail(400, result.reason);
  if (result.blocked) fail(400, 'That sender is blocked, so the message was dropped');
  res.json(result);
});

// ---------- Errors ----------

api.use((_req, _res) => fail(404, 'Not found'));

app.use((err, _req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({
    error: status >= 500 ? 'Server error' : err.message,
    ...(err.code ? { code: err.code } : {}),
    ...(err.phones ? { phones: err.phones } : {}),
  });
});

resumeBroadcasts();
startWatcher();
startIdleJob();
cleanUpStoredReceipts();

app.listen(config.port, () => {
  console.log(`TextBoss listening on http://localhost:${config.port}`);
  console.log(isMockMode() ? `Mock mode: no ${PROVIDERS[activeProvider()]} credentials set, messages are not really sent.` : `Sending through ${PROVIDERS[activeProvider()]}.`);
  if (!config.webhookSecret) console.log('WEBHOOK_SECRET is not set, so inbound messages are disabled.');
});
