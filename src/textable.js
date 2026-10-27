// Import conversation history exported from Textable: one CSV per person,
// columns ID,To,From,Date,Direction,Body,Attachments, named after whatever
// the clinic typed in Textable ("Jane Doe", "'Bob' Robert Smith",
// "(541) 555-0100", "+15415550100", or an ID).
//
// Files are staged first (nothing touches conversations or contacts), each
// file + phone is matched against the contacts, an admin confirms or fixes
// every match, and only confirmed ones are imported.
//
// Conversations are keyed by phone, so the messages only need the phone in
// the CSV. The name in the file name only decides what happens to contacts.

import { db, tx, getOrCreateConversation, allUserIds } from './db.js';
import { publish } from './events.js';
import { normalizePhone, isValidPhone } from './phone.js';
import { createContact, updateContact, setOptOut, setDisplayContact, fullName, logImport } from './contacts.js';

db.exec(`
  -- One row per file + other phone (a file can hold more than one phone)
  CREATE TABLE IF NOT EXISTS textable_threads (
    id           INTEGER PRIMARY KEY,
    file         TEXT NOT NULL,
    phone        TEXT NOT NULL,
    our_phone    TEXT NOT NULL,
    label_kind   TEXT NOT NULL,           -- name, phone, id, shortcode
    label_first  TEXT NOT NULL DEFAULT '',
    label_last   TEXT NOT NULL DEFAULT '',
    label_nick   TEXT NOT NULL DEFAULT '',
    label_note   TEXT NOT NULL DEFAULT '',
    label_phone  TEXT NOT NULL DEFAULT '',
    greetings    TEXT NOT NULL DEFAULT '[]',
    file_notes   TEXT NOT NULL DEFAULT '[]',
    msg_count    INTEGER NOT NULL DEFAULT 0,
    first_at     INTEGER,
    last_at      INTEGER,
    -- Suggestion from matching, or the admin's choice once confirmed
    status       TEXT NOT NULL DEFAULT 'none', -- auto, review, none, skip
    reasons      TEXT NOT NULL DEFAULT '[]',
    candidates   TEXT NOT NULL DEFAULT '[]',
    action       TEXT NOT NULL DEFAULT 'phone', -- link, create, phone, skip
    contact_id   INTEGER,
    first_name   TEXT NOT NULL DEFAULT '',
    last_name    TEXT NOT NULL DEFAULT '',
    nickname     TEXT NOT NULL DEFAULT '',
    copy_from    INTEGER,
    confirmed    INTEGER NOT NULL DEFAULT 0,
    imported_at  INTEGER,
    imported_n   INTEGER,
    UNIQUE (file, phone)
  );
  CREATE TABLE IF NOT EXISTS textable_messages (
    ext_id      TEXT PRIMARY KEY,
    thread_id   INTEGER NOT NULL REFERENCES textable_threads(id) ON DELETE CASCADE,
    direction   TEXT NOT NULL,
    body        TEXT NOT NULL,
    attachments TEXT NOT NULL DEFAULT '[]',
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS textable_messages_thread ON textable_messages(thread_id, created_at);
`);

// ---------- CSV ----------

// RFC 4180, plus a repair for rows Textable wrote with an unquoted line break
// in the body: "ID,To,From,Date,Direction,Body start" then "body end,[]".
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.length > 1 || r[0] !== '');
}

const WIDTH = 7;

