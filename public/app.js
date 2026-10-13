// TextBoss web client. No build step: plain ES modules and DOM APIs.

import {
  h, fill, icon, state, els, route, api, setUnauthorizedHandler, loadIndex, loadCanned, loadLists,
  toast, formatPhone, fullName, nameFor, conversationName, numberLabel, numberOptions, conversationAvatar,
  relTime, store, dialog, confirmDialog, confirmOptOutDialog, openMenu, backButton, buildComposer,
} from './js/core.js';
import { renderContactsSidebar, renderContactsMain, refreshContacts, onBroadcastEvent } from './js/contacts.js';
import { renderCanned } from './js/canned.js';
import { renderAdmin } from './js/admin.js';
import { applyTheme, themePicker } from './js/theme.js';

const app = document.getElementById('app');

setUnauthorizedHandler(() => {
  state.me = null;
  render();
});

async function boot() {
  try {
    const me = await api('/me');
    state.me = me.user;
    state.numbers = me.numbers;
    state.mockMode = me.mockMode;
    state.theme = applyTheme(me.theme);
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

window.addEventListener('hashchange', () => state.me && renderRoute());

// Press N anywhere (outside a text field or dialog) to start a new message
document.addEventListener('keydown', (e) => {
  if (!state.me || e.key.toLowerCase() !== 'n' || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable]') || document.querySelector('dialog[open]')) return;
  e.preventDefault();
  location.hash = '#/new';
});

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
        try {
          await api(setup.needed ? '/setup' : '/login', { method: 'POST', body: Object.fromEntries(new FormData(form)) });
          await boot();
        } catch (err) {
          error.textContent = err.message;
        }
      },
    },
    h('h1', {}, h('img', { src: '/icon.svg', alt: '' }), 'TextBoss'),
    h('p', {}, setup.needed ? 'Create the first admin account.' : 'Sign in to your team inbox.'),
    fields,
    error,
    h('button', { class: 'btn primary', type: 'submit' }, setup.needed ? 'Create account' : 'Sign in'),
  );
  fill(app, h('div', { class: 'auth' }, form));
  form.querySelector('input').focus();
}

// ---------- Shell ----------

function renderShell() {
  els.sideBody = h('div', { class: 'side-body' });
  els.main = h('main', { class: 'thread' });
  els.tabs = h('div', { class: 'tabs', role: 'tablist' },
    h('a', { href: '#/', role: 'tab', 'data-tab': 'messages' }, 'Messages', h('span', { class: 'badge', hidden: true })),
    h('a', { href: '#/contacts', role: 'tab', 'data-tab': 'contacts' }, 'Contacts'));

  els.layout = h(
    'div',
    { class: 'layout' },
    h(
      'aside',
      { class: 'sidebar' },
      h('div', { class: 'side-top' },
        h('img', { class: 'logo', src: '/icon.svg', alt: '' }),
        h('div', { class: 'brand' }, h('span', { class: 'brand-1' }, 'Text'), h('span', { class: 'brand-2' }, 'Boss')),
        h('button', { class: 'new-btn', title: 'New message (N)', onclick: () => (location.hash = '#/new') }, icon('newchat'), h('span', {}, 'New')),
        h('button', { class: 'icon-btn', title: 'Menu', onclick: (e) => openUserMenu(e.currentTarget) }, icon('menu'))),
      els.tabs,
      state.mockMode && h('div', { class: 'mock-banner' }, 'Mock mode: messages are not really sent.'),
      els.sideBody,
    ),
    els.main,
  );
  fill(app, els.layout);
  els.sidebarTab = null;

  connectEvents();
  Promise.all([loadIndex(), loadCanned(), loadLists()]).then(() => {
    loadConversations();
    els.sidebarTab = null; // redraw the sidebar now that names and lists are loaded
    renderRoute();
  });
  renderRoute();
}

