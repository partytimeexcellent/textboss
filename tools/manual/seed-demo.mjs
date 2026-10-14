// Builds a demo TextBoss for the user manual's screenshots: "The Business
// Factory", three staff, two numbers and a set of fictional clients. Every
// name, phone number (555-01xx, reserved for fiction) and detail is made up.
//
//   node tools/manual/seed-demo.mjs [data-dir]     (default: demo-data)
//
// Wipes and recreates the folder. Never point it at a real data folder.

import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.argv[2] || 'demo-data');
if (fs.existsSync(path.join(dir, 'textboss.db')) && !fs.existsSync(path.join(dir, '.demo'))) {
  console.error(`${dir} has a database that this script didn't create. Refusing to wipe it.`);
  process.exit(1);
}
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
fs.writeFileSync(path.join(dir, '.demo'), 'Demo data for the user manual. Safe to delete.\n');

process.env.DATA_DIR = dir;
process.env.PUBLIC_URL = process.env.PUBLIC_URL || 'http://localhost:3100';

// Importing these creates every table and column, as the server does
const { db, setSetting, getOrCreateConversation } = await import('../../src/db.js');
const { hashPassword } = await import('../../src/auth.js');
const contactsMod = await import('../../src/contacts.js');
await import('../../src/mfa.js');
await import('../../src/email.js');
await import('../../src/reminders.js');
await import('../../src/push.js');
const { saveHours } = await import('../../src/hours.js');

export const DEMO_PASSWORD = 'factory floor demo';
const now = Date.now();
const min = 60_000;
const hour = 60 * min;
const day = 24 * hour;