// Textable rows as objects; `repaired` counts rows that had to be stitched together
export function readExport(text) {
  const rows = parseCsv(text);
  const header = rows.shift()?.map((h) => h.trim().toLowerCase());
  if (!header || header.join(',') !== 'id,to,from,date,direction,body,attachments') {
    throw new Error('Not a Textable export (expected columns ID,To,From,Date,Direction,Body,Attachments)');
  }
  const out = [];
  let repaired = 0;
  let unreadable = 0;
  for (let i = 0; i < rows.length; i++) {
    let r = rows[i];
    // Line break inside an unquoted body: join with the following row(s)
    while (r.length < WIDTH && i + 1 < rows.length && r.length + rows[i + 1].length - 1 <= WIDTH) {
      const next = rows[++i];
      r = [...r.slice(0, -1), `${r.at(-1)}\n${next[0]}`, ...next.slice(1)];
      repaired++;
    }
    // Comma inside an unquoted body: everything between Direction and Attachments is the body
    if (r.length > WIDTH && /^\s*\[/.test(r.at(-1))) {
      r = [...r.slice(0, 5), r.slice(5, -1).join(','), r.at(-1)];
      repaired++;
    }
    const [id, to, from, date, direction, body, attachments] = r;
    const at = Date.parse(date);
    if (r.length !== WIDTH || !id || !['in', 'out'].includes(direction) || Number.isNaN(at)) {
      unreadable++;
      continue;
    }
    let files = [];
    try { files = JSON.parse(attachments || '[]').filter((a) => a && typeof a === 'object' && Object.keys(a).length); } catch { files = []; }
    out.push({ id, to, from, at, direction, body: body ?? '', attachments: files });
  }
  return { messages: out, repaired, unreadable };
}

// ---------- File names ----------

const RELATION = /^(mom|mother|dad|father|parent|guardian|son|daughter|wife|husband|spouse|partner|cell|home|work|old|new|other|grandma|grandpa|caregiver|\d+)$/i;
const showPhone = (p) => (/^\d{10}$/.test(p) ? `(${p.slice(0, 3)}) ${p.slice(3, 6)}-${p.slice(6)}` : p);
const titleCase = (s) => s.replace(/\S+/g, (w) => (w === w.toLowerCase() || w === w.toUpperCase() ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w));

// What the file name says: a name (with nickname and a bracketed note), a phone, or an ID
export function parseLabel(file) {
  let s = file.replace(/\.csv$/i, '').replace(/\s+/g, ' ').trim();
  const digits = s.replace(/\D/g, '');
  if (/^[\d\s()+\-.]+$/.test(s)) {
    if (digits.length >= 10) return { kind: 'phone', phone: normalizePhone(digits) };
    if (digits.length >= 5) return { kind: 'shortcode', phone: digits };
  }
  if (!s.includes(' ') && /\d/.test(s) && /[a-z]/i.test(s) && s.length >= 12) return { kind: 'id' };

  const out = { kind: 'name', first: '', last: '', nick: '', note: '' };
  // 'Bob' Robert Smith, "Bob" Robert Smith, -Bob- Robert Smith (quotes that became dashes)
  const nick = /^['"‘’“”-]([^'"‘’“”-]+)['"‘’“”-]\s+(.+)$/.exec(s);
  if (nick) { out.nick = nick[1].trim(); s = nick[2]; }
  // Robert Smith (Bob), Jane Doe (Mom), John Smith (2)
  const notes = [...s.matchAll(/\(([^)]*)\)/g)].map((m) => m[1].trim()).filter(Boolean);
  if (notes.length) {
    s = s.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
    const nickNote = notes.find((n) => /^[a-z'-]+$/i.test(n) && !RELATION.test(n));
    if (nickNote && !out.nick) out.nick = nickNote;
    out.note = notes.filter((n) => n !== nickNote || out.nick !== nickNote).join(', ');
  }
  s = s.replace(/\d+/g, ' ').replace(/\s+/g, ' ').trim();
  const words = s.split(' ').filter(Boolean);
  if (!words.length) return digits.length >= 10 ? { kind: 'phone', phone: normalizePhone(digits) } : { kind: 'id' };
  out.first = words[0];
  out.last = words.slice(1).join(' ');
  return out;
}

// "Hi Jaime, this is Stacey..." -> Jaime: the name the clinic actually uses
const GREETING = /^\s*(?:[Hh]i|[Hh]ello|[Hh]ey|[Gg]ood (?:morning|afternoon|evening)|[Dd]ear)[\s,!]+([A-Z][a-zA-Z'’-]{1,20})\b/;
const NOT_A_NAME = /^(this|there|all|everyone|again|it|its|just|we|our|the|from|thank|thanks|mobility|i|you|yes|ok|sorry)$/i;

function greetingNames(messages) {
  const counts = new Map();
  for (const m of messages) {
    if (m.direction !== 'out') continue;
    const g = GREETING.exec(m.body);
    if (g && !NOT_A_NAME.test(g[1])) counts.set(g[1], (counts.get(g[1]) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([name, count]) => ({ name, count }));
}

// ---------- Staging ----------

// Insert or refresh one file + phone and its messages; returns the thread id.
// An imported thread whose file now has more texts is opened for import again.
function stagingStatements() {
  const upsertThread = db.prepare(`
    INSERT INTO textable_threads (file, phone, our_phone, label_kind, label_first, label_last, label_nick, label_note, label_phone,
      greetings, file_notes, msg_count, first_at, last_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (file, phone) DO UPDATE SET our_phone = excluded.our_phone, label_kind = excluded.label_kind,
      label_first = excluded.label_first, label_last = excluded.label_last, label_nick = excluded.label_nick,
      label_note = excluded.label_note, label_phone = excluded.label_phone, greetings = excluded.greetings,
      file_notes = excluded.file_notes, msg_count = excluded.msg_count, first_at = excluded.first_at, last_at = excluded.last_at
    RETURNING id`);
  const insMsg = db.prepare(`INSERT INTO textable_messages (ext_id, thread_id, direction, body, attachments, created_at)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (ext_id) DO UPDATE SET thread_id = excluded.thread_id, body = excluded.body,
    attachments = excluded.attachments, created_at = excluded.created_at`);
  const hasRef = db.prepare('SELECT 1 FROM messages WHERE ref_id = ?');
  const reopen = db.prepare(`UPDATE textable_threads SET imported_at = NULL WHERE id = ? AND imported_at IS NOT NULL AND action != 'skip'`);
  return (t, messages) => {
    const { id } = upsertThread.get(t.file, t.phone, t.ourPhone, t.label.kind, t.label.first, t.label.last, t.label.nick, t.label.note,
      t.label.phone, JSON.stringify(t.greetings), JSON.stringify(t.fileNotes), messages.length, messages[0].at, messages.at(-1).at);
    for (const m of messages) insMsg.run(m.id, id, m.direction, m.body, JSON.stringify(m.attachments), m.at);
    if (messages.some((m) => !hasRef.get(`textable:${m.id}`))) reopen.run(id);
    return id;
  };
}

// files: [{ name, text }]. Re-staging a file replaces its messages but keeps
// decisions already confirmed for it.
export function stageFiles(files) {
  const result = { files: 0, threads: 0, messages: 0, repaired: 0, unreadable: 0, errors: [] };
  const stage = stagingStatements();

  tx(() => {
    for (const f of files) {
      const name = String(f.name ?? '').split(/[\\/]/).pop();
      if (!/\.csv$/i.test(name)) continue;
      let parsed;
      try {
        parsed = readExport(String(f.text ?? ''));
      } catch (err) {
        result.errors.push(`${name}: ${err.message}`);
        continue;
      }
      result.files++;
      result.repaired += parsed.repaired;
      result.unreadable += parsed.unreadable;
      const label = parseLabel(name);

      // Split by the other party's phone
      const byPhone = new Map();
      for (const m of parsed.messages) {
        const ours = normalizePhone(m.direction === 'out' ? m.from : m.to);
        const theirs = normalizePhone(m.direction === 'out' ? m.to : m.from);
        if (!theirs) continue;
        if (!byPhone.has(theirs)) byPhone.set(theirs, { ours, messages: [] });
        byPhone.get(theirs).messages.push(m);
      }
      if (!byPhone.size) {
        result.errors.push(`${name}: no messages`);
        continue;
      }
      const notes = [];
      if (parsed.repaired) notes.push(`${parsed.repaired} row${parsed.repaired === 1 ? '' : 's'} with a line break in the text were repaired`);
      if (parsed.unreadable) notes.push(`${parsed.unreadable} row${parsed.unreadable === 1 ? '' : 's'} could not be read and will be left out`);
      if (byPhone.size > 1) notes.push(`This file has ${byPhone.size} different phone numbers; each is its own conversation`);

      for (const [phone, { ours, messages }] of byPhone) {
        messages.sort((a, b) => a.at - b.at);
        stage({
          file: name, phone, ourPhone: ours, greetings: greetingNames(messages), fileNotes: notes,
          label: { kind: label.kind, first: titleCase(label.first ?? ''), last: titleCase(label.last ?? ''), nick: titleCase(label.nick ?? ''), note: label.note ?? '', phone: label.phone ?? '' },
        }, messages);
        result.threads++;
        result.messages += messages.length;
      }
    }
  });
  matchThreads();
  return result;
}

// ---------- Matching ----------

// Common nicknames; each line is one group of names that can mean the same person
const NICKNAME_GROUPS = `
abigail abby abbie gail|abraham abe bram|adam ade|adrian adrienne|albert al bert bertie|alexander alex al alec lex sandy xander|alexandra alex alexa lexi sandra sandy|alfred al alf fred freddie|alice ally allie|allison allie ally|amanda mandy manda|andrea andi|andrew andy drew|angela angie|anthony tony ant|antonio tony toño|arthur art artie|barbara barb barbie babs|benjamin ben benny benji|bernard bernie|beverly bev|bradley brad|brian bri|bridget bridie|caroline carrie carol|catherine kathy cathy kate katie cat kat kit|charles charlie chuck chas chaz|charlotte charlie lottie|christian chris|christina chris tina christy|christine chris tina|christopher chris kit topher|clifford cliff|cynthia cindy|daniel dan danny|danielle dani|david dave davey|deborah deb debbie|dennis denny|donald don donnie|dorothy dot dottie|douglas doug|edward ed eddie ted ned|eleanor ellie nell nora|elizabeth liz lizzie beth betty betsy eliza lisa libby|emily em emmy|eugene gene|evelyn evie|frances fran frannie|francis frank fran|francisco paco pancho frank|frederick fred freddie rick|gabriel gabe|gabriela gabby|gerald gerry jerry|gregory greg|guadalupe lupe|guillermo memo willy|harold hal harry|harrison harry|helen nell|henry hank harry|herbert herb|ignacio nacho|isabella izzy bella|jacob jake|jacqueline jackie|james jim jimmy jamie|janet jan|jeffrey jeff|jennifer jen jenny|jeremy jerry|jesus chuy|jessica jess jessie|joanne jo|john johnny jack|jonathan jon jonny|jose pepe|joseph joe joey|joshua josh|judith judy|julia julie|katherine kathy kate katie kat|kathleen kathy kate katie|kenneth ken kenny|kimberly kim|lawrence larry|leonard leo len lenny|lorraine lori|louis lou|lucas luke|luis lucho|madeline maddie|manuel manny|margaret maggie meg peggy marge margie greta|maria mari|marilyn mari|martha marty|matthew matt|melissa mel missy|michael mike mikey mick|michelle shelly|mitchell mitch|nathan nate|nathaniel nate nat|nicholas nick nicky|nicole nikki|pamela pam|patricia pat patty trish tricia|patrick pat paddy|peter pete|philip phil|rachel rach|raymond ray|rebecca becky becca|richard rich rick dick ricky|robert rob bob bobby robbie bert|rodney rod|ronald ron ronnie|rosemary rose|russell russ|samantha sam sammy|samuel sam sammy|sandra sandy|sarah sally sadie|stephanie steph|stephen steve stevie|steven steve stevie|stuart stu|susan sue susie suzy|suzanne sue suzy|teresa terry tess|theodore ted teddy theo|thomas tom tommy|timothy tim timmy|tobias toby|valerie val|veronica ronnie|victoria vicky tori|vincent vince vinny|virginia ginny|walter walt|william will bill billy liam willy|zachary zach zack`;
const NICK = new Map();
for (const group of NICKNAME_GROUPS.trim().split('|')) {
  const names = group.trim().split(/\s+/);
  for (const n of names) {
    if (!NICK.has(n)) NICK.set(n, new Set());
    for (const m of names) NICK.get(n).add(m);
  }
}

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z\s-]/g, '').trim();
const squash = (s) => norm(s).replace(/[\s-]/g, '');

function lev(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

// How well two first names match, and why
function firstPair(a, b) {
  a = squash(a);
  b = squash(b);
  if (!a || !b) return [0, ''];
  if (a === b) return [1, 'same first name'];
  if (NICK.get(a)?.has(b)) return [0.9, 'nickname'];
  if (a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a))) return [0.8, 'short form'];
  if (Math.min(a.length, b.length) >= 4 && lev(a, b) <= 1) return [0.75, 'spelling'];
  return [0, ''];
}

function lastScore(a, b) {
  const sa = squash(a);
  const sb = squash(b);
  if (!sa || !sb) return [0, ''];
  if (sa === sb) return [1, 'same last name'];
  const ta = norm(a).split(/[\s-]+/).filter((t) => t.length >= 3);
  const tb = norm(b).split(/[\s-]+/).filter((t) => t.length >= 3);
  if (ta.some((t) => tb.includes(t))) return [0.85, 'part of last name'];
  const d = lev(sa, sb);
  if ((sa.length >= 5 && d <= 1) || (sa.length >= 8 && d <= 2)) return [0.8, 'last name spelling'];
  return [0, ''];
}

// Score a file name against a contact. Names of 3+ words are tried with every
// first/last split ("Mary Ann Smith", "Juan Cuauxinque Castro").
function nameScore(t, c, greetings) {
  const words = [t.label_first, ...t.label_last.split(' ')].filter(Boolean);
  const splits = words.length < 2 ? [[words[0] ?? '', '']] : words.slice(1).map((_, k) => [words.slice(0, k + 1).join(' '), words.slice(k + 1).join(' ')]);
  const fileFirsts = (first) => [first, first.split(' ')[0], t.label_nick, ...greetings.map((g) => g.name)].filter(Boolean);
  const contactFirsts = [c.first_name, c.first_name.split(' ')[0], c.nickname].filter(Boolean);
  let best = { score: 0, first: 0, last: 0, why: [], via: '' };
  for (const [first, last] of splits) {
    let f = [0, ''];
    let viaName = '';
    for (const a of fileFirsts(first)) for (const b of contactFirsts) {
      const p = firstPair(a, b);
      if (p[0] > f[0]) { f = p; viaName = a; }
    }
    const l = last ? lastScore(last, c.last_name) : [0, ''];
    const score = last ? (f[0] && l[0] ? (f[0] + l[0]) / 2 : 0) : f[0] * 0.5;
    if (score > best.score || (!best.score && l[0] > best.last)) best = { score, first: f[0], last: l[0], why: [f[1], l[1]].filter(Boolean), via: viaName, fileFirst: first };
  }
  return best;
}

// (Re)compute suggestions for every thread that isn't confirmed or imported
export function matchThreads() {
  const contacts = db.prepare('SELECT id, first_name, last_name, nickname, phone, dob, patient_id, inactive_at FROM contacts').all();
  const byPhone = new Map();
  // Candidates by the first letter of each part of the last name, so
  // "Smyth" still finds "Smith" and "Castro" finds "Cuauxinque-Castro"
  const byInitial = new Map();
  const add = (map, key, c) => key && (map.get(key) ?? map.set(key, new Set()).get(key)).add(c);
  for (const c of contacts) {
    if (c.phone) (byPhone.get(c.phone) ?? byPhone.set(c.phone, []).get(c.phone)).push(c);
    for (const part of norm(c.last_name).split(/[\s-]+/)) add(byInitial, part[0], c);
  }
  const display = db.prepare('SELECT contact_id FROM phone_display WHERE phone = ?');
  const save = db.prepare(`UPDATE textable_threads SET status = ?, reasons = ?, candidates = ?, action = ?, contact_id = ?,
    first_name = ?, last_name = ?, nickname = ?, copy_from = NULL WHERE id = ?`);
  const threads = db.prepare('SELECT * FROM textable_threads WHERE confirmed = 0 AND imported_at IS NULL').all();

  tx(() => {
    for (const t of threads) {
      const greetings = JSON.parse(t.greetings);
      const reasons = [];
      const onPhone = byPhone.get(t.phone) ?? [];
      const describe = (c, s) => ({ id: c.id, name: fullName(c) || '(no name)', phone: c.phone, patientId: c.patient_id, dob: c.dob,
        inactive: !!c.inactive_at, samePhone: c.phone === t.phone, score: Math.round((s?.score ?? 0) * 100), why: s?.why ?? [] });
      const set = (status, action, { contact = null, first = '', last = '', nick = '', candidates = [] } = {}) =>
        save.run(status, JSON.stringify(reasons), JSON.stringify(candidates), action, contact, first, last, nick, t.id);

      if (t.label_kind === 'shortcode' || !isValidPhone(t.phone) || t.phone.length < 10) {
        reasons.push('Short code or non-US number (usually automated texts)');
        set('skip', 'skip');
        continue;
      }
      if (t.label_phone && t.label_phone !== t.phone) reasons.push(`The file name says ${showPhone(t.label_phone)} but the texts are with ${showPhone(t.phone)}`);
      if (JSON.parse(t.file_notes).some((n) => n.includes('different phone numbers'))) reasons.push('The file has more than one phone number');
      const mustReview = reasons.length > 0;

      if (t.label_kind !== 'name') {
        const primary = onPhone.find((c) => c.id === display.get(t.phone)?.contact_id) ?? onPhone[0];
        if (primary) {
          reasons.push(`The phone belongs to ${fullName(primary)}`);
          set(mustReview ? 'review' : 'auto', 'link', { contact: primary.id, candidates: onPhone.map((c) => describe(c)) });
        } else {
          reasons.push(greetings.length ? `No contact has this phone; texts greet "${greetings[0].name}"` : 'No contact has this phone');
          set(mustReview ? 'review' : 'none', 'phone', { first: greetings[0]?.name ?? '' });
        }
        continue;
      }

      // Contacts on this phone, plus anyone else with a similar last name
      const pool = new Map(onPhone.map((c) => [c.id, c]));
      for (const part of norm(`${t.label_first} ${t.label_last}`).split(/[\s-]+/).slice(1)) {
        for (const c of byInitial.get(part[0]) ?? []) pool.set(c.id, c);
      }
      const scored = [...pool.values()].map((c) => ({ c, s: nameScore(t, c, greetings) }))
        .filter(({ c, s }) => c.phone === t.phone || s.score >= 0.75)
        .sort((a, b) => (b.c.phone === t.phone) - (a.c.phone === t.phone) || b.s.score - a.s.score);
      const candidates = scored.slice(0, 8).map(({ c, s }) => describe(c, s));
      const strongOnPhone = scored.filter(({ c, s }) => c.phone === t.phone && s.score >= 0.75);
      const elsewhere = scored.filter(({ c, s }) => c.phone !== t.phone && s.score >= 0.75);
      const fileName = { first: t.label_first, last: t.label_last, nick: t.label_nick };

      if (strongOnPhone.length) {
        const [{ c, s }] = strongOnPhone;
        const tie = strongOnPhone.length > 1 && strongOnPhone[1].s.score === s.score;
        // Nickname to set: the one in the file name, or the first name the file
        // used when it's a nickname/short form of the contact's first name
        let nick = t.label_nick;
        if (!nick && s.via && squash(s.via) !== squash(c.first_name) && squash(s.via) !== squash(c.nickname) && s.first < 1) nick = titleCase(s.via);
        // "Hi Bob" in the texts to Robert: Bob is the nickname. "Hi Jaime" in
        // the texts to John: maybe a parent's phone, so look closer
        const greeted = greetings[0]?.name;
        const greetPair = greeted ? Math.max(...[c.first_name, c.nickname].filter(Boolean).map((n) => firstPair(greeted, n)[0])) : 1;
        if (!nick && greeted && greetPair >= 0.75 && greetPair < 1) nick = titleCase(greeted);
        if (nick && squash(nick) === squash(c.first_name)) nick = '';
        let review = mustReview || tie;
        reasons.push(`Same phone and ${s.why.join(', ')}`);
        if (greeted && !greetPair && !(t.label_nick && firstPair(greeted, t.label_nick)[0])) {
          reasons.push(`Texts greet them as "${greeted}", not ${c.first_name}`);
          review = true;
        }
        if (tie) reasons.push('More than one contact on this phone fits the name');
        if (nick && c.nickname && squash(c.nickname) !== squash(nick)) {
          reasons.push(`Contact's nickname "${c.nickname}" would change to "${nick}"`);
          review = true;
        }
        if (s.score < 0.85) review = true;
        set(review ? 'review' : 'auto', 'link', { contact: c.id, nick: squash(nick) === squash(c.nickname) ? '' : nick, candidates });
      } else if (onPhone.length) {
        reasons.push(`The phone belongs to ${onPhone.map((c) => fullName(c)).join(', ')}, not a name like this one`);
        if (elsewhere.length) reasons.push(`${fullName(elsewhere[0].c)} has a similar name but a different phone`);
        set('review', 'phone', { first: fileName.first, last: fileName.last, nick: fileName.nick, candidates });
      } else if (elsewhere.length) {
        reasons.push(`No contact has this phone; ${elsewhere.map(({ c }) => fullName(c)).slice(0, 3).join(', ')} ${elsewhere.length === 1 ? 'has' : 'have'} a similar name and a different phone`);
        set('review', 'create', { first: fileName.first, last: fileName.last, nick: fileName.nick, candidates });
      } else {
        reasons.push('No contact has this phone or a similar name');
        set(mustReview ? 'review' : 'none', 'create', { first: fileName.first, last: fileName.last, nick: fileName.nick, candidates });
      }
    }
  });
}

// ---------- Review ----------

const serializeThread = (t) => ({
  id: t.id,
  file: t.file,
  phone: t.phone,
  label: { kind: t.label_kind, first: t.label_first, last: t.label_last, nick: t.label_nick, note: t.label_note, phone: t.label_phone },
  greetings: JSON.parse(t.greetings),
  fileNotes: JSON.parse(t.file_notes),
  messages: t.msg_count,
  firstAt: t.first_at,
  lastAt: t.last_at,
  status: t.status,
  reasons: JSON.parse(t.reasons),
  candidates: JSON.parse(t.candidates),
  action: t.action,
  contactId: t.contact_id,
  contactName: t.contact_name ?? null,
  firstName: t.first_name,
  lastName: t.last_name,
  nickname: t.nickname,
  copyFrom: t.copy_from,
  confirmed: !!t.confirmed,
  importedAt: t.imported_at,
  imported: t.imported_n,
});

const THREAD_SELECT = `SELECT t.*, TRIM(CASE WHEN c.nickname != '' THEN '"' || c.nickname || '" ' ELSE '' END || c.first_name || ' ' || c.last_name) AS contact_name
  FROM textable_threads t LEFT JOIN contacts c ON c.id = t.contact_id`;

export function listThreads() {
  return db.prepare(`${THREAD_SELECT} ORDER BY t.label_last COLLATE NOCASE, t.label_first COLLATE NOCASE, t.file`).all().map(serializeThread);
}

export const getThread = (id) => {
  const t = db.prepare(`${THREAD_SELECT} WHERE t.id = ?`).get(id);
  return t ? serializeThread(t) : null;
};

export function threadMessages(id) {
  return db.prepare('SELECT ext_id AS id, direction, body, attachments, created_at AS createdAt FROM textable_messages WHERE thread_id = ? ORDER BY created_at')
    .all(id).map((m) => ({ ...m, attachments: JSON.parse(m.attachments) }));
}

// Save an admin's decision for one thread (always marks it confirmed)
export function decide(id, d) {
  const t = db.prepare('SELECT * FROM textable_threads WHERE id = ?').get(id);
  if (!t) throw Object.assign(new Error('Not found'), { status: 404 });
  if (t.imported_at) throw Object.assign(new Error('Already imported'), { status: 409 });
  const action = String(d.action ?? '');
  if (!['link', 'create', 'phone', 'skip'].includes(action)) throw Object.assign(new Error('Choose what to do with this conversation'), { status: 400 });
  const clean = (v) => String(v ?? '').trim().slice(0, 100);
  let contactId = null;
  let copyFrom = null;
  if (action === 'link') {
    contactId = Number(d.contactId);
    const c = db.prepare('SELECT phone FROM contacts WHERE id = ?').get(contactId);
    if (!c) throw Object.assign(new Error('Pick a contact'), { status: 400 });
    if (c.phone !== t.phone) throw Object.assign(new Error('That contact has a different phone. Use "New contact" to add this phone as its own contact.'), { status: 400 });
  }
  if (action === 'create') {
    if (!clean(d.firstName) && !clean(d.lastName)) throw Object.assign(new Error('Enter a first or last name'), { status: 400 });
    copyFrom = d.copyFrom ? Number(d.copyFrom) || null : null;
  }
  db.prepare(`UPDATE textable_threads SET action = ?, contact_id = ?, first_name = ?, last_name = ?, nickname = ?, copy_from = ?, confirmed = 1 WHERE id = ?`)
    .run(action, contactId, action === 'create' ? clean(d.firstName) : '', action === 'create' ? clean(d.lastName) : '',
      ['link', 'create'].includes(action) ? clean(d.nickname) : '', copyFrom, id);
  return getThread(id);
}

// Accept the suggestions as they are for these threads
export function confirmThreads(ids) {
  const clean = [...new Set(ids.map(Number).filter(Boolean))];
  return db.prepare(`UPDATE textable_threads SET confirmed = 1 WHERE confirmed = 0 AND imported_at IS NULL
    AND id IN (SELECT value FROM json_each(?))`).run(JSON.stringify(clean)).changes;
}

export function unconfirm(id) {
  db.prepare('UPDATE textable_threads SET confirmed = 0 WHERE id = ? AND imported_at IS NULL').run(id);
  matchThreads();
  return getThread(id);
}

// Forget staged files that haven't been imported
export function clearStaged() {
  return db.prepare('DELETE FROM textable_threads WHERE imported_at IS NULL').run().changes;
}

// ---------- Import ----------

// History opt-outs: the last STOP/START word from each phone wins. "Cancel"
// is left out here: at a clinic it usually means an appointment, and
// Textable didn't treat it as an opt-out.
const STOP_WORDS = /^(stop|stopall|unsubscribe|end|quit|optout|opt out|revoke)[.!]?$/i;
const START_WORDS = /^(start|unstop|subscribe|optin|opt in)[.!]?$/i;

function historyOptOuts(threadIds) {
  if (!threadIds.length) return new Map();
  const rows = db.prepare(`SELECT t.phone, m.body, m.created_at FROM textable_messages m JOIN textable_threads t ON t.id = m.thread_id
    WHERE m.direction = 'in' AND t.id IN (SELECT value FROM json_each(?)) ORDER BY m.created_at`).all(JSON.stringify(threadIds));
  const state = new Map();
  for (const r of rows) {
    const text = r.body.trim();
    if (STOP_WORDS.test(text)) state.set(r.phone, { optedOut: true, at: r.created_at, word: text });
    else if (START_WORDS.test(text)) state.set(r.phone, { optedOut: false, at: r.created_at, word: text });
  }
  return state;
}

// What importing the confirmed threads would do
export function importSummary() {
  const ready = db.prepare(`SELECT * FROM textable_threads WHERE confirmed = 1 AND imported_at IS NULL AND action != 'skip'`).all();
  const numbers = new Map(db.prepare('SELECT id, phone, active FROM numbers').all().map((n) => [n.phone, n]));
  const missingNumbers = [...new Set(ready.map((t) => t.our_phone))].filter((p) => !numbers.has(p));
  const opt = historyOptOuts(ready.map((t) => t.id));
  const already = new Set(db.prepare('SELECT phone FROM opt_outs').all().map((r) => r.phone));
  const optOuts = [...opt].filter(([phone, s]) => s.optedOut && !already.has(phone)).map(([phone, s]) => ({ phone, at: s.at, word: s.word }));
  const counts = db.prepare(`SELECT
      COUNT(*) AS total,
      SUM(imported_at IS NOT NULL) AS imported,
      SUM(imported_at IS NULL AND confirmed = 1) AS confirmed,
      SUM(imported_at IS NULL AND confirmed = 0 AND status = 'auto') AS auto,
      SUM(imported_at IS NULL AND confirmed = 0 AND status = 'review') AS review,
      SUM(imported_at IS NULL AND confirmed = 0 AND status = 'none') AS none,
      SUM(imported_at IS NULL AND confirmed = 0 AND status = 'skip') AS skip
    FROM textable_threads`).get();
  return {
    counts: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v ?? 0])),
    ready: ready.length,
    readyMessages: ready.reduce((n, t) => n + t.msg_count, 0),
    creates: ready.filter((t) => t.action === 'create').length,
    nicknames: ready.filter((t) => t.action === 'link' && t.nickname).length,
    missingNumbers,
    optOuts,
  };
}