function renderSidebar(tab) {
  if (els.sidebarTab === tab) return;
  els.sidebarTab = tab;
  for (const a of els.tabs.children) a.classList.toggle('active', a.dataset.tab === tab);
  if (tab === 'contacts') renderContactsSidebar();
  else renderMessagesSidebar();
}

function renderRoute() {
  const r = route();
  renderSidebar(r.tab);
  els.layout.classList.toggle('has-thread', !['list', 'contacts'].includes(r.view));
  if (r.tab === 'messages') renderList();
  if (r.view !== 'thread') state.thread = null;

  switch (r.view) {
    case 'thread': return openThread(r.id);
    case 'new': return renderNewMessage();
    case 'admin': return state.me.isAdmin ? renderAdmin() : placeholder('Admins only.');
    case 'canned': return renderCanned();
    case 'contacts':
    case 'contact':
    case 'bulk':
    case 'broadcast':
      return renderContactsMain(r);
    default:
      return placeholder('Select a conversation or start a new one.');
  }
}

function placeholder(text) {
  fill(els.main, h('div', { class: 'placeholder' }, text));
}

function openUserMenu(anchor) {
  openMenu(anchor, [
    ['Canned responses', () => (location.hash = '#/canned')],
    ['Appearance', () => themePicker(state.theme, (t) => (state.theme = t))],
    state.me.isAdmin && ['Admin settings', () => (location.hash = '#/admin')],
    'Notification' in window && Notification.permission === 'default' &&
      ['Enable notifications', () => Notification.requestPermission()],
    ['Change password', changePasswordDialog],
    ['Sign out', async () => {
      await api('/logout', { method: 'POST' });
      state.me = null;
      location.hash = '';
      render();
    }],
  ], `Signed in as ${state.me.displayName}`);
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
  es.addEventListener('contacts', async () => {
    await Promise.all([loadIndex(), loadLists()]);
    renderList();
    if (state.thread) renderThreadChrome();
    if (route().tab === 'contacts') refreshContacts();
  });
  es.addEventListener('canned', () => loadCanned());
  es.addEventListener('numbers', async () => {
    const me = await api('/me').catch(() => null);
    if (!me) return;
    state.numbers = me.numbers;
    els.sidebarTab = null; // redraw the number selector
    renderRoute();
    loadConversations();
  });
  es.addEventListener('broadcast', (e) => onBroadcastEvent(JSON.parse(e.data)));
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

// ---------- Messages sidebar ----------

function renderMessagesSidebar() {
  const numberSelect = h(
    'select',
    {
      'aria-label': 'Number',
      onchange: (e) => {
        state.filterNumber = e.target.value;
        store('tb.number', state.filterNumber);
        loadConversations();
      },
    },
    h('option', { value: 'all' }, state.numbers.length ? 'All numbers' : 'No numbers yet'),
    numberOptions(),
  );
  if (!state.numbers.some((n) => String(n.id) === state.filterNumber)) state.filterNumber = 'all';
  numberSelect.value = state.filterNumber;

  let searchTimer;
  const search = h('input', {
    type: 'search',
    placeholder: 'Search messages, names, patient ID',
    value: state.search,
    oninput: (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.search = e.target.value;
        loadConversations();
      }, 250);
    },
  });

  // All / Unread / Flagged / Archived
  const filters = h('div', { class: 'filter-chips', role: 'tablist', 'aria-label': 'Show' });
  const drawFilters = () => fill(filters, [['', 'All'], ['unread', 'Unread'], ['flagged', 'Flagged'], ['archived', 'Archived']].map(([v, label]) =>
    h('button', {
      type: 'button',
      role: 'tab',
      'aria-selected': String(state.convFilter === v),
      class: state.convFilter === v ? 'on' : '',
      onclick: () => {
        state.convFilter = v;
        drawFilters();
        loadConversations();
      },
    }, label)));
  drawFilters();

  els.list = h('div', { class: 'conv-list' });
  fill(els.sideBody,
    h('div', { class: 'side-head' },
      state.numbers.length > 1 && numberSelect,
      search,
      filters),
    els.list,
  );
  renderList();
}

