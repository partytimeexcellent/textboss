// Textline web client. No build step: plain ES modules and DOM APIs.

// ---------- Helpers ----------

function h(tag, attrs = {}, ...children) {
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

const ICONS = {
  compose: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>',
  attach: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
  archive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/></svg>',
};
const icon = (name) => h('span', { html: ICONS[name], style: 'display:contents' });

async function api(path, { method = 'GET', body, raw, headers } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: raw ? headers : body ? { 'Content-Type': 'application/json' } : undefined,
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') {
    state.me = null;
    render();
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(text) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 3500);
}

function formatPhone(p) {
  const d = String(p).replace(/\D/g, '');
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 11 && d[0] === '1') return `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  return d;
}

const nameFor = (phone) => state.contacts.get(phone) || formatPhone(phone);
const conversationName = (participants) => participants.map(nameFor).join(', ');

function numberLabel(numberId) {
  const n = state.numbers.find((x) => x.id === numberId);
  if (!n) return '';
  return n.label ? `${n.label} · ${formatPhone(n.phone)}` : formatPhone(n.phone);
}

function avatar(participants) {
  const key = participants.join(',');
  let hash = 0;
  for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  let text;
  if (participants.length > 1) text = String(participants.length);
  else {
    const name = state.contacts.get(participants[0]);
    text = name ? name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase() : '#';
  }
  return h('div', { class: 'avatar', style: `background:hsl(${hue} 55% 48%)` }, text);
}

function relTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const days = (now - d) / 86400000;
  if (days < 6) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : '2-digit' });
}

// Rough SMS segment count: GSM-7 is 160/153 per part, anything else is UCS-2 at 70/67.
const GSM = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\[~\]|€]*$/;
function segments(text) {
  if (!text) return 0;
  const gsm = GSM.test(text);
  const single = gsm ? 160 : 70;
  const multi = gsm ? 153 : 67;
  return text.length <= single ? 1 : Math.ceil(text.length / multi);
}

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {}
  return null;
}

// ---------- State ----------

const state = {
  me: null,
  numbers: [],
  mockMode: false,
  contacts: new Map(),
  filterNumber: store('tl.number') || 'all',
  search: '',
  showArchived: false,
  conversations: [],
  thread: null, // { id, numberId, participants, archived, messages, hasMore }
  events: null,
};

function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [view, id] = hash.split('/');
  if (view === 'c' && id) return { view: 'thread', id: Number(id) };
  if (view === 'new') return { view: 'new' };
  if (view === 'admin') return { view: 'admin' };
  return { view: 'list' };
}

// ---------- Boot ----------

const app = document.getElementById('app');

async function boot() {
  try {
    const me = await api('/me');
    state.me = me.user;
    state.numbers = me.numbers;
    state.mockMode = me.mockMode;
  } catch {
    state.me = null;
  }
  render();
}

function render() {
  if (!state.me) {
    state.events?.close();
    state.events = null;
    renderAuth();
    return;
  }
  renderShell();
}

window.addEventListener('hashchange', () => state.me && renderMain());

// ---------- Auth ----------

async function renderAuth() {
  const setup = await api('/setup').catch(() => ({ needed: false }));
  const error = h('div', { class: 'form-error' });
  const fields = setup.needed
    ? [
        h('label', {}, 'Your name', h('input', { type: 'text', name: 'displayName', autocomplete: 'name' })),
        h('label', {}, 'Username', h('input', { type: 'text', name: 'username', required: true, autocomplete: 'username' })),
        h('label', {}, 'Password (8+ characters)', h('input', { type: 'password', name: 'password', required: true, minLength: 8, autocomplete: 'new-password' })),
      ]
    : [
        h('label', {}, 'Username', h('input', { type: 'text', name: 'username', required: true, autocomplete: 'username' })),
        h('label', {}, 'Password', h('input', { type: 'password', name: 'password', required: true, autocomplete: 'current-password' })),
      ];

  const form = h(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        error.textContent = '';
        const data = Object.fromEntries(new FormData(form));
        try {
          await api(setup.needed ? '/setup' : '/login', { method: 'POST', body: data });
          await boot();
        } catch (err) {
          error.textContent = err.message;
        }
      },
    },
    h('h1', {}, h('img', { src: '/icon.svg', alt: '' }), 'Textline'),
    h('p', {}, setup.needed ? 'Create the first admin account.' : 'Sign in to your team inbox.'),
    fields,
    error,
    h('button', { class: 'btn primary', type: 'submit' }, setup.needed ? 'Create account' : 'Sign in'),
  );
  app.replaceChildren(h('div', { class: 'auth' }, form));
  form.querySelector('input').focus();
}

// ---------- Shell ----------

let els = {};

function renderShell() {
  const numberSelect = h(
    'select',
    {
      'aria-label': 'Number',
      onchange: (e) => {
        state.filterNumber = e.target.value;
        store('tl.number', state.filterNumber);
        loadConversations();
      },
    },
    h('option', { value: 'all' }, state.numbers.length ? 'All numbers' : 'No numbers yet'),
    state.numbers.map((n) => h('option', { value: String(n.id) }, n.label ? `${n.label} · ${formatPhone(n.phone)}` : formatPhone(n.phone))),
  );
  if (!state.numbers.some((n) => String(n.id) === state.filterNumber)) state.filterNumber = 'all';
  numberSelect.value = state.filterNumber;

  let searchTimer;
  const search = h('input', {
    type: 'search',
    placeholder: 'Search',
    value: state.search,
    oninput: (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.search = e.target.value;
        loadConversations();
      }, 250);
    },
  });

  const archivedBtn = h('button', {
    class: 'btn',
    title: 'Show archived conversations',
    onclick: () => {
      state.showArchived = !state.showArchived;
      archivedBtn.classList.toggle('primary', state.showArchived);
      loadConversations();
    },
  }, icon('archive'));
  archivedBtn.classList.toggle('primary', state.showArchived);
  archivedBtn.style.padding = '0 9px';

  els.list = h('div', { class: 'conv-list' });
  els.main = h('main', { class: 'thread' });
  els.layout = h(
    'div',
    { class: 'layout' },
    h(
      'aside',
      { class: 'sidebar' },
      h(
        'div',
        { class: 'side-head' },
        h(
          'div',
          { class: 'side-top' },
          numberSelect,
          h('button', { class: 'icon-btn', title: 'New message', onclick: () => (location.hash = '#/new') }, icon('compose')),
          h('button', { class: 'icon-btn', title: 'Menu', onclick: (e) => openUserMenu(e.currentTarget) }, icon('menu')),
        ),
        h('div', { class: 'side-search' }, search, archivedBtn),
      ),
      state.mockMode && h('div', { class: 'mock-banner' }, 'Mock mode: messages are not really sent. Add BulkVS credentials to go live.'),
      els.list,
    ),
    els.main,
  );
  app.replaceChildren(els.layout);

  connectEvents();
  loadContacts().then(loadConversations);
  renderMain();
}

function openUserMenu(anchor) {
  document.querySelector('.menu')?.remove();
  const close = () => {
    menu.remove();
    document.removeEventListener('mousedown', outside);
  };
  const outside = (e) => !menu.contains(e.target) && close();
  const item = (label, fn) => h('button', { onclick: () => { close(); fn(); } }, label);
  const menu = h(
    'div',
    { class: 'menu' },
    h('div', { class: 'who' }, `Signed in as ${state.me.displayName}`),
    state.me.isAdmin && item('Admin settings', () => (location.hash = '#/admin')),
    'Notification' in window && Notification.permission === 'default' &&
      item('Enable notifications', () => Notification.requestPermission()),
    item('Change password', changePasswordDialog),
    item('Sign out', async () => {
      await api('/logout', { method: 'POST' });
      state.me = null;
      location.hash = '';
      render();
    }),
  );
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${r.bottom + 4}px`;
  menu.style.left = `${Math.max(8, Math.min(r.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8))}px`;
  setTimeout(() => document.addEventListener('mousedown', outside));
}