// Imported messages get negative ids ordered by time, so they sort before every
// message TextBoss stored itself (conversations order by id) and never count
// as unread. Their ref_id is "textable:<ID>", so importing again skips them.
const ID_BASE = 4_000_000_000_000;

export function importConfirmed({ archiveDays = 0, inactiveDays = 0 } = {}) {
  const summary = importSummary();
  if (summary.missingNumbers.length) {
    throw Object.assign(new Error(`Add ${summary.missingNumbers.join(', ')} under Admin → Numbers first (it can stay turned off)`), { status: 400 });
  }
  const now = Date.now();
  const numbers = new Map(db.prepare('SELECT id, phone FROM numbers').all().map((n) => [n.phone, n.id]));
  const threads = db.prepare(`SELECT * FROM textable_threads WHERE confirmed = 1 AND imported_at IS NULL ORDER BY id`).all();
  const opt = historyOptOuts(threads.filter((t) => t.action !== 'skip').map((t) => t.id));
  const result = { conversations: 0, messages: 0, duplicates: 0, created: 0, nicknames: 0, optedOut: 0, archived: 0, skipped: 0 };

  const exists = db.prepare('SELECT 1 FROM messages WHERE ref_id = ?');
  const idTaken = db.prepare('SELECT 1 FROM messages WHERE id = ?');
  const ins = db.prepare(`INSERT INTO messages (id, conversation_id, direction, from_phone, body, media, status, ref_id, sent_by, kind, created_at)
    VALUES (?, ?, ?, ?, ?, '[]', ?, ?, NULL, 'import', ?)`);
  const msgs = db.prepare('SELECT * FROM textable_messages WHERE thread_id = ? ORDER BY created_at');
  // The decision is kept as made (so it can be exported to another TextBoss);
  // a contact it created is remembered so a later import of newer texts reuses it
  const done = db.prepare('UPDATE textable_threads SET imported_at = ?, imported_n = COALESCE(imported_n, 0) + ?, contact_id = COALESCE(?, contact_id) WHERE id = ?');

  tx(() => {
    for (const t of threads) {
      if (t.action === 'skip') {
        done.run(now, 0, null, t.id);
        result.skipped++;
        continue;
      }
      const numberId = numbers.get(t.our_phone);
      const before = db.prepare('SELECT id, last_message_at FROM conversations WHERE number_id = ? AND participants = ?').get(numberId, t.phone);
      const conversation = getOrCreateConversation(numberId, t.phone);
      let n = 0;
      for (const m of msgs.all(t.id)) {
        const ref = `textable:${m.ext_id}`;
        if (exists.get(ref)) { result.duplicates++; continue; }
        let id = m.created_at - ID_BASE;
        while (idTaken.get(id)) id--;
        const files = JSON.parse(m.attachments);
        const note = files.map((a) => `[${/^image\//.test(a.contentType ?? '') ? 'Picture' : 'Attachment'} not included in the Textable export${a.filename ? `: ${a.filename}` : ''}]`).join('\n');
        const body = [m.body, note].filter(Boolean).join('\n');
        ins.run(id, conversation.id, m.direction, m.direction === 'out' ? t.our_phone : t.phone, body,
          m.direction === 'out' ? 'delivered' : 'received', ref, m.created_at);
        n++;
      }
      db.prepare('UPDATE conversations SET last_message_at = MAX(last_message_at, ?) WHERE id = ?').run(t.last_at, conversation.id);
      // Old history goes straight to the archive (new conversations only)
      if (!before && archiveDays > 0 && t.last_at < now - archiveDays * 86_400_000) {
        db.prepare('UPDATE conversations SET archived = 1 WHERE id = ?').run(conversation.id);
        result.archived++;
      }
      result.messages += n;
      result.conversations++;

      let contactId = null;
      if (t.action === 'link' && t.contact_id) {
        contactId = t.contact_id;
        if (t.nickname) { updateContact(contactId, { nickname: t.nickname }); result.nicknames++; }
        // Several contacts on one phone: the one Textable named becomes the display name
        if (db.prepare('SELECT COUNT(*) AS n FROM contacts WHERE phone = ?').get(t.phone).n > 1) setDisplayContact(contactId);
      } else if (t.action === 'create' && t.contact_id && db.prepare('SELECT 1 FROM contacts WHERE id = ? AND phone = ?').get(t.contact_id, t.phone)) {
        contactId = t.contact_id;
      } else if (t.action === 'create') {
        const src = t.copy_from ? db.prepare('SELECT dob, email FROM contacts WHERE id = ?').get(t.copy_from) : null;
        contactId = createContact({ firstName: t.first_name, lastName: t.last_name, nickname: t.nickname, phone: t.phone,
          dob: src?.dob ?? '', email: src?.email ?? '', notes: 'Added from Textable history' });
        if (inactiveDays > 0 && t.last_at < now - inactiveDays * 86_400_000) {
          db.prepare(`UPDATE contacts SET inactive_at = ?, inactive_reason = 'idle' WHERE id = ?`).run(now, contactId);
        }
        result.created++;
      }
      const o = opt.get(t.phone);
      if (o?.optedOut && !db.prepare('SELECT 1 FROM opt_outs WHERE phone = ?').get(t.phone)) {
        setOptOut(t.phone, true, 'textable');
        result.optedOut++;
      }
      done.run(now, n, contactId, t.id);
    }
  });
  if (!threads.length) return result;
  logImport('textable', `Textable history: ${result.conversations} conversations, ${result.messages} messages`,
    { created: result.created, updated: result.nicknames, skipped: result.skipped, issueCount: 0 });
  publish(allUserIds(), 'contacts', {});
  return result;
}

