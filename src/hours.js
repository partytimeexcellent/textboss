// Office hours: a weekly schedule plus dated closures (holidays). While closed,
// incoming texts get the after-hours reply, once per conversation per closed
// stretch. Times are wall-clock times in the practice's time zone.

import { getSetting, setSetting } from './db.js';

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const DEFAULT_HOURS = {
  enabled: false,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York',
  // Each day: a list of open ranges; empty = closed all day
  week: {
    sun: [], mon: [{ start: '08:00', end: '17:00' }], tue: [{ start: '08:00', end: '17:00' }], wed: [{ start: '08:00', end: '17:00' }],
    thu: [{ start: '08:00', end: '17:00' }], fri: [{ start: '08:00', end: '17:00' }], sat: [],
  },
  message: 'Thanks for your message! Our office is closed right now. We\'ll get back to you when we reopen.',
  closures: [], // { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', name, message? }
};

export function getHours() {
  try {
    const saved = JSON.parse(getSetting('hours.config') ?? 'null');
    return saved ? { ...DEFAULT_HOURS, ...saved, week: { ...DEFAULT_HOURS.week, ...saved.week } } : { ...DEFAULT_HOURS };
  } catch {
    return { ...DEFAULT_HOURS };
  }
}

const validZone = (tz) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

// Throws a readable Error for anything wrong; returns the cleaned config
export function cleanHours(input = {}) {
  const out = { enabled: !!input.enabled };
  out.timezone = String(input.timezone ?? DEFAULT_HOURS.timezone);
  if (!validZone(out.timezone)) throw new Error('Choose a valid time zone');
  out.week = {};
  for (const d of DAYS) {
    const ranges = (Array.isArray(input.week?.[d]) ? input.week[d] : []).slice(0, 3).map((r) => ({ start: String(r?.start ?? ''), end: String(r?.end ?? '') }));
    for (const r of ranges) {
      if (!TIME.test(r.start) || !TIME.test(r.end)) throw new Error('Enter opening and closing times for each open day');
      if (r.end <= r.start) throw new Error(`On ${d[0].toUpperCase()}${d.slice(1)}, closing time must be after opening time`);
    }
    ranges.sort((a, b) => a.start.localeCompare(b.start));
    for (let i = 1; i < ranges.length; i++) {
      if (ranges[i].start < ranges[i - 1].end) throw new Error(`The hours on ${d[0].toUpperCase()}${d.slice(1)} overlap`);
    }
    out.week[d] = ranges;
  }
  out.message = String(input.message ?? '').trim().slice(0, 1600);
  if (out.enabled && !out.message) throw new Error('Write the after-hours reply');
  out.closures = (Array.isArray(input.closures) ? input.closures : []).slice(0, 100).map((c) => {
    const from = String(c?.from ?? '');
    const to = String(c?.to || from);
    if (!DATE.test(from) || !DATE.test(to)) throw new Error('Each closure needs a date');
    if (to < from) throw new Error(`"${c?.name || from}" ends before it starts`);
    return { from, to, name: String(c?.name ?? '').trim().slice(0, 80), message: String(c?.message ?? '').trim().slice(0, 1600) };
  }).sort((a, b) => a.from.localeCompare(b.from));
  return out;
}

export function saveHours(input) {
  const cfg = cleanHours(input);
  setSetting('hours.config', JSON.stringify(cfg));
  return cfg;
}

// Wall-clock parts of a moment in the given zone
const formatters = new Map();
function local(ts, tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' });
    formatters.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, day: p.weekday.slice(0, 3).toLowerCase() };
}

// Open or closed at a moment, and why
export function stateAt(ts, cfg = getHours()) {
  const { date, time, day } = local(ts, cfg.timezone);
  const closure = cfg.closures.find((c) => date >= c.from && date <= c.to);
  if (closure) return { open: false, closure };
  const open = (cfg.week[day] ?? []).some((r) => time >= r.start && time < r.end);
  return { open, closure: null };
}

const STEP = 5 * 60_000;
const HORIZON = 21 * 86_400_000;

// Walks in 5-minute steps to the moment the state last changed / next changes
function edge(ts, cfg, dir) {
  const now = stateAt(ts, cfg);
  const key = (s) => `${s.open}|${s.closure?.from ?? ''}`;
  const start = Math.floor(ts / STEP) * STEP;
  for (let t = start + dir * STEP; Math.abs(t - start) <= HORIZON; t += dir * STEP) {
    if (key(stateAt(t, cfg)) !== key(now)) return dir < 0 ? t + STEP : t;
  }
  return null;
}

// What the schedule says right now, for Admin settings and the auto-reply
export function hoursStatus(ts = Date.now(), cfg = getHours()) {
  const s = stateAt(ts, cfg);
  return { enabled: cfg.enabled, open: s.open, closure: s.closure, since: edge(ts, cfg, -1), until: edge(ts, cfg, 1), timezone: cfg.timezone };
}

// The after-hours reply to send now, or null when open (or the schedule is off).
// `since` is when this closed stretch began, so the reply goes once per stretch.
export function afterHoursReply(ts = Date.now()) {
  const cfg = getHours();
  if (!cfg.enabled) return null;
  const s = stateAt(ts, cfg);
  if (s.open) return null;
  const body = s.closure?.message || cfg.message;
  if (!body) return null;
  return { body, since: edge(ts, cfg, -1) ?? ts - HORIZON };
}