async function loadConversations() {
  const params = new URLSearchParams();
  if (state.filterNumber !== 'all') params.set('numberId', state.filterNumber);
  if (state.search) params.set('q', state.search);
  if (state.convFilter) params.set('filter', state.convFilter);
  try {
    state.conversations = await api(`/conversations?${params}`);
  } catch {
    return;
  }
  renderList();
}

function renderList() {
  const unreadTotal = state.conversations.reduce((s, c) => s + c.unread, 0);
  document.title = unreadTotal ? `(${unreadTotal}) TextBoss` : 'TextBoss';
  const badge = els.tabs?.querySelector('.badge');
  if (badge) {
    badge.hidden = !unreadTotal;
    badge.textContent = unreadTotal;
  }
  if (!els.list?.isConnected) return;
  const r = route();

  if (!state.conversations.length) {
    fill(els.list, 
      h('div', { class: 'empty' },
        !state.numbers.length
          ? state.me.isAdmin ? 'Add a phone number in Admin settings to get started.' : 'No numbers are assigned to you yet. Ask an admin.'
          : state.search ? 'No matches.'
          : { unread: 'Nothing unread.', flagged: 'No flagged conversations. Flag one from its ⋮ menu.', archived: 'No archived conversations.' }[state.convFilter]
            ?? 'No conversations yet.'),
    );
    return;
  }

  const multi = state.numbers.length > 1 && state.filterNumber === 'all';
  fill(els.list, 
    ...state.conversations.map((c) => {
      let preview = c.last ? (c.last.body || (c.last.hasMedia ? 'Attachment' : '')) : 'No messages yet';
      if (c.last?.direction === 'out') preview = `You: ${preview}`;
      if (c.last?.status === 'failed') preview = `Failed · ${preview}`;
      const optedOut = c.participants.some((p) => state.optedOut.has(p));
      // The row is a div so the pin/flag buttons aren't nested inside the link
      return h(
        'div',
        {
          class: `conv${r.view === 'thread' && r.id === c.id ? ' active' : ''}${c.unread ? ' unread' : ''}${c.flagged ? ' flagged' : ''}`,
          onclick: (e) => !e.target.closest('a, button') && (location.hash = `#/c/${c.id}`),
        },
        h('a', { class: 'conv-link', href: `#/c/${c.id}` },
          conversationAvatar(c.participants),
          h('div', { class: 'main' },
            h('div', { class: 'name' }, conversationName(c.participants), optedOut && h('span', { class: 'tag warn' }, 'Opted out')),
            h('div', { class: 'preview' }, preview),
            multi && h('div', { class: 'via' }, `via ${numberLabel(c.numberId)}`),
          )),
        h('div', { class: 'meta' },
          h('span', { class: 'meta-time' }, relTime(c.lastMessageAt)),
          h('div', { class: 'meta-bottom' },
            quickToggle(c, 'pinned'),
            quickToggle(c, 'flagged'),
            c.unread ? h('span', { class: 'badge' }, c.unread) : null)),
      );
    }),
  );
}

// ----- Pin / flag toggles (list rows and thread header) -----

const TOGGLES = {
  pinned: { path: 'pin', icon: 'pin', on: 'Unpin', off: 'Pin to top', done: ['Pinned to the top', 'Unpinned'] },
  flagged: { path: 'flag', icon: 'flag', on: 'Remove flag', off: 'Flag as important', done: ['Flagged', 'Flag removed'] },
};

