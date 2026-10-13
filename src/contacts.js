import * as XLSX from 'xlsx';
import { db, tx } from './db.js';
import { normalizePhone, isValidPhone } from './phone.js';

export const CONTACT_FIELDS = ['firstName', 'lastName', 'phone', 'dob', 'email', 'patientId', 'notes'];
const COLUMN = {
  firstName: 'first_name',
  lastName: 'last_name',
  phone: 'phone',
  dob: 'dob',
  email: 'email',
  patientId: 'patient_id',
  notes: 'notes',
};

export function serializeContact(row) {
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    phone: row.phone,
    dob: row.dob,
    email: row.email,
    patientId: row.patient_id,
    notes: row.notes,
    optedOut: !!row.opted_out,
    blocked: !!row.blocked,
    updatedAt: row.updated_at,
  };
}

export const CONTACT_SELECT = `
  SELECT c.*,
    EXISTS (SELECT 1 FROM opt_outs o WHERE o.phone = c.phone AND c.phone != '') AS opted_out,
    EXISTS (SELECT 1 FROM blocked b WHERE b.phone = c.phone AND c.phone != '') AS blocked
  FROM contacts c`;

export function getContact(id) {
  const row = db.prepare(`${CONTACT_SELECT} WHERE c.id = ?`).get(id);
  return row ? serializeContact(row) : null;
}

export const fullName = (c) => [c.firstName ?? c.first_name, c.lastName ?? c.last_name].filter(Boolean).join(' ');

// Accepts YYYY-MM-DD, MM/DD/YYYY, M/D/YY, Excel serials and Date objects.
// Anything that is not a real calendar date comes back unchanged (and fails validation).
export function normalizeDob(value) {
  const out = parseDob(value);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(out);
  if (!m) return out;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const real = d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
  return real && +m[1] >= 1900 && d <= new Date() ? out : `invalid:${String(value).trim()}`;
}

function parseDob(value) {
  if (value == null || value === '') return '';
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'number' && value > 0 && value < 80000) {
    const d = XLSX.SSF.parse_date_code(value);
    if (d) return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  }
  const s = String(value).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/.exec(s);
  if (m) {
    let year = Number(m[3]);
    if (m[3].length === 2) year += year > (new Date().getFullYear() % 100) ? 1900 : 2000;
    return `${year}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  return s.slice(0, 20);
}

// Clean an incoming contact (from the API, the UI or a file row)
export function cleanContact(input) {
  const out = {};
  for (const f of CONTACT_FIELDS) {
    if (input[f] === undefined || input[f] === null) continue;
    let v = typeof input[f] === 'string' ? input[f].trim() : input[f];
    if (f === 'phone') v = normalizePhone(v);
    else if (f === 'dob') v = normalizeDob(v);
    else v = String(v).trim();
    out[f] = v;
  }
  return out;
}

export function validateContact(c, { partial = false } = {}) {
  if (!partial && !c.firstName && !c.lastName) return 'First or last name is required';
  if (c.phone && !isValidPhone(c.phone)) return `Not a valid phone number: ${c.phone}`;
  if (c.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) return `Not a valid email: ${c.email}`;
  if (c.dob && !/^\d{4}-\d{2}-\d{2}$/.test(c.dob)) return `Date of birth should be YYYY-MM-DD: ${c.dob}`;
  return null;
}

export function createContact(c) {
  const now = Date.now();
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO contacts (first_name, last_name, phone, dob, email, patient_id, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(c.firstName ?? '', c.lastName ?? '', c.phone ?? '', c.dob ?? '', c.email ?? '', c.patientId ?? '', c.notes ?? '', now, now);
  return Number(lastInsertRowid);
}

export function updateContact(id, c) {
  const sets = [];
  const params = [];
  for (const f of CONTACT_FIELDS) {
    if (c[f] === undefined) continue;
    sets.push(`${COLUMN[f]} = ?`);
    params.push(c[f]);
  }
  if (!sets.length) return;
  db.prepare(`UPDATE contacts SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...params, Date.now(), id);
}

export function setOptOut(phone, optedOut, source) {
  if (!phone) return;
  if (optedOut) {
    db.prepare('INSERT OR IGNORE INTO opt_outs (phone, source, created_at) VALUES (?, ?, ?)').run(phone, source, Date.now());
  } else {
    db.prepare('DELETE FROM opt_outs WHERE phone = ?').run(phone);
  }
}

