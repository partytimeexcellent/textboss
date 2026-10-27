// A practice copy (TEXTBOSS_CLONE=1) must never reach the clinic's clients or
// staff. Besides the hard blocks on texts, email and push, its database is
// cleaned of anything that could: provider, email and push settings,
// notification devices, and bulk sends that would resume.
//
// Runs on every start of a practice copy, so a live backup restored into it
// (Admin settings → Backup) is cleaned as soon as the restore swaps it in.

export function scrubClone(db) {
  const removed = db.prepare(`DELETE FROM settings WHERE key LIKE 'bulkvs.%' OR key LIKE 'voipms.%' OR key LIKE 'smtp.%' OR key LIKE 'vapid.%'`).run().changes;
  const devices = db.prepare('DELETE FROM push_subscriptions').run().changes;
  const broadcasts = db.prepare(`UPDATE broadcasts SET status = 'cancelled' WHERE status = 'running'`).run().changes;
  return { removed, devices, broadcasts };
}