// ---------- Moving a review between TextBoss installs ----------
//
// The review can be done on a practice copy (npm run clone:make) and carried
// to the live TextBoss as a file: the staged texts plus every decision. The
// live one checks each linked contact is still the same person (same id,
// phone, and client ID or name) before trusting it.

const snapshot = (id) => {
  const c = id && db.prepare('SELECT id, first_name, last_name, phone, patient_id FROM contacts WHERE id = ?').get(id);
  return c ? { id: c.id, firstName: c.first_name, lastName: c.last_name, phone: c.phone, patientId: c.patient_id } : null;
};

export function exportReview() {
  const threads = db.prepare('SELECT * FROM textable_threads ORDER BY id').all();
  const msgs = db.prepare('SELECT ext_id, direction, body, attachments, created_at FROM textable_messages WHERE thread_id = ? ORDER BY created_at');
  return {
    app: 'textboss',
    kind: 'textable-review',
    format: 1,
    exportedAt: new Date().toISOString(),
    threads: threads.map((t) => ({
      file: t.file,
      phone: t.phone,
      ourPhone: t.our_phone,
      label: { kind: t.label_kind, first: t.label_first, last: t.label_last, nick: t.label_nick, note: t.label_note, phone: t.label_phone },
      greetings: JSON.parse(t.greetings),
      fileNotes: JSON.parse(t.file_notes),
      confirmed: !!t.confirmed,
      action: t.action,
      // A contact this copy created on import doesn't exist anywhere else
      contact: t.action === 'link' ? snapshot(t.contact_id) : null,
      copyFrom: t.action === 'create' ? snapshot(t.copy_from) : null,
      firstName: t.first_name,
      lastName: t.last_name,
      nickname: t.nickname,
      messages: msgs.all(t.id).map((m) => ({ id: m.ext_id, direction: m.direction, body: m.body, attachments: JSON.parse(m.attachments), at: m.created_at })),
    })),
  };
}

