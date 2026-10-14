// Nudges for people who haven't set up two-factor sign-in: a banner in the app
// (snoozed for a day with "Remind me tomorrow") and a daily email when email
// is set up and they have an address. Starts a day after the account is made,
// stops once they have a passkey or authenticator app. Admins can turn it off.

import { db, getSetting, setSetting } from './db.js';
import { config } from './config.js';
import { mfaStatus, mfaRequired } from './mfa.js';
import { emailConfigured, sendMail } from './email.js';

for (const col of ['mfa_snoozed_at', 'mfa_emailed_at']) {
  if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === col)) db.exec(`ALTER TABLE users ADD COLUMN ${col} INTEGER`);
}

const DAY = 86_400_000;

// On unless an admin turned it off
export const remindersOn = () => getSetting('security.remind2fa') !== '0';
export const setRemindersOn = (on) => setSetting('security.remind2fa', on ? null : '0');

// Whether this person should see the banner right now
export function showMfaBanner(userId) {
  if (!remindersOn() || mfaRequired()) return false; // when required, setup is forced instead
  if (mfaStatus(userId).enabled) return false;
  const u = db.prepare('SELECT mfa_snoozed_at FROM users WHERE id = ?').get(userId);
  return !u?.mfa_snoozed_at || Date.now() - u.mfa_snoozed_at >= DAY;
}

export function snoozeMfaBanner(userId) {
  db.prepare('UPDATE users SET mfa_snoozed_at = ? WHERE id = ?').run(Date.now(), userId);
}

export async function emailReminders(now = Date.now()) {
  if (!remindersOn() || mfaRequired() || !emailConfigured()) return 0;
  const users = db.prepare(`SELECT id, display_name, email FROM users
    WHERE email != '' AND created_at < ? AND (mfa_emailed_at IS NULL OR mfa_emailed_at < ?)`).all(now - DAY, now - DAY + 10 * 60_000);
  let sent = 0;
  for (const u of users) {
    if (mfaStatus(u.id).enabled) continue;
    // Record first, so a mail server problem doesn't turn into repeated tries every hour
    db.prepare('UPDATE users SET mfa_emailed_at = ? WHERE id = ?').run(now, u.id);
    try {
      await sendMail({
        to: u.email,
        subject: 'Reminder: protect your TextBoss account',
        text: `Hi ${u.display_name},\n\nYour TextBoss account is protected only by a password. Two-factor sign-in adds a second step, like Face ID, Touch ID, Windows Hello or a code from an authenticator app, so client messages stay safe even if your password leaks.\n\nIt takes about a minute: open TextBoss, then ⋮ → Security.\n${config.publicUrl}/#/security\n\nAdd a passkey on each phone and computer you use. You'll get this reminder once a day until it's set up.\n`,
      });
      sent++;
    } catch (err) {
      console.warn(`2FA reminder to ${u.email} failed: ${err.message}`);
    }
  }
  if (sent) console.log(`Sent ${sent} two-factor reminder email${sent === 1 ? '' : 's'}`);
  return sent;
}

export function startReminderJob() {
  const run = () => emailReminders().catch((err) => console.warn('2FA reminders failed', err.message));
  setTimeout(run, 2 * 60_000).unref();
  setInterval(run, 60 * 60_000).unref();
}