// ---------- Import ----------

// Header text (lowercased, letters and digits only) -> field
const HEADER_MAP = [
  [/^(firstname|first|namefirst|givenname|patientfirstname)$/, 'firstName'],
  [/^(lastname|last|namelast|surname|familyname|patientlastname)$/, 'lastName'],
  [/^(name|fullname|patientname|patient)$/, 'fullName'],
  [/^(cellphone|cell|mobile|mobilephone|cellnumber|mobilenumber|sms|textnumber)$/, 'cellPhone'],
  [/^(phone|phonenumber|primaryphone|telephone)$/, 'phone'],
  [/^(homephone|home)$/, 'homePhone'],
  [/^(workphone|work|businessphone)$/, 'workPhone'],
  [/^(dateofbirth|dob|birthdate|birthday)$/, 'dob'],
  [/^(email|emailaddress|e?mail)$/, 'email'],
  [/^(webptpatientid|patientid|patientnumber|mrn|chartnumber|accountnumber|id)$/, 'patientId'],
  [/^(notes?|comments?)$/, 'notes'],
  [/^(optout|optedout|donottext|nosms|unsubscribed)$/, 'optedOut'],
];

function mapHeader(text) {
  const key = String(text ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const [re, field] of HEADER_MAP) if (re.test(key)) return field;
  return null;
}

const truthy = (v) => /^(1|y|yes|true|x|opted ?out|stop)$/i.test(String(v ?? '').trim());

// Parse a spreadsheet or CSV into contact records. Reports like WebPT's
// "Patient Listing" have title rows above the header, so the header row is
// the first row in the first 30 that maps a name column and a phone column.
export function parseContactFile(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error('The file has no sheets');
  // Keep blank rows so row numbers match what Excel shows
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null, blankrows: true });
  const firstRow = sheet['!ref'] ? XLSX.utils.decode_range(sheet['!ref']).s.r + 1 : 1;

  let headerIdx = -1;
  let mapping = null;
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const m = (rows[i] ?? []).map(mapHeader);
    const hasName = m.some((f) => ['firstName', 'lastName', 'fullName'].includes(f));
    const hasPhone = m.some((f) => ['cellPhone', 'phone', 'homePhone', 'workPhone'].includes(f));
    if (hasName && hasPhone) {
      headerIdx = i;
      mapping = m;
      break;
    }
  }
  if (headerIdx < 0) {
    throw new Error('Could not find a header row with a name column and a phone column');
  }

  const columns = rows[headerIdx]
    .map((text, i) => ({ header: String(text ?? '').trim(), field: mapping[i] }))
    .filter((c) => c.header);

  const records = [];
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    if (!row.some((v) => v != null && String(v).trim() !== '')) continue;
    const get = (field) => {
      const i = mapping.indexOf(field);
      return i >= 0 ? row[i] : null;
    };
    const rec = {
      _row: firstRow + r,
      firstName: get('firstName'),
      lastName: get('lastName'),
      dob: get('dob'),
      email: get('email'),
      patientId: get('patientId'),
      notes: get('notes'),
    };
    if (!rec.firstName && !rec.lastName && get('fullName')) {
      const full = String(get('fullName')).trim();
      if (full.includes(',')) {
        const [last, first] = full.split(',').map((s) => s.trim());
        Object.assign(rec, { firstName: first, lastName: last });
      } else {
        const [first, ...rest] = full.split(/\s+/);
        Object.assign(rec, { firstName: first, lastName: rest.join(' ') });
      }
    }
    // Prefer a cell number for texting, then a generic, home, then work phone
    const phones = ['cellPhone', 'phone', 'homePhone', 'workPhone'].map(get).filter((p) => p != null && String(p).trim());
    rec.phone = phones.find((p) => isValidPhone(p)) ?? phones[0] ?? null;
    if (mapping.includes('optedOut')) rec.optedOut = truthy(get('optedOut'));
    records.push(rec);
  }
  return { columns, records };
}

// Insert or update contacts. Matches on patient ID when present, otherwise on
// phone + first + last name. Only fields present in the input are changed, so
// an import never wipes notes or other data the export does not include.
//
// A bad phone, email or DOB does not skip the contact: that one field is left
// out (so an existing good value is kept) and reported in `issues`, with the
// row, name and patient ID so the source data can be fixed.
const FIELD_LABEL = { phone: 'Phone', email: 'Email', dob: 'Date of birth' };
const MAX_ISSUES = 2000;
const MAX_CHANGES = 1000;

