// Shared state and helpers for the TextBoss web client

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v; // only ever used with constant icon markup
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const svg = (body, width = 2) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

const ICONS = {
  compose: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
  menu: svg('<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>'),
  back: svg('<path d="m15 18-6-6 6-6"/>'),
  send: svg('<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>', 2.4),
  attach: svg('<path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/>'),
  user: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
  archive: svg('<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/>'),
  canned: svg('<path d="M4 6h16"/><path d="M4 12h10"/><path d="M4 18h7"/><path d="m16 16 2 2 4-4"/>'),
  plus: svg('<path d="M12 5v14"/><path d="M5 12h14"/>'),
  ban: svg('<circle cx="12" cy="12" r="9"/><path d="m5.7 5.7 12.6 12.6"/>'),
  warning: svg('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>'),
  newchat: svg('<path d="M21 11.5a8.5 8.5 0 0 1-12.4 7.6L3 21l1.9-5.6A8.5 8.5 0 1 1 21 11.5Z"/><path d="M12.5 8v7"/><path d="M9 11.5h7"/>', 2.2),
  backup: svg('<ellipse cx="12" cy="5.5" rx="8" ry="3"/><path d="M4 5.5v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/><path d="M4 11.5v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>'),
  eye: svg('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>'),
  emoji: svg('<circle cx="12" cy="12" r="9"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0"/><path d="M9 9.5h.01"/><path d="M15 9.5h.01"/>'),
  download: svg('<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>'),
  pin: svg('<path d="M9 4h6l-1 6 3 3v2H7v-2l3-3Z"/><path d="M12 15v5"/>'),
  flag: svg('<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>'),
};

// A small built-in emoji set (no third-party picker); grouped for browsing
const EMOJI = {
  Smileys: '😀 😃 😄 😁 😊 🙂 😉 😍 🥰 😘 😎 🤗 🤔 😐 😅 😂 🤣 😇 🥳 😴 😢 😭 😮 😬 🙄 😕 🤒 🤕 😷',
  Gestures: '👍 👎 👌 ✌️ 🤞 👏 🙌 🙏 💪 👋 🤝 ✋ 👉 👈 ☝️ 👇 🫶',
  Hearts: '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 💕 💖 💯 ✨ ⭐ 🌟 🎉 🎊 🎈 🎁',
  Health: '🏥 🩺 💊 🩹 🦴 🦵 🦶 🧘 🏃 🚶 🏋️ 🚴 🧊 🔥 ♿',
  Weather: '☀️ 🌤️ ⛅ 🌧️ ⛈️ 🌨️ ❄️ ☃️ 🌬️ 🌪️ 🌈 ☔ 🌡️',
  Objects: '📅 🗓️ ⏰ ⏳ 📞 📱 💬 📧 📍 🚗 🅿️ 🏠 🏢 📝 📋 ✅ ❌ ⚠️ ❗ ❓ ➡️ ⬆️ 🔔 🎄 🎃 🦃 🍀',
};

export function openEmojiPicker(anchor, onPick) {
  document.querySelector('.picker')?.remove();
  const close = () => {
    picker.remove();
    document.removeEventListener('mousedown', outside);
  };
  const outside = (e) => !picker.contains(e.target) && close();
  const picker = h('div', { class: 'picker emoji-picker', role: 'dialog', 'aria-label': 'Emoji' },
    h('div', { class: 'picker-list' },
      Object.entries(EMOJI).map(([group, list]) => [
        h('div', { class: 'emoji-group' }, group),
        h('div', { class: 'emoji-grid' }, list.split(' ').map((e) =>
          h('button', { type: 'button', title: e, onclick: () => onPick(e) }, e))),
      ])),
    h('div', { class: 'picker-manage hint' }, 'Tip: on a Mac press Ctrl+Cmd+Space, on Windows Win+. for every emoji. Emojis make a text use 70 characters per part instead of 160.'));
  document.body.append(picker);
  const r = anchor.getBoundingClientRect();
  picker.style.left = `${Math.max(8, Math.min(r.left, innerWidth - picker.offsetWidth - 8))}px`;
  picker.style.top = `${Math.max(8, r.top - picker.offsetHeight - 6)}px`;
  setTimeout(() => document.addEventListener('mousedown', outside));
}
// On phones, focusing a field pops the keyboard (and used to make iOS zoom in),
// so only move focus automatically on devices with a mouse
export const isTouch = () => matchMedia('(pointer: coarse)').matches;
export function autoFocus(el) {
  if (el && !isTouch()) el.focus({ preventScroll: true });
}