// Same person: same id and phone, and the same client ID (or name, without one)
function sameContact(snap, phone) {
  if (!snap) return null;
  const c = db.prepare('SELECT * FROM contacts WHERE id = ?').get(snap.id);
  if (!c || (phone && c.phone !== phone)) return null;
  const same = snap.patientId
    ? c.patient_id === snap.patientId
    : squash(c.first_name) === squash(snap.firstName) && squash(c.last_name) === squash(snap.lastName);
  return same ? c : null;
}

export function loadReview(review) {
  if (review?.app !== 'textboss' || review.kind !== 'textable-review' || !Array.isArray(review.threads)) {
    throw Object.assign(new Error('That isn\'t a Textable review file from TextBoss'), { status: 400 });
  }
  const result = { threads: 0, confirmed: 0, recheck: [], alreadyImported: 0 };
  const stage = stagingStatements();
  const current = db.prepare('SELECT imported_at FROM textable_threads WHERE id = ?');
  const save = db.prepare(`UPDATE textable_threads SET action = ?, contact_id = ?, first_name = ?, last_name = ?, nickname = ?, copy_from = ?,
    confirmed = 1 WHERE id = ? AND imported_at IS NULL`);
  const unconfirm = db.prepare('UPDATE textable_threads SET confirmed = 0 WHERE id = ? AND imported_at IS NULL');

  tx(() => {
    for (const t of review.threads) {
      const messages = (t.messages ?? []).filter((m) => m?.id && ['in', 'out'].includes(m.direction) && Number.isFinite(m.at));
      if (!t.file || !t.phone || !messages.length) continue;
      const id = stage({ ...t, ourPhone: t.ourPhone ?? '', label: { kind: 'name', first: '', last: '', nick: '', note: '', phone: '', ...t.label } }, messages);
      result.threads++;
      if (current.get(id).imported_at) {
        result.alreadyImported++;
        continue;
      }
      if (!t.confirmed || !['link', 'create', 'phone', 'skip'].includes(t.action)) {
        unconfirm.run(id);
        continue;
      }
      let contactId = null;
      let copyFrom = null;
      if (t.action === 'link') {
        contactId = sameContact(t.contact, t.phone)?.id;
        if (!contactId) {
          unconfirm.run(id);
          result.recheck.push(`${t.file}: the contact it was linked to has changed here`);
          continue;
        }
      }
      if (t.action === 'create' && t.copyFrom) copyFrom = sameContact(t.copyFrom, null)?.id ?? null;
      save.run(t.action, contactId, t.firstName ?? '', t.lastName ?? '', t.nickname ?? '', copyFrom, id);
      result.confirmed++;
    }
  });
  matchThreads();
  return result;
}