function dialog(title, fields, submitLabel, onSubmit) {
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
      h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cancel'),
      h('button', { class: 'btn primary', type: 'submit' }, submitLabel),
    ),
  );
  const dlg = h('dialog', { onclose: () => dlg.remove() }, form);
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

function changePasswordDialog() {
  dialog(
    'Change password',
    [
      h('label', {}, 'Current password', h('input', { type: 'password', name: 'current', required: true, autocomplete: 'current-password' })),
      h('label', {}, 'New password (8+ characters)', h('input', { type: 'password', name: 'next', required: true, minLength: 8, autocomplete: 'new-password' })),
    ],
    'Save',
    async (data) => {
      await api('/me/password', { method: 'POST', body: Object.fromEntries(data) });
      toast('Password changed');
    },
  );
}

// ---------- Live updates ----------

function connectEvents() {
  if (state.events) return;
  const es = new EventSource('/api/events');
  state.events = es;
  es.addEventListener('message', (e) => onMessageEvent(JSON.parse(e.data)));
  es.addEventListener('read', () => scheduleListReload());
  es.addEventListener('contacts', () => loadContacts().then(() => { renderList(); renderMain(); }));
  es.addEventListener('open', () => scheduleListReload());
}

let listReloadTimer;
function scheduleListReload() {
  clearTimeout(listReloadTimer);
  listReloadTimer = setTimeout(loadConversations, 150);
}