export function upsertContacts(inputs, { dryRun = false } = {}) {
  const result = {
    created: 0, updated: 0, unchanged: 0, skipped: 0,
    issues: [], issueCount: 0, changes: [], changeCount: 0, preview: [], errors: [],
  };
  const byPatient = db.prepare(`SELECT * FROM contacts WHERE patient_id = ? AND patient_id != '' LIMIT 1`);
  const byPhoneName = db.prepare(
    `SELECT * FROM contacts WHERE phone = ? AND first_name = ? COLLATE NOCASE AND last_name = ? COLLATE NOCASE LIMIT 1`,
  );

  const report = (row, c, field, value, problem) => {
    result.issueCount++;
    if (result.issues.length >= MAX_ISSUES) return;
    result.issues.push({
      row,
      name: fullName(c) || '(no name)',
      patientId: c.patientId ?? '',
      field: FIELD_LABEL[field] ?? field,
      value: value == null ? '' : String(value),
      problem,
    });
  };

  const run = () => {
    inputs.forEach((raw, i) => {
      const row = raw._row ?? i + 1;
      const c = cleanContact(raw);

      // Drop invalid fields, keep the contact
      if (c.phone && !isValidPhone(c.phone)) {
        report(row, c, 'phone', raw.phone, 'Not a valid US phone number; imported without it');
        delete c.phone;
      }
      if (c.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) {
        report(row, c, 'email', raw.email, 'Not a valid email; imported without it');
        delete c.email;
      }
      if (c.dob && !/^\d{4}-\d{2}-\d{2}$/.test(c.dob)) {
        report(row, c, 'dob', raw.dob, 'Unrecognized date; imported without it');
        delete c.dob;
      }
      if (!c.firstName && !c.lastName) {
        result.skipped++;
        if (c.phone || c.patientId) report(row, c, 'name', '', 'No first or last name; row skipped');
        return;
      }

      const existing =
        (c.patientId && byPatient.get(c.patientId)) ||
        (c.phone && byPhoneName.get(c.phone, c.firstName ?? '', c.lastName ?? ''));

      let action;
      if (!existing) {
        action = 'create';
        result.created++;
        if (!dryRun) createContact(c);
      } else {
        const changes = {};
        const diff = [];
        for (const f of CONTACT_FIELDS) {
          if (c[f] !== undefined && c[f] !== '' && c[f] !== existing[COLUMN[f]]) {
            changes[f] = c[f];
            diff.push({ field: f, from: existing[COLUMN[f]] ?? '', to: c[f] });
          }
        }
        action = diff.length ? 'update' : 'unchanged';
        result[action === 'update' ? 'updated' : 'unchanged']++;
        if (diff.length) {
          result.changeCount++;
          if (result.changes.length < MAX_CHANGES) {
            result.changes.push({ row, name: fullName({ ...serializeContact(existing), ...c }), patientId: c.patientId ?? existing.patient_id, diff });
          }
          if (!dryRun) updateContact(existing.id, changes);
        }
      }
      if (!dryRun && raw.optedOut !== undefined && c.phone) setOptOut(c.phone, !!raw.optedOut, 'import');
      if (result.preview.length < 10) result.preview.push({ action, ...c });
    });
  };
  if (dryRun) run();
  else tx(run);
  // Short text form for API clients
  result.errors = result.issues.slice(0, 50).map((x) => `Row ${x.row} (${x.name}${x.patientId ? `, #${x.patientId}` : ''}): ${x.field} "${x.value}": ${x.problem}`);
  return result;
}

export function logImport(source, filename, result, error = null) {
  db.prepare(
    'INSERT INTO import_log (source, filename, created, updated, skipped, issues, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(source, filename ?? null, result?.created ?? 0, result?.updated ?? 0, result?.skipped ?? 0, result?.issueCount ?? 0, error, Date.now());
  db.prepare('DELETE FROM import_log WHERE id <= (SELECT MAX(id) - 200 FROM import_log)').run();
}

// phone -> display name, for conversation lists
export function contactNames() {
  const rows = db
    .prepare(`SELECT phone, first_name, last_name FROM contacts WHERE phone != '' ORDER BY last_name, first_name`)
    .all();
  const map = {};
  for (const r of rows) (map[r.phone] ??= []).push(fullName(r) || r.phone);
  return map;
}
