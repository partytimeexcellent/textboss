// Web Push: alerts and app-icon badges even when TextBoss is closed,
// including iPhone home-screen web apps (iOS 16.4+).
//
// The VAPID key pair that identifies this server to Apple/Google/Mozilla is
// generated on first use and kept in the settings table.

import webpush from 'web-push';
import { db, getSetting, setSetting, userNumberIds } from './db.js';
import { config } from './config.js';

// Paused: the device stays signed up but gets no alerts until switched back on
if (!db.prepare('PRAGMA table_info(push_subscriptions)').all().some((c) => c.name === 'paused')) {
  db.exec('ALTER TABLE push_subscriptions ADD COLUMN paused INTEGER NOT NULL DEFAULT 0');
}

function vapid() {
  let publicKey = getSetting('vapid.public');
  let privateKey = getSetting('vapid.private');
  if (!publicKey || !privateKey) {
    ({ publicKey, privateKey } = webpush.generateVAPIDKeys());
    setSetting('vapid.public', publicKey);
    setSetting('vapid.private', privateKey);
  }
  // Apple rejects localhost subjects, so fall back to a mailto: address
  const subject = process.env.VAPID_SUBJECT
    || (config.publicUrl.startsWith('https://') && !/localhost|127\.0\.0\.1/.test(config.publicUrl) ? config.publicUrl : 'mailto:admin@textboss.invalid');
  return { publicKey, privateKey, subject };
}

export const vapidPublicKey = () => vapid().publicKey;

export function saveSubscription(userId, sub, { preview = true, userAgent = '' } = {}) {
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) throw new Error('Invalid push subscription');
  db.prepare(
    `INSERT INTO push_subscriptions (user_id, endpoint, keys, preview, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, keys = excluded.keys, preview = excluded.preview, user_agent = excluded.user_agent`,
  ).run(userId, sub.endpoint, JSON.stringify(sub.keys), preview ? 1 : 0, String(userAgent).slice(0, 300), Date.now());
}

export function removeSubscription(endpoint) {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
}

export function subscriptionStatus(endpoint) {
  const row = db.prepare('SELECT preview, paused FROM push_subscriptions WHERE endpoint = ?').get(endpoint);
  return row ? { subscribed: true, preview: !!row.preview, paused: !!row.paused } : { subscribed: false };
}

export function setPaused(userId, endpoint, paused) {
  return db.prepare('UPDATE push_subscriptions SET paused = ? WHERE user_id = ? AND endpoint = ?').run(paused ? 1 : 0, userId, endpoint).changes > 0;
}

// Unread incoming messages across a user's active numbers (the app-icon badge)
export function unreadTotal(user) {
  const ids = userNumberIds(user);
  if (!ids.length) return 0;
  return db.prepare(
    `SELECT COUNT(*) AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE c.number_id IN (${ids.map(() => '?').join(',')}) AND c.archived = 0 AND m.direction = 'in'
       AND m.id > COALESCE((SELECT last_read_id FROM reads r WHERE r.user_id = ? AND r.conversation_id = c.id), 0)`,
  ).get(...ids, user.id).n;
}

// build(user, preview) returns { title, body, url, tag } for that user
// Pass onlyEndpoint to send to a single device (used by the test button)
export async function pushToUsers(userIds, build, { onlyEndpoint } = {}) {
  if (!userIds.length) return;
  const { publicKey, privateKey, subject } = vapid();
  const subs = db
    .prepare(`SELECT s.*, u.is_admin, u.theme FROM push_subscriptions s JOIN users u ON u.id = s.user_id WHERE s.user_id IN (${userIds.map(() => '?').join(',')})`)
    .all(...userIds)
    .filter((s) => (onlyEndpoint ? s.endpoint === onlyEndpoint : !s.paused));
  await Promise.all(subs.map(async (s) => {
    const user = { id: s.user_id, is_admin: !!s.is_admin };
    let iconId = null;
    try {
      iconId = JSON.parse(s.theme ?? 'null')?.iconId ?? null;
    } catch {}
    const payload = { ...build(user, !!s.preview), badge: unreadTotal(user), icon: iconId ? `/icons/${iconId}-192.png` : undefined };
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: JSON.parse(s.keys) },
        JSON.stringify(payload),
        { vapidDetails: { subject, publicKey, privateKey }, TTL: 24 * 3600, urgency: 'high', topic: payload.tag?.slice(0, 32) },
      );
    } catch (err) {
      // 404/410: the device unsubscribed or the app was removed
      if (err.statusCode === 404 || err.statusCode === 410) removeSubscription(s.endpoint);
      else console.warn(`push to ${new URL(s.endpoint).host} failed: ${err.statusCode ?? ''} ${err.body ?? err.message}`);
    }
  }));
}