// replaceChildren, skipping null/false like h() does
export function fill(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false));
}

export const icon = (name) => h('span', { html: ICONS[name], style: 'display:contents' });

// ---------- State ----------

export const state = {
  me: null,
  numbers: [],
  mockMode: false,
  names: {}, // phone -> [contact names]
  people: {}, // phone -> [first, last, nickname] of the first contact, for merge fields
  optedOut: new Set(),
  blocked: new Set(),
  canned: [],
  lists: [],
  filterNumber: store('tb.number') || 'all',
  search: '',
  convFilter: '', // '' | 'unread' | 'flagged' | 'archived'
  pushActive: false, // this device gets push notifications from the service worker
  theme: null,
  conversations: [],
  thread: null,
  events: null,
  // Contacts tab
  contactSearch: '',
  contactFilter: '', // '' | 'list:<id>' | 'optedOut' | 'noPhone'
  selected: new Set(),
};

export const els = {};

export function route() {
  const [hash, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const [view, id] = hash.split('/');
  if (view === 'contacts' && id === 'new') return { view: 'contact', id: null, tab: 'contacts', query: new URLSearchParams(query) };
  if (view === 'c' && id) return { view: 'thread', id: Number(id), tab: 'messages' };
  if (view === 'new') return { view: 'new', tab: 'messages' };
  if (view === 'admin') return { view: 'admin', tab: 'messages', section: id || 'bulkvs' };
  if (view === 'canned') return { view: 'canned', tab: 'messages' };
  if (view === 'contacts') {
    if (id === 'new') return { view: 'contact', id: null, tab: 'contacts' };
    if (id) return { view: 'contact', id: Number(id), tab: 'contacts' };
    return { view: 'contacts', tab: 'contacts' };
  }
  if (view === 'bulk') return { view: id ? 'broadcast' : 'bulk', id: id ? Number(id) : null, tab: 'contacts' };
  return { view: 'list', tab: 'messages' };
}

// ---------- Network ----------

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => (onUnauthorized = fn);

export async function api(path, { method = 'GET', body, raw, headers } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: raw ? headers : body ? { 'Content-Type': 'application/json' } : undefined,
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') onUnauthorized();
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { code: data.code, phones: data.phones });
  return data;
}

export async function loadIndex() {
  const idx = await api('/contacts/index').catch(() => null);
  if (!idx) return;
  state.names = idx.names;
  state.people = idx.people ?? {};
  state.optedOut = new Set(idx.optedOut);
  state.blocked = new Set(idx.blocked);
}

export async function loadCanned() {
  state.canned = await api('/canned').catch(() => []);
}

export async function loadLists() {
  state.lists = await api('/lists').catch(() => []);
}

// ---------- Formatting ----------

export function toast(text) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 3500);
}