function onMessageEvent(msg) {
  scheduleListReload();
  const t = state.thread;
  if (t && t.id === msg.conversationId) {
    const i = t.messages.findIndex((m) => m.id === msg.id);
    if (i >= 0) t.messages[i] = msg;
    else t.messages.push(msg);
    renderMessages();
    if (msg.direction === 'in' && document.visibilityState === 'visible') markRead(t.id);
  }
  if (msg.direction === 'in' && msg.status === 'received' && (document.visibilityState !== 'visible' || t?.id !== msg.conversationId)) {
    notify(msg);
  }
}

function notify(msg) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const n = new Notification(nameFor(msg.from), {
    body: msg.body || (msg.media.length ? 'Attachment' : ''),
    tag: `conv-${msg.conversationId}`,
    icon: '/icon.svg',
  });
  n.onclick = () => {
    window.focus();
    location.hash = `#/c/${msg.conversationId}`;
    n.close();
  };
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.thread) markRead(state.thread.id);
});

// ---------- Conversation list ----------

async function loadContacts() {
  const rows = await api('/contacts').catch(() => []);
  state.contacts = new Map(rows.map((c) => [c.phone, c.name]));
}

async function loadConversations() {
  const params = new URLSearchParams();
  if (state.filterNumber !== 'all') params.set('numberId', state.filterNumber);
  if (state.search) params.set('q', state.search);
  if (state.showArchived) params.set('archived', '1');
  try {
    state.conversations = await api(`/conversations?${params}`);
  } catch {
    return;
  }
  renderList();
}

function renderList() {
  if (!els.list) return;
  const r = route();
  const unreadTotal = state.conversations.reduce((s, c) => s + c.unread, 0);
  document.title = unreadTotal ? `(${unreadTotal}) Textline` : 'Textline';

  if (!state.conversations.length) {
    els.list.replaceChildren(
      h('div', { class: 'empty' },
        !state.numbers.length
          ? state.me.isAdmin ? 'Add a phone number in Admin settings to get started.' : 'No numbers are assigned to you yet. Ask an admin.'
          : state.search ? 'No matches.' : state.showArchived ? 'No archived conversations.' : 'No conversations yet.'),
    );
    return;
  }

  const multi = state.numbers.length > 1 && state.filterNumber === 'all';
  els.list.replaceChildren(
    ...state.conversations.map((c) => {
      let preview = c.last ? (c.last.body || (c.last.hasMedia ? 'Attachment' : '')) : 'No messages yet';
      if (c.last?.direction === 'out') preview = `You: ${preview}`;
      if (c.last?.status === 'failed') preview = `Failed · ${preview}`;
      return h(
        'a',
        {
          class: `conv${r.view === 'thread' && r.id === c.id ? ' active' : ''}${c.unread ? ' unread' : ''}`,
          href: `#/c/${c.id}`,
        },
        avatar(c.participants),
        h('div', { class: 'main' },
          h('div', { class: 'name' }, conversationName(c.participants)),
          h('div', { class: 'preview' }, preview),
          multi && h('div', { class: 'via' }, `via ${numberLabel(c.numberId)}`),
        ),
        h('div', { class: 'meta' }, relTime(c.lastMessageAt), c.unread ? h('span', { class: 'badge' }, c.unread) : null),
      );
    }),
  );
}

// ---------- Main pane ----------