// ----- Staff -----
const addUser = (username, name, email, admin, created) => Number(db.prepare(
  `INSERT INTO users (username, display_name, password_hash, is_admin, email, created_at, tour_done_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
).run(username, name, hashPassword(DEMO_PASSWORD), admin ? 1 : 0, email, created, now).lastInsertRowid);
const morgan = addUser('morgan', 'Morgan Lee', 'morgan@thebusinessfactory.example', true, now - 200 * day);
const jamie = addUser('jamie', 'Jamie Ortiz', 'jamie@thebusinessfactory.example', false, now - 120 * day);
const priya = addUser('priya', 'Priya Shah', 'priya@thebusinessfactory.example', false, now - 3 * day);
// Morgan has passkeys, Jamie an authenticator app, Priya nothing yet
db.prepare(`INSERT INTO passkeys (user_id, credential_id, public_key, name, created_at, last_used_at) VALUES (?, 'demo-1', 'x', 'MacBook Pro', ?, ?)`).run(morgan, now - 90 * day, now - 2 * hour);
db.prepare(`INSERT INTO passkeys (user_id, credential_id, public_key, name, created_at, last_used_at) VALUES (?, 'demo-2', 'x', 'iPhone', ?, ?)`).run(morgan, now - 60 * day, now - day);
db.prepare(`UPDATE users SET totp_secret = 'JBSWY3DPEHPK3PXP' WHERE id = ?`).run(jamie);

// Ready-made sessions so the screenshot script can skip sign-in (demo only)
for (const [id, name] of [[morgan, 'morgan'], [jamie, 'jamie'], [priya, 'priya']]) {
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(`demo-session-${name}`, id, now + 7 * day);
}

// ----- Numbers -----
const addNumber = (phone, label) => Number(db.prepare('INSERT INTO numbers (phone, label, created_at) VALUES (?, ?, ?)').run(phone, label, now - 200 * day).lastInsertRowid);
const main = addNumber('3125550100', 'Front desk');
const north = addNumber('3125550101', 'North office');
const mainPhone = '3125550100';
const northPhone = '3125550101';
for (const n of [main, north]) db.prepare('INSERT INTO user_numbers (user_id, number_id) VALUES (?, ?)').run(jamie, n);
db.prepare('INSERT INTO user_numbers (user_id, number_id) VALUES (?, ?)').run(priya, main);

// ----- Clients -----
const contact = (c, ago = 150 * day) => {
  const id = contactsMod.createContact(c);
  db.prepare('UPDATE contacts SET created_at = ?, updated_at = ?, last_import_at = ? WHERE id = ?').run(now - ago, now - ago, now - day, id);
  return id;
};
// The Thorntons share a phone. Leo was added first, but Ava is picked as the name shown.
const leo = contact({ firstName: 'Leo', lastName: 'Thornton', phone: '3125550142', dob: '2015-06-02', patientId: 'BF-1002', notes: 'Prefers afternoon sessions after school.' }, 300 * day);
const ava = contact({ firstName: 'Ava', lastName: 'Thornton', phone: '3125550142', dob: '1984-03-19', email: 'ava.thornton@example.com', patientId: 'BF-1001', notes: 'Parent of Leo. Usually books for both.\nInvoices go to this email.' }, 290 * day);
const mo = contact({ firstName: 'Maurice', lastName: 'Bell', nickname: 'Mo', phone: '3125550133', dob: '1967-11-08', email: 'mo.bell@example.com', patientId: 'BF-1003', notes: 'Hard of hearing: texting is best.' });
const grace = contact({ firstName: 'Grace', lastName: 'Kim', phone: '3125550127', dob: '1991-01-24', email: 'grace.kim@example.com', patientId: 'BF-1004' });
const daniel = contact({ firstName: 'Daniel', lastName: 'Okoro', phone: '3125550158', dob: '1979-07-30', patientId: 'BF-1005' });
const sofia = contact({ firstName: 'Sofia', lastName: 'Marquez', phone: '3125550164', dob: '1988-09-12', email: 'sofia.m@example.com', patientId: 'BF-1006' });
const nora = contact({ firstName: 'Nora', lastName: 'Patel', phone: '3125550171', dob: '1995-04-03', patientId: 'BF-1007' });
const elijah = contact({ firstName: 'Elijah', lastName: 'Brooks', phone: '3125550176', dob: '1990-12-15', patientId: 'BF-1008' });
const chloe = contact({ firstName: 'Chloe', lastName: 'Nguyen', phone: '3125550183', dob: '2001-08-21', email: 'chloe.n@example.com', patientId: 'BF-1009' });
const henry = contact({ firstName: 'Henry', lastName: 'Walsh', phone: '3125550189', dob: '1958-02-11', patientId: 'BF-1010' });
const marcus = contact({ firstName: 'Marcus', lastName: 'Reed', phone: '3125550192', dob: '1983-05-27', patientId: 'BF-1011' });
const isabel = contact({ firstName: 'Isabel', lastName: 'Cruz', dob: '1999-10-05', email: 'isabel.cruz@example.com', patientId: 'BF-1012' });
const ruth = contact({ firstName: 'Ruth', lastName: 'Albright', phone: '3125550196', dob: '1949-06-17', patientId: 'BF-1013', notes: 'Daughter helps with scheduling.' });
const peter = contact({ firstName: 'Peter', lastName: 'Lang', phone: '3125550138', dob: '1972-03-09', patientId: 'BF-1014' });
contactsMod.setDisplayContact(ava);
contactsMod.setOptOut('3125550158', true, 'STOP');
db.prepare('INSERT INTO blocked (phone, blocked_by, created_at) VALUES (?, ?, ?)').run('3125550199', morgan, now - 20 * day);
db.prepare(`UPDATE contacts SET inactive_at = ?, inactive_reason = 'import' WHERE id = ?`).run(now - 6 * day, henry);
db.prepare(`UPDATE contacts SET inactive_at = ?, inactive_reason = 'idle', last_import_at = NULL WHERE id = ?`).run(now - 30 * day, marcus);

// ----- Lists -----
const list = (name, ids) => {
  const id = Number(db.prepare('INSERT INTO lists (name, created_by, created_at) VALUES (?, ?, ?)').run(name, morgan, now - 40 * day).lastInsertRowid);
  for (const c of ids) db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').run(id, c);
  return id;
};
list('Weather alerts', [ava, mo, grace, sofia, nora, elijah, chloe, ruth]);
list('Monday morning group', [mo, nora, elijah, ruth]);

// ----- Canned responses -----
const canned = (name, body, keyword = '') => db.prepare('INSERT INTO canned_responses (name, body, media, keyword, is_away, created_at) VALUES (?, ?, ?, ?, 0, ?)').run(name, body, '[]', keyword, now - 50 * day);
canned('Appointment reminder', 'Hi {first_name}, a reminder of your appointment tomorrow at The Business Factory. Reply C to confirm or call us to reschedule.');
canned('Running late', 'Hi {first_name}, we\'re running about 15 minutes behind today. Thanks for your patience!');
canned('Our hours', 'We\'re open Monday to Thursday 8am–5pm and Friday 8am–3pm. Text us any time!', 'HOURS');
canned('Directions and parking', 'We\'re at 100 Example Avenue, Suite 2. Free parking is behind the building.');

// ----- Conversations -----
// A small picture attachment, as a staff member would send
fs.writeFileSync(path.join(dir, 'media', 'home-plan.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="340" viewBox="0 0 480 340">
<rect width="480" height="340" rx="18" fill="#f4f1ff"/><rect x="24" y="24" width="432" height="56" rx="12" fill="#7b4fd6"/>
<text x="44" y="61" font-family="Helvetica, Arial" font-size="24" font-weight="700" fill="#fff">Home plan · Week 3</text>
<g font-family="Helvetica, Arial" font-size="19" fill="#2b2540">
<text x="44" y="128">1. Morning stretch · 10 min</text><text x="44" y="170">2. Walk around the block · 2×</text>
<text x="44" y="212">3. Balance practice · 3 sets</text><text x="44" y="254">4. Ice and rest · 15 min</text></g>
<text x="44" y="306" font-family="Helvetica, Arial" font-size="15" fill="#6a6380">The Business Factory</text></svg>`);
const pic = `${process.env.PUBLIC_URL}/media/home-plan.svg`;

const conv = (numberId, phones, { pinned = 0, flagged = 0, archived = 0 } = {}) => {
  const c = getOrCreateConversation(numberId, phones.slice().sort().join(','));
  db.prepare('UPDATE conversations SET pinned = ?, flagged = ?, archived = ? WHERE id = ?').run(pinned, flagged, archived, c.id);
  return c;
};
const msg = (c, at, dir, from, body, { by = null, status, kind = null, media = [] } = {}) => {
  const id = Number(db.prepare(`INSERT INTO messages (conversation_id, direction, from_phone, body, media, status, sent_by, kind, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(c.id, dir, from, body, JSON.stringify(media), status ?? (dir === 'in' ? 'received' : 'delivered'), by, kind, now - at).lastInsertRowid);
  db.prepare('UPDATE conversations SET last_message_at = MAX(last_message_at, ?) WHERE id = ?').run(now - at, c.id);
  return id;
};
const readAll = (c, users = [morgan, jamie, priya]) => {
  const last = db.prepare('SELECT MAX(id) AS id FROM messages WHERE conversation_id = ?').get(c.id).id;
  for (const u of users) db.prepare('INSERT INTO reads (user_id, conversation_id, last_read_id) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET last_read_id = excluded.last_read_id').run(u, c.id, last);
};

// Thornton family: shared number, two staff replying
const thornton = conv(main, ['3125550142'], { pinned: 1 });
msg(thornton, 2 * day + 3 * hour, 'in', '3125550142', 'Hi! Can we move Leo\'s Thursday appointment to after 3:30? School gets out late that day.');
msg(thornton, 2 * day + 2 * hour, 'out', mainPhone, 'Hi Ava, no problem. We have 3:45 or 4:30 on Thursday. Which works better?', { by: jamie });
msg(thornton, 2 * day + 90 * min, 'in', '3125550142', '4:30 please!');
msg(thornton, 2 * day + 80 * min, 'out', mainPhone, 'Done: Leo is booked Thursday at 4:30. See you then!', { by: jamie });
msg(thornton, 50 * min, 'in', '3125550142', 'Also, could you email me last month\'s invoice? Thank you!');
msg(thornton, 35 * min, 'out', mainPhone, 'Of course! I just sent it to your email on file. Let us know if anything looks off.', { by: morgan });
readAll(thornton);

// Mo: flagged, a picture sent, a follow-up question
const moC = conv(main, ['3125550133'], { flagged: 1 });
msg(moC, 26 * hour, 'out', mainPhone, 'Hi Mo, here\'s your updated home plan for this week.', { by: jamie, media: [pic] });
msg(moC, 25 * hour, 'in', '3125550133', 'Thanks! Is it OK to do the walk twice a day?');
msg(moC, 24 * hour, 'out', mainPhone, 'Twice is great as long as it feels comfortable. Skip the second one if you\'re sore.', { by: jamie });
msg(moC, 3 * hour, 'in', '3125550133', 'Feeling much better this week 👍');
readAll(moC);

// Grace: new and unread
const graceC = conv(main, ['3125550127']);
msg(graceC, 3 * day, 'out', mainPhone, 'Hi Grace, a reminder of your appointment tomorrow at The Business Factory. Reply C to confirm or call us to reschedule.', { by: priya });
msg(graceC, 3 * day - 20 * min, 'in', '3125550127', 'C');
readAll(graceC);
msg(graceC, 12 * min, 'in', '3125550127', 'Hi, do you have anything open Saturday morning? Weekdays are tough for me this month.');
msg(graceC, 11 * min, 'in', '3125550127', 'Any time before noon works.');

// A new number that isn't a contact yet
const stranger = conv(main, ['3125550177']);
msg(stranger, 95 * min, 'in', '3125550177', 'Hello, is this The Business Factory? Are you taking new clients?');

// Sofia: after-hours auto-reply, then a reply in the morning
const sofiaC = conv(main, ['3125550164']);
msg(sofiaC, 14 * hour, 'in', '3125550164', 'Is there parking near you?');
msg(sofiaC, 14 * hour - min, 'out', mainPhone, 'Thanks for your message! The Business Factory is closed right now. We\'ll reply when we reopen at 8am.', { kind: 'auto' });
msg(sofiaC, 5 * hour, 'out', mainPhone, 'Morning Sofia! Free parking is right behind the building. See you at 10.', { by: priya });
readAll(sofiaC);

// Group text
const group = conv(main, ['3125550171', '3125550176']);
msg(group, 4 * day, 'out', mainPhone, 'Hi Nora and Elijah, the Monday morning group moves to 9:30 starting next week.', { by: morgan });
msg(group, 4 * day - 30 * min, 'in', '3125550171', 'Sounds good, thanks!');
msg(group, 4 * day - 25 * min, 'in', '3125550176', 'Works for me 👍');
readAll(group);

// Daniel opted out
const danielC = conv(main, ['3125550158']);
msg(danielC, 9 * day, 'out', mainPhone, 'Hi Daniel, a reminder of your appointment tomorrow at The Business Factory. Reply C to confirm or call us to reschedule.', { by: priya });
msg(danielC, 9 * day - hour, 'in', '3125550158', 'STOP');
readAll(danielC);

// Bulk weather message
const bulkBody = (first) => `Hi ${first}, The Business Factory is closed today because of the snowstorm. We'll call to reschedule. Stay safe!`;
const b = Number(db.prepare(`INSERT INTO broadcasts (number_id, body, media, status, created_by, created_at) VALUES (?, ?, '[]', 'done', ?, ?)`)
  .run(main, 'Hi {first_name}, The Business Factory is closed today because of the snowstorm. We\'ll call to reschedule. Stay safe!', morgan, now - 6 * day).lastInsertRowid);
for (const [phone, first] of [['3125550183', 'Chloe'], ['3125550196', 'Ruth'], ['3125550142', 'Ava'], ['3125550127', 'Grace']]) {
  db.prepare(`INSERT INTO broadcast_items (broadcast_id, phone, body, status) VALUES (?, ?, ?, 'sent')`).run(b, phone, bulkBody(first));
}
db.prepare(`INSERT INTO broadcast_items (broadcast_id, phone, body, status, error) VALUES (?, '3125550158', ?, 'skipped', 'opted out')`).run(b, bulkBody('Daniel'));
const chloeC = conv(main, ['3125550183']);
msg(chloeC, 6 * day, 'out', mainPhone, bulkBody('Chloe'), { by: morgan, kind: 'bulk' });
msg(chloeC, 6 * day - 2 * hour, 'in', '3125550183', 'Thanks for the heads up!');
readAll(chloeC);
const ruthC = conv(main, ['3125550196']);
msg(ruthC, 6 * day, 'out', mainPhone, bulkBody('Ruth'), { by: morgan, kind: 'bulk' });
readAll(ruthC);

// North office number
const henryC = conv(north, ['3125550189']);
msg(henryC, 40 * day, 'in', '3125550189', 'Thanks for everything these past months!');
msg(henryC, 40 * day - hour, 'out', northPhone, 'It was a pleasure, Henry. Take care!', { by: jamie });
readAll(henryC);
const eliC = conv(north, ['3125550176']);
msg(eliC, 26 * hour, 'in', '3125550176', 'Can I pick up my paperwork at the North office instead?');
msg(eliC, 25 * hour, 'out', northPhone, 'Yes, it\'ll be at the front desk from Wednesday.', { by: jamie });
readAll(eliC);

// ----- Settings -----
setSetting('bulkvs.username', 'demo-factory');
setSetting('bulkvs.password', 'demo-token-not-real-7a1f');
setSetting('provider.active', 'bulkvs');
setSetting('smtp.host', 'smtp.example.com');
setSetting('smtp.port', '587');
setSetting('smtp.security', 'starttls');
setSetting('smtp.username', 'textboss@thebusinessfactory.example');
setSetting('smtp.password', 'not-a-real-password');
setSetting('smtp.from', 'The Business Factory <textboss@thebusinessfactory.example>');
setSetting('contacts.idleDays', '730');
saveHours({
  enabled: true,
  timezone: 'America/Chicago',
  message: 'Thanks for your message! The Business Factory is closed right now. We\'ll reply when we reopen.',
  week: {
    sun: [], sat: [],
    mon: [{ start: '08:00', end: '12:00' }, { start: '13:00', end: '17:00' }],
    tue: [{ start: '08:00', end: '12:00' }, { start: '13:00', end: '17:00' }],
    wed: [{ start: '08:00', end: '12:00' }, { start: '13:00', end: '17:00' }],
    thu: [{ start: '08:00', end: '12:00' }, { start: '13:00', end: '17:00' }],
    fri: [{ start: '08:00', end: '15:00' }],
  },
  closures: [
    { from: '2026-11-26', to: '2026-11-27', name: 'Thanksgiving', message: 'Happy Thanksgiving! We\'re closed until Monday, Nov 30.' },
    { from: '2026-12-24', to: '2026-12-25', name: 'Christmas', message: '' },
    { from: '2027-01-01', name: 'New Year\'s Day', message: '' },
  ],
});

// ----- Import history -----
const problems = [
  { row: 14, name: 'Ruth Albright', patientId: 'BF-1013', field: 'Email', value: 'ruth.albright@', problem: 'Not a valid email; imported without it' },
  { row: 37, name: 'Chloe Nguyen', patientId: 'BF-1009', field: 'Date of birth', value: '21/08/01', problem: 'Unrecognized date; imported without it' },
  { row: 52, name: 'Samuel Ford', patientId: 'BF-1031', field: 'Phone', value: '555-01', problem: 'Not a valid US phone number; imported without it' },
  { row: 88, name: '(no name)', patientId: 'BF-1077', field: 'Name', value: '', problem: 'No first or last name; row skipped' },
];
const logImport = (source, file, created, updated, skipped, issues, missing, missingIds, probs, ago) => db.prepare(
  `INSERT INTO import_log (source, filename, created, updated, skipped, issues, error, missing, missing_ids, problems, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
).run(source, file, created, updated, skipped, issues, missing, missingIds, probs, now - ago);
logImport('upload', 'ClientList-September.xlsx', 212, 0, 1, 2, null, null, JSON.stringify(problems.slice(0, 2)), 40 * day);
logImport('folder', 'ClientList-2026-10-07.xlsx', 2, 9, 0, 1, 1, null, JSON.stringify(problems.slice(2, 3)), 7 * day);
logImport('folder', 'ClientList-2026-10-13.xlsx', 3, 12, 1, problems.length, 2, JSON.stringify([isabel, peter]), JSON.stringify(problems), day);

console.log(`Demo data ready in ${dir}`);
console.log(`Sign in as morgan (admin), jamie or priya with the password "${DEMO_PASSWORD}"`);