async function setToggle(conversation, field) {
  const spec = TOGGLES[field];
  const next = !conversation[field];
  // Update everywhere right away, then confirm with the server
  for (const c of [conversation, state.thread?.id === conversation.id ? state.thread : null, ...state.conversations.filter((x) => x.id === conversation.id)]) {
    if (c) c[field] = next;
  }
  renderList();
  renderThreadChrome();
  try {
    await api(`/conversations/${conversation.id}/${spec.path}`, { method: 'POST', body: { [field]: next } });
    toast(spec.done[next ? 0 : 1]);
  } catch (err) {
    toast(err.message);
  }
  loadConversations();
}

function quickToggle(conversation, field, extraClass = '') {
  const spec = TOGGLES[field];
  const on = !!conversation[field];
  return h('button', {
    type: 'button',
    class: `quick ${spec.icon}${on ? ' on' : ''} ${extraClass}`,
    title: on ? spec.on : spec.off,
    'aria-label': on ? spec.on : spec.off,
    'aria-pressed': String(on),
    onclick: (e) => {
      e.stopPropagation();
      setToggle(conversation, field);
    },
  }, icon(spec.icon));
}

// ---------- Sending with the opt-out guard ----------

// Sends, and if the server reports an opted-out recipient, shows the warning
// and retries with confirmation. Returns false if the user backed out.
async function sendWithGuard(conversationId, body, media) {
  try {
    return await api(`/conversations/${conversationId}/messages`, { method: 'POST', body: { body, media } });
  } catch (err) {
    if (err.code !== 'opted_out') throw err;
    if (!(await confirmOptOutDialog(err.phones))) return false;
    return api(`/conversations/${conversationId}/messages`, { method: 'POST', body: { body, media, confirmOptOut: true } });
  }
}

// ----- New message -----