function renderMain() {
  const r = route();
  els.layout.classList.toggle('has-thread', r.view !== 'list');
  renderList();
  if (r.view === 'thread') return openThread(r.id);
  state.thread = null;
  if (r.view === 'new') return renderNewMessage();
  if (r.view === 'admin' && state.me.isAdmin) return renderAdmin();
  els.main.replaceChildren(h('div', { class: 'placeholder' }, 'Select a conversation or start a new one.'));
}

function backButton() {
  return h('button', { class: 'icon-btn back-btn', title: 'Back', onclick: () => (location.hash = '#/') }, icon('back'));
}

// ----- New message -----

function renderNewMessage() {
  if (!state.numbers.length) {
    els.main.replaceChildren(h('div', { class: 'placeholder' }, 'There are no numbers you can send from yet.'));
    return;
  }
  const recipients = [];
  const fromSelect = h('select', { name: 'from' },
    state.numbers.map((n) => h('option', { value: String(n.id) }, n.label ? `${n.label} · ${formatPhone(n.phone)}` : formatPhone(n.phone))));
  if (state.filterNumber !== 'all') fromSelect.value = state.filterNumber;

  const chips = h('div', { class: 'chips' });
  const suggest = h('div', { class: 'suggest', hidden: true });
  const input = h('input', { type: 'text', placeholder: 'Name or phone number', autocomplete: 'off' });
  const error = h('div', { class: 'form-error' });

  const addRecipient = (phone) => {
    const d = phone.replace(/\D/g, '').replace(/^1(\d{10})$/, '$1');
    if (!/^\d{10}$/.test(d) && !/^\d{5,6}$/.test(d)) {
      error.textContent = `"${phone}" is not a valid phone number`;
      return;
    }
    if (!recipients.includes(d)) recipients.push(d);
    input.value = '';
    error.textContent = '';
    suggest.hidden = true;
    drawChips();
  };
  const drawChips = () => {
    chips.replaceChildren(
      ...recipients.map((p, i) =>
        h('span', { class: 'chip' }, nameFor(p), h('button', { type: 'button', title: 'Remove', onclick: () => { recipients.splice(i, 1); drawChips(); } }, '×'))),
      input,
    );
    input.focus();
  };
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    const digits = q.replace(/\D/g, '');
    const matches = q
      ? [...state.contacts].filter(([p, n]) => n.toLowerCase().includes(q) || (digits && p.includes(digits))).slice(0, 6)
      : [];
    suggest.replaceChildren(...matches.map(([p, n]) => h('button', { type: 'button', onclick: () => addRecipient(p) }, `${n} · ${formatPhone(p)}`)));
    suggest.hidden = !matches.length;
  });
  input.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ',') && input.value.trim()) {
      e.preventDefault();
      addRecipient(input.value.trim());
    } else if (e.key === 'Backspace' && !input.value && recipients.length) {
      recipients.pop();
      drawChips();
    }
  });
  drawChips();

  const composer = buildComposer(async (body, media) => {
    if (input.value.trim()) addRecipient(input.value.trim());
    if (!recipients.length) throw new Error('Add at least one recipient');
    const { id } = await api('/conversations', { method: 'POST', body: { numberId: Number(fromSelect.value), to: recipients } });
    await api(`/conversations/${id}/messages`, { method: 'POST', body: { body, media } });
    location.hash = `#/c/${id}`;
  }, error);

  els.main.replaceChildren(
    h('div', { class: 'thread-head' }, backButton(), h('div', { class: 'title' }, h('div', { class: 'name' }, 'New message'))),
    h('div', { class: 'new-msg' },
      state.numbers.length > 1 && h('label', {}, 'From', fromSelect),
      h('label', {}, 'To', chips),
      suggest,
      error,
    ),
    h('div', { class: 'placeholder' }, ''),
    composer,
  );
  input.focus();
}

// ----- Composer (shared by new message and thread) -----