export function formatPhone(p) {
  const d = String(p ?? '').replace(/\D/g, '');
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 11 && d[0] === '1') return `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  return d;
}

export function nameFor(phone) {
  const names = state.names[phone];
  if (!names?.length) return formatPhone(phone);
  return names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0];
}

export const conversationName = (participants) => participants.map(nameFor).join(', ');
// "(Bobby) Robert Smith" when a nickname is set
export const fullName = (c) => {
  const name = [c.firstName, c.lastName].filter(Boolean).join(' ');
  return (c.nickname ? `(${c.nickname}) ${name}`.trim() : name) || '(no name)';
};

export function numberLabel(numberId) {
  const n = state.numbers.find((x) => x.id === numberId);
  if (!n) return '';
  return n.label ? `${n.label} · ${formatPhone(n.phone)}` : formatPhone(n.phone);
}

export function numberOptions() {
  return state.numbers.map((n) => h('option', { value: String(n.id) }, numberLabel(n.id)));
}

export function avatar(seed, label) {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = Math.imul(hash, 2654435761) >>> 0;
  return h('div', { class: 'avatar', style: `background:hsl(${hue % 360} 55% 46%)` }, label);
}

export function initials(name) {
  const plain = String(name ?? '').replace(/^\([^)]*\)\s*/, ''); // ignore a leading (nickname)
  return plain && !/^[\d(+]/.test(plain) ? plain.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase() : '#';
}

export function conversationAvatar(participants) {
  const label = participants.length > 1 ? String(participants.length) : initials(state.names[participants[0]]?.[0]);
  return avatar(participants.join(','), label);
}

export function relTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const days = (now - d) / 86400000;
  if (days < 6) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : '2-digit' });
}

export function formatDob(dob) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob ?? '');
  return m ? `${m[2]}/${m[3]}/${m[1]}` : dob ?? '';
}

// Rough SMS segment count: GSM-7 is 160/153 per part, anything else is UCS-2 at 70/67.
const GSM = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\[~\]|€]*$/;
export function segments(text) {
  if (!text) return 0;
  const gsm = GSM.test(text);
  const single = gsm ? 160 : 70;
  const multi = gsm ? 153 : 67;
  return text.length <= single ? 1 : Math.ceil(text.length / multi);
}

export function mergeFields(text, contact) {
  const first = contact?.firstName ?? '';
  const last = contact?.lastName ?? '';
  const nick = contact?.nickname || first;
  return text
    .replace(/\{nickname\}/gi, nick)
    .replace(/\{first_name\}/gi, first)
    .replace(/\{last_name\}/gi, last)
    .replace(/\{full_name\}/gi, [first, last].filter(Boolean).join(' '))
    .replace(/ {2,}/g, ' ')
    .replace(/ ([,.!?])/g, '$1');
}

export function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {}
  return null;
}

// ---------- Dialogs and menus ----------

export function dialog(title, fields, submitLabel, onSubmit, { danger = false, wide = false } = {}) {
  const error = h('div', { class: 'form-error' });
  const form = h(
    'form',
    {
      method: 'dialog',
      onsubmit: async (e) => {
        e.preventDefault();
        error.textContent = '';
        try {
          await onSubmit(new FormData(form), form);
          dlg.close();
        } catch (err) {
          error.textContent = err.message;
        }
      },
    },
    h('h2', {}, title),
    fields,
    error,
    h(
      'div',
      { class: 'actions' },
      h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, submitLabel ? 'Cancel' : 'Done'),
      submitLabel && h('button', { class: `btn ${danger ? 'danger-fill' : 'primary'}`, type: 'submit' }, submitLabel),
    ),
  );
  const dlg = h('dialog', { class: wide ? 'wide' : '', onclose: () => dlg.remove() }, form);
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

// Resolves true when confirmed
export function confirmDialog(title, message, confirmLabel, { danger = false } = {}) {
  return new Promise((resolve) => {
    let ok = false;
    const dlg = dialog(title, h('p', { class: 'dialog-text' }, message), confirmLabel, () => {
      ok = true;
    }, { danger });
    dlg.addEventListener('close', () => resolve(ok));
  });
}

// The big warning shown before texting an opted-out number
export function confirmOptOutDialog(phones) {
  return new Promise((resolve) => {
    let ok = false;
    const typed = h('input', { type: 'text', autocomplete: 'off', placeholder: 'Type SEND to confirm' });
    const dlg = dialog(
      'This number opted out',
      [
        h('div', { class: 'optout-warning' },
          icon('warning'),
          h('div', {},
            h('strong', {}, phones.map(nameFor).join(', ')),
            ' asked not to receive texts, by replying STOP or being marked opted out.',
            h('p', {}, 'Texting someone who opted out can break carrier rules and the TCPA, and can get your number blocked. Only continue if they have asked you to text them again, or this is an urgent message they expect.'))),
        h('label', {}, 'To send anyway, type SEND', typed),
      ],
      'Send anyway',
      () => {
        if (typed.value.trim().toUpperCase() !== 'SEND') throw new Error('Type SEND to confirm');
        ok = true;
      },
      { danger: true },
    );
    dlg.addEventListener('close', () => resolve(ok));
    typed.focus();
  });
}

export function openMenu(anchor, items, header) {
  document.querySelector('.menu')?.remove();
  const close = () => {
    menu.remove();
    document.removeEventListener('mousedown', outside);
  };
  const outside = (e) => !menu.contains(e.target) && close();
  const menu = h(
    'div',
    { class: 'menu' },
    header && h('div', { class: 'who' }, header),
    items.filter(Boolean).map(([label, fn, cls]) =>
      h('button', { class: cls ?? '', onclick: () => { close(); fn(); } }, label)),
  );
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const top = r.bottom + 4 + menu.offsetHeight > innerHeight ? Math.max(8, r.top - menu.offsetHeight - 4) : r.bottom + 4;
  menu.style.top = `${top}px`;
  menu.style.left = `${Math.max(8, Math.min(r.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8))}px`;
  setTimeout(() => document.addEventListener('mousedown', outside));
}

export function backButton(to = '#/') {
  return h('button', { class: 'icon-btn back-btn', title: 'Back', onclick: () => (location.hash = to) }, icon('back'));
}

export function paneHead(title, ...extra) {
  return h('div', { class: 'thread-head' }, backButton(route().tab === 'contacts' ? '#/contacts' : '#/'),
    h('div', { class: 'title' }, h('div', { class: 'name' }, title)), ...extra);
}

// ---------- Uploads and the canned response picker ----------

export const ATTACH_ACCEPT = 'image/*,video/mp4,video/3gpp,audio/mpeg,audio/mp4,application/pdf,text/vcard';

export async function uploadFile(f) {
  if (f.size > 5 * 1024 * 1024) throw new Error(`${f.name} is over 5 MB`);
  return api('/upload', { method: 'POST', raw: f, headers: { 'Content-Type': f.type || 'application/octet-stream' } });
}

export function openCannedPicker(anchor, onPick) {
  document.querySelector('.picker')?.remove();
  const close = () => {
    picker.remove();
    document.removeEventListener('mousedown', outside);
  };
  const outside = (e) => !picker.contains(e.target) && close();
  const search = h('input', { type: 'search', placeholder: 'Search canned responses' });
  const list = h('div', { class: 'picker-list' });
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const items = state.canned.filter((c) => !q || c.name.toLowerCase().includes(q) || c.body.toLowerCase().includes(q));
    fill(list, 
      ...(items.length
        ? items.map((c) => h('button', { type: 'button', onclick: () => { close(); onPick(c); } },
            h('div', { class: 'picker-name' }, c.name, c.isAway && h('span', { class: 'tag' }, 'Away'), c.keyword && h('span', { class: 'tag' }, c.keyword)),
            h('div', { class: 'picker-body' }, c.body)))
        : [h('div', { class: 'empty' }, state.canned.length ? 'No matches.' : 'No canned responses yet.')]),
    );
  };
  search.addEventListener('input', draw);
  const picker = h('div', { class: 'picker' }, search, list,
    h('a', { href: '#/canned', class: 'picker-manage', onclick: close }, 'Manage canned responses'));
  document.body.append(picker);
  draw();
  const r = anchor.getBoundingClientRect();
  picker.style.left = `${Math.max(8, Math.min(r.left, innerWidth - picker.offsetWidth - 8))}px`;
  picker.style.top = `${Math.max(8, r.top - picker.offsetHeight - 6)}px`;
  autoFocus(search);
  setTimeout(() => document.addEventListener('mousedown', outside));
}

// Message box with attachments, canned responses, segment counter and send.
// onSend(body, mediaUrls) may throw; the text is kept if it does.
export function buildComposer(onSend, { errorEl, mergeContact, placeholder = 'Text message', sendLabel } = {}) {
  const attachments = []; // { url, type, preview }
  const attachRow = h('div', { class: 'attachments', hidden: true });
  const counter = h('div', { class: 'counter' });
  const text = h('textarea', { rows: 1, placeholder });
  const sendBtn = sendLabel
    ? h('button', { class: 'btn primary', type: 'button', disabled: true }, sendLabel)
    : h('button', { class: 'send-btn', title: 'Send', type: 'button', disabled: true }, icon('send'));
  const file = h('input', { type: 'file', accept: ATTACH_ACCEPT, multiple: true, hidden: true });

  const refresh = () => {
    text.style.height = 'auto';
    text.style.height = `${Math.min(text.scrollHeight, 220)}px`;
    const segs = segments(text.value);
    counter.textContent = attachments.length ? 'MMS' : segs > 1 ? `${text.value.length} chars · ${segs} parts` : '';
    sendBtn.disabled = !text.value.trim() && !attachments.length;
    attachRow.hidden = !attachments.length;
    fill(attachRow, 
      ...attachments.map((a, i) =>
        h('div', { class: 'attachment' },
          a.type.startsWith('image/') ? h('img', { src: a.preview, alt: '' }) : a.type.split('/')[1],
          h('button', { type: 'button', title: 'Remove', onclick: () => { attachments.splice(i, 1); refresh(); } }, '×'))),
    );
  };

  file.addEventListener('change', async () => {
    for (const f of file.files) {
      try {
        const { url, type } = await uploadFile(f);
        attachments.push({ url, type, preview: URL.createObjectURL(f) });
        refresh();
      } catch (err) {
        toast(err.message);
      }
    }
    file.value = '';
  });

  const insertCanned = (c) => {
    const body = typeof mergeContact === 'function' ? mergeFields(c.body, mergeContact()) : c.body;
    text.value = text.value.trim() ? `${text.value.trim()} ${body}` : body;
    for (const url of c.media) {
      const ext = url.split('.').pop();
      attachments.push({ url, type: /jpe?g|png|gif|webp/.test(ext) ? 'image/x' : `file/${ext}`, preview: url });
    }
    refresh();
    text.focus();
  };

  const send = async () => {
    if (sendBtn.disabled) return;
    sendBtn.disabled = true;
    if (errorEl) errorEl.textContent = '';
    try {
      const sent = await onSend(text.value.trim(), attachments.map((a) => a.url));
      if (sent !== false) {
        text.value = '';
        attachments.length = 0;
      }
    } catch (err) {
      if (errorEl) errorEl.textContent = err.message;
      else toast(err.message);
    }
    refresh();
    text.focus();
  };

  text.addEventListener('input', refresh);
  if (!sendLabel) {
    text.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !matchMedia('(pointer: coarse)').matches) {
        e.preventDefault();
        send();
      }
    });
  }
  sendBtn.addEventListener('click', send);

  // Insert at the cursor and keep the picker open for more
  const insertEmoji = (emoji) => {
    const start = text.selectionStart ?? text.value.length;
    const end = text.selectionEnd ?? start;
    text.value = text.value.slice(0, start) + emoji + text.value.slice(end);
    text.selectionStart = text.selectionEnd = start + emoji.length;
    refresh();
    text.focus();
  };

  const cannedBtn = h('button', { class: 'icon-btn', title: 'Canned responses', type: 'button', onclick: (e) => openCannedPicker(e.currentTarget, insertCanned) }, icon('canned'));
  const emojiBtn = h('button', { class: 'icon-btn', title: 'Emoji', type: 'button', onclick: (e) => openEmojiPicker(e.currentTarget, insertEmoji) }, icon('emoji'));
  const el = h('div', { class: `composer${sendLabel ? ' composer-block' : ''}` },
    attachRow,
    h('div', { class: 'composer-row' },
      h('div', { class: 'composer-tools' },
        h('button', { class: 'icon-btn', title: 'Attach', type: 'button', onclick: () => file.click() }, icon('attach')),
        emojiBtn,
        cannedBtn),
      text, sendBtn, file),
    counter,
  );
  el.textarea = text;
  el.sendBtn = sendBtn;
  return el;
}