function renderNewMessage() {
  if (!state.numbers.length) return placeholder('There are no numbers you can send from yet.');
  const recipients = [];
  const fromSelect = h('select', { name: 'from' }, numberOptions());
  if (state.filterNumber !== 'all') fromSelect.value = state.filterNumber;

  const chips = h('div', { class: 'chips' });
  const suggest = h('div', { class: 'suggest', hidden: true });
  const input = h('input', { type: 'text', placeholder: 'Name, phone or patient ID', autocomplete: 'off' });
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
    fill(chips, 
      ...recipients.map((p, i) =>
        h('span', { class: `chip${state.optedOut.has(p) ? ' warn' : ''}` }, nameFor(p),
          h('button', { type: 'button', title: 'Remove', onclick: () => { recipients.splice(i, 1); drawChips(); } }, '×'))),
      input,
    );
    input.focus();
  };
  let lookupTimer;
  input.addEventListener('input', () => {
    clearTimeout(lookupTimer);
    const q = input.value.trim();
    if (q.length < 2) {
      suggest.hidden = true;
      return;
    }
    lookupTimer = setTimeout(async () => {
      const { contacts } = await api(`/contacts?q=${encodeURIComponent(q)}&limit=8`).catch(() => ({ contacts: [] }));
      const withPhone = contacts.filter((c) => c.phone);
      fill(suggest, ...withPhone.map((c) =>
        h('button', { type: 'button', onclick: () => addRecipient(c.phone) },
          `${fullName(c)} · ${formatPhone(c.phone)}`,
          c.optedOut && h('span', { class: 'tag warn' }, 'Opted out'))));
      suggest.hidden = !withPhone.length;
    }, 200);
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
    const sent = await sendWithGuard(id, body, media);
    if (sent === false) return false;
    location.hash = `#/c/${id}`;
  }, { errorEl: error });

  fill(els.main, 
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

// ----- Thread -----

async function openThread(id) {
  if (state.thread?.id !== id) {
    fill(els.main, h('div', { class: 'placeholder' }, 'Loading…'));
    try {
      const [conv, messages] = await Promise.all([api(`/conversations/${id}`), api(`/conversations/${id}/messages`)]);
      if (route().id !== id) return;
      state.thread = { ...conv, messages, hasMore: messages.length >= 50 };
    } catch (err) {
      fill(els.main, h('div', { class: 'placeholder' }, err.message));
      return;
    }
  }
  const t = state.thread;

  els.threadHead = h('div', { class: 'thread-head' });
  els.optoutBanner = h('div', { class: 'optout-banner', hidden: true });
  els.messages = h('div', { class: 'messages' });
  els.messages.addEventListener('scroll', () => {
    if (els.messages.scrollTop < 80) loadOlder();
  });

  // Merge fields in canned responses use the first contact on a 1:1 thread
  const mergeContact = () => {
    if (t.participants.length !== 1) return null;
    const [firstName = '', lastName = '', nickname = ''] = state.people[t.participants[0]] ?? [];
    return { firstName, lastName, nickname };
  };

  fill(els.main, 
    els.threadHead,
    els.messages,
    els.optoutBanner,
    buildComposer(async (body, media) => {
      const msg = await sendWithGuard(t.id, body, media);
      if (msg === false) return false;
      if (!t.messages.some((m) => m.id === msg.id)) t.messages.push(msg);
      renderMessages(true);
    }, { mergeContact }),
  );
  renderThreadChrome();
  renderMessages(true);
  markRead(t.id);
  els.main.querySelector('textarea').focus({ preventScroll: true });
}

function renderThreadChrome() {
  const t = state.thread;
  if (!t || !els.threadHead?.isConnected) return;
  const others = t.participants;
  const single = others.length === 1 ? others[0] : null;
  const optedOut = others.filter((p) => state.optedOut.has(p));
  const blocked = single && state.blocked.has(single);

  fill(els.threadHead, 
    backButton(),
    conversationAvatar(others),
    h('div', { class: 'title' },
      h('div', { class: 'name' }, conversationName(others),
        optedOut.length > 0 && h('span', { class: 'tag warn' }, 'Opted out'),
        blocked && h('span', { class: 'tag' }, 'Blocked')),
      h('div', { class: 'sub' },
        single && state.names[single] ? `${formatPhone(single)} · ` : '',
        `via ${numberLabel(t.numberId)}`)),
    quickToggle(t, 'pinned', 'head'),
    quickToggle(t, 'flagged', 'head'),
    single && h('button', {
      class: 'icon-btn',
      title: state.names[single] ? 'View contact' : 'Add contact',
      onclick: () => openContactFor(single),
    }, icon('user')),
    h('button', { class: 'icon-btn', title: 'More', onclick: (e) => threadMenu(e.currentTarget) }, icon('menu')),
  );

  els.optoutBanner.hidden = !optedOut.length;
  fill(els.optoutBanner, icon('warning'),
    h('span', {}, `${optedOut.map(nameFor).join(', ')} opted out of texts. Sending will ask you to confirm.`));
}

async function openContactFor(phone) {
  const { contacts } = await api(`/contacts?q=${phone}&limit=1`);
  const match = contacts.find((c) => c.phone === phone);
  location.hash = match ? `#/contacts/${match.id}` : `#/contacts/new?phone=${phone}`;
}

function threadMenu(anchor) {
  const t = state.thread;
  const single = t.participants.length === 1 ? t.participants[0] : null;
  const blocked = single && state.blocked.has(single);
  const optedOut = single && state.optedOut.has(single);
  openMenu(anchor, [
    [t.pinned ? 'Unpin' : 'Pin to top', () => setToggle(t, 'pinned')],
    [t.flagged ? 'Remove flag' : 'Flag as important', () => setToggle(t, 'flagged')],
    ['Mark unread', async () => {
      await api(`/conversations/${t.id}/unread`, { method: 'POST' });
      state.thread = null;
      location.hash = '#/';
    }],
    [t.archived ? 'Move to inbox' : 'Archive', async () => {
      await api(`/conversations/${t.id}/archive`, { method: 'POST', body: { archived: !t.archived } });
      toast(t.archived ? 'Moved back to inbox' : 'Archived');
      state.thread = null;
      location.hash = '#/';
      loadConversations();
    }],
    single && [optedOut ? 'Opt back in' : 'Mark opted out', async () => {
      await api(`/phones/${single}/opt-out`, { method: 'PUT', body: { optedOut: !optedOut } });
      toast(optedOut ? 'Opted back in' : 'Marked as opted out');
    }],
    single && [blocked ? 'Unblock sender' : 'Block sender', async () => {
      if (!blocked && !(await confirmDialog('Block this sender?', `Texts from ${nameFor(single)} will be dropped and won't appear in TextBoss. You can unblock them later from this menu or Admin settings.`, 'Block', { danger: true }))) return;
      await api(`/phones/${single}/block`, { method: 'PUT', body: { blocked: !blocked } });
      toast(blocked ? 'Unblocked' : 'Blocked');
    }, blocked ? '' : 'danger'],
    ['Delete history', async () => {
      if (!(await confirmDialog('Delete this conversation?', 'Every message in this conversation will be permanently deleted for all users. This cannot be undone.', 'Delete', { danger: true }))) return;
      await api(`/conversations/${t.id}`, { method: 'DELETE' });
      toast('Conversation deleted');
      state.thread = null;
      location.hash = '#/';
      loadConversations();
    }, 'danger'],
  ]);
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

    const media = m.media.map((url, i) => {
      const ext = url.split('?')[0].split('.').pop().toLowerCase();
      let view;
      if (['mp4', '3gp', 'mov'].includes(ext)) view = h('video', { src: url, controls: true, preload: 'metadata' });
      else if (['mp3', 'm4a', 'amr', 'wav'].includes(ext)) view = h('audio', { src: url, controls: true });
      else if (['pdf', 'vcf', 'txt'].includes(ext)) view = h('a', { class: 'file', href: url, target: '_blank', rel: 'noopener' }, `📎 ${ext.toUpperCase()} file`);
      else view = h('a', { href: url, target: '_blank', rel: 'noopener' }, h('img', { src: url, alt: 'Attachment', loading: 'lazy' }));
      // Goes through the server so BulkVS-hosted files download instead of opening
      return h('div', { class: 'media-item' }, view,
        h('a', { class: 'media-download', href: `/api/messages/${m.id}/media/${i}`, download: '', title: 'Download' }, icon('download'), 'Download'));
    });

    const status = m.direction === 'out'
      ? { sending: 'Sending…', sent: 'Sent', delivered: 'Delivered', failed: 'Failed' }[m.status] ?? m.status
      : '';
    const showInfo = m.direction === 'out' && (m === t.messages.at(-1) || m.status === 'failed' || m.status === 'sending' || m.kind);

    nodes.push(
      h('div', { class: `msg ${m.direction}${gap ? ' gap' : ''}${m.status === 'failed' ? ' failed' : ''}${m.kind === 'auto' ? ' auto' : ''}`, title: new Date(m.createdAt).toLocaleString() },
        group && m.direction === 'in' && (!prev || prev.from !== m.from || prev.direction !== 'in') && h('div', { class: 'sender' }, nameFor(m.from)),
        media.length > 0 && h('div', { class: 'media' }, media),
        m.body && h('div', { class: 'bubble' }, linkify(m.body)),
        showInfo && h('div', { class: 'info' },
          m.sentBy ? `${m.sentBy} · ` : '',
          m.kind === 'bulk' ? 'Bulk · ' : '',
          new Date(m.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
          ' · ',
          m.status === 'failed' ? h('span', { class: 'err' }, `Failed${m.error ? `: ${m.error}` : ''}`) : status),
      ),
    );
    prev = m;
  }
  if (!nodes.length) nodes.push(h('div', { class: 'placeholder' }, 'No messages yet. Say hello.'));
  fill(box, ...nodes);
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

boot();