function buildComposer(onSend, errorEl) {
  const attachments = []; // { url, type, preview }
  const attachRow = h('div', { class: 'attachments', hidden: true });
  const counter = h('div', { class: 'counter' });
  const text = h('textarea', { rows: 1, placeholder: 'Text message' });
  const sendBtn = h('button', { class: 'send-btn', title: 'Send', disabled: true }, icon('send'));
  const file = h('input', { type: 'file', accept: 'image/*,video/mp4,video/3gpp,audio/mpeg,audio/mp4,application/pdf,text/vcard', multiple: true, hidden: true });

  const refresh = () => {
    text.style.height = 'auto';
    text.style.height = `${Math.min(text.scrollHeight, 160)}px`;
    const segs = segments(text.value);
    counter.textContent = attachments.length ? 'MMS' : segs > 1 ? `${text.value.length} chars · ${segs} parts` : '';
    sendBtn.disabled = !text.value.trim() && !attachments.length;
    attachRow.hidden = !attachments.length;
    attachRow.replaceChildren(
      ...attachments.map((a, i) =>
        h('div', { class: 'attachment' },
          a.type.startsWith('image/') ? h('img', { src: a.preview, alt: '' }) : a.type.split('/')[1],
          h('button', { type: 'button', title: 'Remove', onclick: () => { attachments.splice(i, 1); refresh(); } }, '×'))),
    );
  };

  file.addEventListener('change', async () => {
    for (const f of file.files) {
      if (f.size > 5 * 1024 * 1024) {
        toast(`${f.name} is over 5 MB`);
        continue;
      }
      try {
        const { url, type } = await api('/upload', { method: 'POST', raw: f, headers: { 'Content-Type': f.type || 'application/octet-stream' } });
        attachments.push({ url, type, preview: URL.createObjectURL(f) });
        refresh();
      } catch (err) {
        toast(err.message);
      }
    }
    file.value = '';
  });

  const send = async () => {
    if (sendBtn.disabled) return;
    sendBtn.disabled = true;
    if (errorEl) errorEl.textContent = '';
    try {
      await onSend(text.value.trim(), attachments.map((a) => a.url));
      text.value = '';
      attachments.length = 0;
    } catch (err) {
      if (errorEl) errorEl.textContent = err.message;
      else toast(err.message);
    }
    refresh();
    text.focus();
  };

  text.addEventListener('input', refresh);
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !matchMedia('(pointer: coarse)').matches) {
      e.preventDefault();
      send();
    }
  });
  sendBtn.addEventListener('click', send);

  return h('div', { class: 'composer' },
    attachRow,
    h('div', { class: 'composer-row' },
      h('button', { class: 'icon-btn', title: 'Attach', type: 'button', onclick: () => file.click() }, icon('attach')),
      text, sendBtn, file),
    counter,
  );
}

// ----- Thread -----

async function openThread(id) {
  if (state.thread?.id !== id) {
    els.main.replaceChildren(h('div', { class: 'placeholder' }, 'Loading…'));
    try {
      const [conv, messages] = await Promise.all([api(`/conversations/${id}`), api(`/conversations/${id}/messages`)]);
      if (route().id !== id) return;
      state.thread = { ...conv, messages, hasMore: messages.length >= 50 };
    } catch (err) {
      els.main.replaceChildren(h('div', { class: 'placeholder' }, err.message));
      return;
    }
  }
  const t = state.thread;

  els.messages = h('div', { class: 'messages' });
  els.messages.addEventListener('scroll', () => {
    if (els.messages.scrollTop < 80) loadOlder();
  });

  const others = t.participants;
  els.main.replaceChildren(
    h('div', { class: 'thread-head' },
      backButton(),
      avatar(others),
      h('div', { class: 'title' },
        h('div', { class: 'name' }, conversationName(others)),
        h('div', { class: 'sub' },
          others.length === 1 && state.contacts.has(others[0]) ? `${formatPhone(others[0])} · ` : '',
          `via ${numberLabel(t.numberId)}`)),
      h('button', { class: 'icon-btn', title: 'Edit contact names', onclick: () => editContactsDialog(others) }, icon('user')),
      h('button', {
        class: 'icon-btn',
        title: t.archived ? 'Unarchive' : 'Archive',
        onclick: async () => {
          await api(`/conversations/${t.id}/archive`, { method: 'POST', body: { archived: !t.archived } });
          toast(t.archived ? 'Moved back to inbox' : 'Archived');
          state.thread = null;
          location.hash = '#/';
          loadConversations();
        },
      }, icon('archive')),
    ),
    els.messages,
    buildComposer(async (body, media) => {
      const msg = await api(`/conversations/${t.id}/messages`, { method: 'POST', body: { body, media } });
      if (!t.messages.some((m) => m.id === msg.id)) t.messages.push(msg);
      renderMessages(true);
    }),
  );
  renderMessages(true);
  markRead(t.id);
  els.main.querySelector('textarea').focus({ preventScroll: true });
}

async function loadOlder() {
  const t = state.thread;
  if (!t?.hasMore || t.loading || !t.messages.length) return;
  t.loading = true;
  const older = await api(`/conversations/${t.id}/messages?before=${t.messages[0].id}`).catch(() => []);
  t.loading = false;
  t.hasMore = older.length >= 50;
  if (!older.length) return;
  const prevHeight = els.messages.scrollHeight;
  t.messages.unshift(...older);
  renderMessages();
  els.messages.scrollTop = els.messages.scrollHeight - prevHeight;
}

function renderMessages(forceBottom = false) {
  const t = state.thread;
  const box = els.messages;
  if (!t || !box?.isConnected) return;
  const atBottom = forceBottom || box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const prevTop = box.scrollTop;
  const group = t.participants.length > 1;

  const nodes = [];
  let lastDay = '';
  let prev = null;
  for (const m of t.messages) {
    const day = new Date(m.createdAt).toDateString();
    if (day !== lastDay) {
      nodes.push(h('div', { class: 'day' }, new Date(m.createdAt).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })));
      lastDay = day;
      prev = null;
    }
    const gap = prev && (prev.direction !== m.direction || prev.from !== m.from || m.createdAt - prev.createdAt > 5 * 60_000);

    const media = m.media.map((url) => {
      const ext = url.split('?')[0].split('.').pop().toLowerCase();
      if (['mp4', '3gp', 'mov'].includes(ext)) return h('video', { src: url, controls: true, preload: 'metadata' });
      if (['mp3', 'm4a', 'amr', 'wav'].includes(ext)) return h('audio', { src: url, controls: true });
      if (['pdf', 'vcf', 'txt'].includes(ext)) return h('a', { class: 'file', href: url, target: '_blank', rel: 'noopener' }, `📎 ${ext.toUpperCase()} file`);
      return h('a', { href: url, target: '_blank', rel: 'noopener' }, h('img', { src: url, alt: 'Attachment', loading: 'lazy' }));
    });

    const status = m.direction === 'out'
      ? { sending: 'Sending…', sent: 'Sent', delivered: 'Delivered', failed: 'Failed' }[m.status] ?? m.status
      : '';
    const showInfo = m.direction === 'out' && (m === t.messages.at(-1) || m.status === 'failed' || m.status === 'sending');

    nodes.push(
      h('div', { class: `msg ${m.direction}${gap ? ' gap' : ''}${m.status === 'failed' ? ' failed' : ''}`, title: new Date(m.createdAt).toLocaleString() },
        group && m.direction === 'in' && (!prev || prev.from !== m.from || prev.direction !== 'in') && h('div', { class: 'sender' }, nameFor(m.from)),
        media.length > 0 && h('div', { class: 'media' }, media),
        m.body && h('div', { class: 'bubble' }, linkify(m.body)),
        showInfo && h('div', { class: 'info' },
          m.sentBy ? `${m.sentBy} · ` : '',
          new Date(m.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
          ' · ',
          m.status === 'failed' ? h('span', { class: 'err' }, `Failed${m.error ? `: ${m.error}` : ''}`) : status),
      ),
    );
    prev = m;
  }
  if (!nodes.length) nodes.push(h('div', { class: 'placeholder' }, 'No messages yet. Say hello.'));
  box.replaceChildren(...nodes);
  box.scrollTop = atBottom ? box.scrollHeight : prevTop;
}

function linkify(text) {
  const parts = [];
  const re = /\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    parts.push(text.slice(last, m.index), h('a', { href: m[0], target: '_blank', rel: 'noopener noreferrer' }, m[0]));
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return parts;
}

let readTimer;
function markRead(id) {
  clearTimeout(readTimer);
  readTimer = setTimeout(() => api(`/conversations/${id}/read`, { method: 'POST' }).catch(() => {}), 300);
}

function editContactsDialog(phones) {
  dialog(
    phones.length > 1 ? 'Contact names' : 'Contact name',
    phones.map((p) => h('label', {}, formatPhone(p), h('input', { type: 'text', name: p, value: state.contacts.get(p) ?? '', placeholder: 'Name' }))),
    'Save',
    async (data) => {
      for (const p of phones) {
        const name = String(data.get(p) ?? '').trim();
        if (name !== (state.contacts.get(p) ?? '')) await api(`/contacts/${p}`, { method: 'PUT', body: { name } });
      }
      await loadContacts();
      renderList();
      renderMain();
    },
  );
}

// ---------- Admin ----------

async function renderAdmin() {
  const pane = h('div', { class: 'admin' });
  els.main.replaceChildren(
    h('div', { class: 'thread-head' }, backButton(), h('div', { class: 'title' }, h('div', { class: 'name' }, 'Admin settings'))),
    pane,
  );

  let numbers, users, webhook;
  try {
    [numbers, users, webhook] = await Promise.all([api('/admin/numbers'), api('/admin/users'), api('/admin/webhook-log')]);
  } catch (err) {
    pane.replaceChildren(h('p', { class: 'hint' }, err.message));
    return;
  }
  const refresh = async () => {
    const me = await api('/me');
    state.numbers = me.numbers;
    renderShell();
    location.hash = '#/admin';
  };

  // Numbers
  const phoneInput = h('input', { type: 'tel', placeholder: 'BulkVS number, e.g. 3105551212' });
  const labelInput = h('input', { type: 'text', placeholder: 'Label, e.g. Sales' });
  const numbersSection = h('section', {},
    h('h2', {}, 'Phone numbers'),
    h('p', { class: 'hint' }, 'Numbers from your BulkVS account that this app sends and receives on. Each must have SMS/MMS enabled and point at the webhook below in the BulkVS portal.'),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Number'), h('th', {}, 'Label'), h('th', {}))),
      h('tbody', {}, numbers.length ? numbers.map((n) => {
        const label = h('input', { type: 'text', value: n.label });
        return h('tr', {},
          h('td', {}, formatPhone(n.phone)),
          h('td', {}, label),
          h('td', {}, h('div', { class: 'row-actions' },
            h('button', { class: 'btn', onclick: async () => { await api(`/admin/numbers/${n.id}`, { method: 'PATCH', body: { label: label.value } }); toast('Saved'); refresh(); } }, 'Save'),
            h('button', { class: 'btn danger', onclick: async () => {
              if (!confirm(`Remove ${formatPhone(n.phone)}? Its conversations and messages will be deleted from this app.`)) return;
              await api(`/admin/numbers/${n.id}`, { method: 'DELETE' });
              refresh();
            } }, 'Remove'))));
      }) : h('tr', {}, h('td', { colspan: 3, class: 'hint' }, 'No numbers yet.'))),
    )),
    h('div', { class: 'add-row' }, phoneInput, labelInput,
      h('button', { class: 'btn primary', onclick: async () => {
        try {
          await api('/admin/numbers', { method: 'POST', body: { phone: phoneInput.value, label: labelInput.value } });
          toast('Number added');
          refresh();
        } catch (err) { toast(err.message); }
      } }, 'Add number')),
  );

  // Users
  const numberChecks = (selected = []) =>
    h('div', { class: 'checks' }, numbers.length
      ? numbers.map((n) => h('label', {}, h('input', { type: 'checkbox', name: 'numberIds', value: String(n.id), checked: selected.includes(n.id) }), n.label ? `${n.label} · ${formatPhone(n.phone)}` : formatPhone(n.phone)))
      : h('span', { class: 'hint' }, 'Add numbers first.'));

  const userDialog = (u) => dialog(
    u ? `Edit ${u.displayName}` : 'Add user',
    [
      !u && h('label', {}, 'Username', h('input', { type: 'text', name: 'username', required: true, autocomplete: 'off' })),
      h('label', {}, 'Display name', h('input', { type: 'text', name: 'displayName', value: u?.displayName ?? '' })),
      h('label', {}, u ? 'New password (leave blank to keep)' : 'Password (8+ characters)', h('input', { type: 'password', name: 'password', required: !u, minLength: 8, autocomplete: 'new-password' })),
      h('label', { style: 'display:flex;gap:8px;align-items:center;color:var(--text)' }, h('input', { type: 'checkbox', name: 'isAdmin', checked: !!u?.isAdmin }), 'Admin (can see every number and manage settings)'),
      h('label', {}, 'Numbers this user can use', numberChecks(u?.numberIds)),
    ],
    u ? 'Save' : 'Add user',
    async (data) => {
      const body = {
        displayName: data.get('displayName'),
        isAdmin: data.get('isAdmin') === 'on',
        numberIds: data.getAll('numberIds').map(Number),
      };
      if (data.get('password')) body.password = data.get('password');
      if (u) await api(`/admin/users/${u.id}`, { method: 'PATCH', body });
      else await api('/admin/users', { method: 'POST', body: { ...body, username: data.get('username') } });
      toast(u ? 'User updated' : 'User added');
      refresh();
    },
  );

  const usersSection = h('section', {},
    h('h2', {}, 'Users'),
    h('p', { class: 'hint' }, 'Each user sees only the numbers assigned to them. Admins see every number.'),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Username'), h('th', {}, 'Access'), h('th', {}))),
      h('tbody', {}, users.map((u) => h('tr', {},
        h('td', {}, u.displayName),
        h('td', {}, u.username),
        h('td', {}, u.isAdmin ? 'Admin · all numbers' : u.numberIds.length ? u.numberIds.map(numberLabel).join(', ') || `${u.numberIds.length} number(s)` : 'No numbers'),
        h('td', {}, h('div', { class: 'row-actions' },
          h('button', { class: 'btn', onclick: () => userDialog(u) }, 'Edit'),
          u.id !== state.me.id && h('button', { class: 'btn danger', onclick: async () => {
            if (!confirm(`Delete ${u.displayName}?`)) return;
            await api(`/admin/users/${u.id}`, { method: 'DELETE' });
            refresh();
          } }, 'Delete')))))),
    )),
    h('div', {}, h('button', { class: 'btn primary', onclick: () => userDialog(null) }, 'Add user')),
  );

  // Webhook
  const simFrom = h('input', { type: 'tel', placeholder: 'From, e.g. 3125550000' });
  const simTo = h('select', {}, numbers.map((n) => h('option', { value: n.phone }, formatPhone(n.phone))));
  const simText = h('input', { type: 'text', placeholder: 'Message text' });

  const webhookSection = h('section', {},
    h('h2', {}, 'Inbound webhook'),
    webhook.url
      ? [
          h('p', { class: 'hint' }, 'In the BulkVS portal, open Messaging → Messaging Webhooks and add a webhook with this as the Message URL. Then, under Inbound → DIDs – Manage, open each number above, enable SMS and MMS, and set its Messaging Webhook to the one you created.'),
          h('div', { class: 'copy-line' }, h('code', {}, webhook.url),
            h('button', { class: 'btn', onclick: () => navigator.clipboard.writeText(webhook.url).then(() => toast('Copied')) }, 'Copy')),
        ]
      : h('p', { class: 'hint bad' }, 'WEBHOOK_SECRET is not set on the server, so inbound messages are turned off. Set it in .env and restart.'),
    h('p', { class: 'hint' }, 'Test the inbound path without a real text. This goes through the same parser as the webhook:'),
    h('div', { class: 'add-row' }, simFrom, numbers.length > 0 && simTo, simText,
      h('button', { class: 'btn', disabled: !numbers.length, onclick: async () => {
        try {
          await api('/admin/simulate-inbound', { method: 'POST', body: { From: simFrom.value, To: [simTo.value], Message: simText.value } });
          toast('Simulated message received');
          simText.value = '';
        } catch (err) { toast(err.message); }
      } }, 'Simulate')),
    h('h2', { style: 'font-size:15px;margin-top:8px' }, 'Recent webhook calls'),
    webhook.entries.length
      ? webhook.entries.map((e) => {
          const result = JSON.parse(e.result ?? '{}');
          return h('div', { class: 'log-entry' },
            h('div', { class: 'meta' }, new Date(e.received_at).toLocaleString(),
              h('span', { class: result.ok ? 'ok' : 'bad' }, result.ok ? 'applied' : `not applied: ${result.reason}`)),
            h('pre', {}, e.body));
        })
      : h('p', { class: 'hint' }, 'Nothing received yet.'),
  );

  pane.replaceChildren(numbersSection, usersSection, webhookSection);
}

boot();
