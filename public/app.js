// TextBoss web client. No build step: plain ES modules and DOM APIs.

import {
  h, fill, icon, autoFocus, state, els, route, api, setUnauthorizedHandler, setSetupRequiredHandler, loadIndex, loadCanned, loadLists,
  toast, formatPhone, fullName, nameFor, conversationName, numberLabel, numberOptions, conversationAvatar,
  relTime, store, dialog, confirmDialog, confirmOptOutDialog, openMenu, backButton, buildComposer, avatar, initials, formatDob,
} from './js/core.js';
import { renderContactsSidebar, renderContactsMain, refreshContacts, onBroadcastEvent } from './js/contacts.js';
import { renderCanned } from './js/canned.js';
import { renderAdmin } from './js/admin.js';
import { applyTheme, themePicker, currentLogo } from './js/theme.js';
import { logoSvg } from './js/logo.js';
import { startTour } from './js/tour.js';
import { initPush, notificationsDialog, updateBadge, bellButton, refreshBell } from './js/notify.js';
import { renderSecurity, renderSecurityPage } from './js/security.js';
import { passkeysSupported, getPasskey } from './js/webauthn.js';

const app = document.getElementById('app');

setUnauthorizedHandler(() => {
  state.me = null;
  render();
});
setSetupRequiredHandler(() => {
  if (state.me && !state.security?.setupShown) boot();
});

async function boot() {
  try {
    const me = await api('/me');
    state.me = me.user;
    state.numbers = me.numbers;
    state.mockMode = me.mockMode;
    state.theme = applyTheme(me.theme);
    state.security = me.security;
    state.tourDone = me.tourDone;
    initPush();
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
  if (state.security?.required && !state.security.enabled) {
    renderSetupRequired();
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
  const logo = h('h1', {}, h('span', { class: 'logo', 'data-logo': '34', html: logoSvg(currentLogo(), { size: 34 }) }), 'TextBoss');
  const canPasskey = !setup.needed && setup.passkeys && passkeysSupported(setup.origin);
  const fields = setup.needed
    ? [
        h('label', {}, 'Your name', h('input', { type: 'text', name: 'displayName', autocomplete: 'name' })),
        h('label', {}, 'Username', h('input', { type: 'text', name: 'username', required: true, autocomplete: 'username' })),
        h('label', {}, 'Email (for password resets)', h('input', { type: 'email', name: 'email', required: true, autocomplete: 'email' })),
        h('label', {}, 'Password', h('input', { type: 'password', name: 'password', required: true, minLength: 10, autocomplete: 'new-password' }),
          h('span', { class: 'hint' }, 'At least 10 characters, not a common password, and not your name. A few unrelated words work well.')),
      ]
    : [
        h('label', {}, 'Username', h('input', { type: 'text', name: 'username', required: true, autocomplete: 'username webauthn' })),
        h('label', {}, 'Password', h('input', { type: 'password', name: 'password', required: true, autocomplete: 'current-password' })),
      ];

  const form = h(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        error.textContent = '';
        try {
          const r = await api(setup.needed ? '/setup' : '/login', { method: 'POST', body: Object.fromEntries(new FormData(form)) });
          if (r.mfa) return renderSecondStep(r.mfa, logo);
          await boot();
        } catch (err) {
          error.textContent = err.message;
        }
      },
    },
    logo,
    h('p', {}, setup.needed ? 'Create the first admin account.' : 'Sign in to your team inbox.'),
    fields,
    error,
    h('button', { class: 'btn primary', type: 'submit' }, setup.needed ? 'Create account' : 'Sign in'),
    canPasskey && h('div', { class: 'auth-or' }, 'or'),
    canPasskey && h('button', {
      class: 'btn',
      type: 'button',
      onclick: async () => {
        error.textContent = '';
        try {
          await passkeySignIn();
          await boot();
        } catch (err) {
          error.textContent = err.message;
        }
      },
    }, icon('key'), 'Sign in with a passkey'),
    !setup.needed && setup.email && h('div', { class: 'auth-links' },
      h('button', { type: 'button', class: 'link-btn', onclick: () => renderForgot(logo, form.elements.username.value) }, 'Forgot password?')),
  );
  fill(app, h('div', { class: 'auth' }, form));
  autoFocus(form.querySelector('input'));
}

// token: the password was already accepted (passkey as the second step)
async function passkeySignIn(token) {
  const { options, challengeId } = await api('/login/passkey/options', { method: 'POST', body: { token } });
  const response = await getPasskey(options);
  await api('/login/passkey', { method: 'POST', body: { token, challengeId, response } });
}

function renderSecondStep(m, logo) {
  const error = h('div', { class: 'form-error' });
  const notice = h('p', { class: 'hint' });
  // 'app': authenticator code, 'email': emailed code, null: passkey only so far
  let mode = m.totp ? 'app' : null;
  const code = h('input', { type: 'text', name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 7, placeholder: '123 456', class: 'code-input' });
  const codeLabel = h('span', {});
  const codeSection = h('div', { class: 'code-section' });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Verify');
  const emailBtn = m.email && h('button', { type: 'button', class: 'link-btn', onclick: () => sendEmail() });
  const appBtn = m.totp && h('button', { type: 'button', class: 'link-btn', onclick: () => { mode = 'app'; draw(); } }, 'Use the authenticator app instead');

  const draw = () => {
    codeSection.hidden = !mode;
    submit.hidden = !mode;
    codeLabel.textContent = mode === 'email' ? 'Code from the email' : '6-digit code from your authenticator app';
    if (emailBtn) emailBtn.textContent = mode === 'email' ? 'Send a new code' : `Email me a code instead (${m.email})`;
    if (appBtn) appBtn.hidden = mode !== 'email';
    if (passkeyBtn) passkeyBtn.className = mode ? 'btn' : 'btn primary';
    orLine.hidden = !(mode && passkeyBtn);
    code.value = '';
    if (mode) autoFocus(code);
  };

  async function sendEmail() {
    error.textContent = '';
    emailBtn.disabled = true;
    try {
      const r = await api('/login/email', { method: 'POST', body: { token: m.token } });
      mode = 'email';
      notice.textContent = `We emailed a code to ${r.sentTo}. It can take a minute to arrive; check spam too.`;
      draw();
    } catch (err) {
      error.textContent = err.message;
      if (/expired/.test(err.message)) setTimeout(renderAuth, 1500);
    } finally {
      setTimeout(() => (emailBtn.disabled = false), 5000);
    }
  }

  const finish = async (fn) => {
    error.textContent = '';
    try {
      await fn();
      await boot();
    } catch (err) {
      error.textContent = err.message;
      if (/expired/.test(err.message)) setTimeout(renderAuth, 1500);
    }
  };

  const orLine = h('div', { class: 'auth-or' }, 'or');
  const passkeyBtn = m.passkey && h('button', {
    class: 'btn',
    type: 'button',
    onclick: () => finish(() => passkeySignIn(m.token)),
  }, icon('key'), 'Use a passkey');

  fill(codeSection, h('label', {}, codeLabel, code));
  const form = h('form', {
    onsubmit: (e) => {
      e.preventDefault();
      finish(() => api('/login/mfa', { method: 'POST', body: { token: m.token, code: code.value, method: mode } }));
    },
  },
    logo,
    h('p', {}, 'Two-factor sign-in'),
    notice,
    codeSection,
    error,
    submit,
    orLine,
    passkeyBtn,
    h('div', { class: 'auth-links' },
      appBtn,
      emailBtn,
      !m.email && !m.totp && h('p', { class: 'hint' }, 'Passkey saved on a different device? Ask your administrator to add your email address so you can get a code, or to reset two-factor.'),
      h('button', { type: 'button', class: 'link-btn', onclick: renderAuth }, 'Back')),
  );
  fill(app, h('div', { class: 'auth' }, form));
  draw();
  if (!mode) passkeyBtn?.focus();
}

// Forgot password: email a code, then code + new password signs you in
function renderForgot(logo, login = '') {
  const error = h('div', { class: 'form-error' });
  const who = h('input', { type: 'text', name: 'login', required: true, value: login, autocomplete: 'username', placeholder: 'Username or email' });
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      error.textContent = '';
      try {
        await api('/password/forgot', { method: 'POST', body: { login: who.value } });
        renderResetCode(logo, who.value);
      } catch (err) {
        error.textContent = err.message;
      }
    },
  },
    logo,
    h('p', {}, 'Reset your password'),
    h('p', { class: 'hint' }, 'We\'ll email a code to the address saved on your account.'),
    h('label', {}, 'Username or email', who),
    error,
    h('button', { class: 'btn primary', type: 'submit' }, 'Email me a code'),
    h('div', { class: 'auth-links' }, h('button', { type: 'button', class: 'link-btn', onclick: renderAuth }, 'Back to sign in')));
  fill(app, h('div', { class: 'auth' }, form));
  autoFocus(who);
}

function renderResetCode(logo, login) {
  const error = h('div', { class: 'form-error' });
  const code = h('input', { type: 'text', name: 'code', required: true, inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 7, placeholder: '123 456', class: 'code-input' });
  const pw = h('input', { type: 'password', name: 'password', required: true, minLength: 10, autocomplete: 'new-password' });
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      error.textContent = '';
      try {
        await api('/password/reset', { method: 'POST', body: { login, code: code.value, password: pw.value } });
        toast('Password changed');
        await boot();
      } catch (err) {
        error.textContent = err.message;
      }
    },
  },
    logo,
    h('p', {}, 'Check your email'),
    h('p', { class: 'hint' }, 'If that account has an email address, a 6-digit code is on its way. It can take a minute; check spam too. No email? Your administrator can reset your password.'),
    h('label', {}, 'Code from the email', code),
    h('label', {}, 'New password', pw, h('span', { class: 'hint' }, 'At least 10 characters, not a common password, and not your name. A few unrelated words work well.')),
    error,
    h('button', { class: 'btn primary', type: 'submit' }, 'Change password and sign in'),
    h('div', { class: 'auth-links' },
      h('button', { type: 'button', class: 'link-btn', onclick: () => renderForgot(logo, login) }, 'Send a new code'),
      h('button', { type: 'button', class: 'link-btn', onclick: renderAuth }, 'Back to sign in')));
  fill(app, h('div', { class: 'auth' }, form));
  autoFocus(code);
}

// The admin requires 2FA and this person has none yet
function renderSetupRequired() {
  state.security.setupShown = true;
  const body = h('div', { class: 'setup-required' });
  fill(app, h('div', { class: 'auth setup-wrap' },
    h('div', { class: 'setup-card' },
      h('h1', {}, h('span', { class: 'logo', html: logoSvg(currentLogo(), { size: 34 }) }), 'Set up two-factor sign-in'),
      h('p', { class: 'hint' }, `Hi ${state.me.displayName}. Your administrator requires a second step when signing in. Choose one below; it takes about a minute.`),
      body,
      h('button', { type: 'button', class: 'link-btn', onclick: async () => {
        await api('/logout', { method: 'POST' });
        state.me = null;
        render();
      } }, 'Sign out'))));
  renderSecurity(body, {
    forced: true,
    onEnabled: async () => {
      state.security.enabled = true;
      toast('Two-factor sign-in is on');
      await boot();
    },
  });
}

// ---------- Welcome tour ----------

function runTour() {
  startTour({
    onFinish: () => {
      if (state.tourDone) return;
      state.tourDone = true;
      api('/me/tour', { method: 'POST' }).catch(() => {});
    },
    actions: {
      notifications: async () => (await notificationsDialog()).addEventListener('close', refreshBell),
      security: () => (location.hash = '#/security'),
      admin: () => (location.hash = '#/admin'),
    },
  });
}

// Nudge to set up two-factor sign-in; "Remind me tomorrow" snoozes it everywhere for a day
function mfaBanner() {
  const el = h('div', { class: 'nag-banner', role: 'note' },
    icon('shield'),
    h('div', {},
      h('strong', {}, 'Protect your account. '),
      'Add a passkey or authenticator app so client messages stay safe even if your password leaks.',
      h('div', { class: 'nag-actions' },
        h('a', { class: 'btn primary', href: '#/security' }, 'Set up'),
        h('button', { type: 'button', class: 'link-btn', onclick: async () => {
          el.remove();
          state.security.remind = false;
          await api('/me/security/snooze', { method: 'POST' }).catch(() => {});
        } }, 'Remind me tomorrow'))));
  window.addEventListener('tb:mfa-enabled', () => el.remove(), { once: true });
  return el;
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
        h('span', { class: 'logo', 'data-logo': '28', html: logoSvg(currentLogo(), { size: 28 }) }),
        h('div', { class: 'brand' }, h('span', { class: 'brand-1' }, 'Text'), h('span', { class: 'brand-2' }, 'Boss')),
        h('button', { class: 'new-btn', title: 'New message (N)', onclick: () => (location.hash = '#/new') }, icon('newchat'), h('span', {}, 'New')),
        bellButton(),
        h('button', { class: 'icon-btn', title: 'Menu', onclick: (e) => openUserMenu(e.currentTarget) }, icon('menu'))),
      els.tabs,
      state.mockMode && h('div', { class: 'mock-banner' }, 'Mock mode: messages are not really sent.'),
      state.security?.remind && mfaBanner(),
      els.sideBody,
    ),
    els.main,
  );
  fill(app, els.layout);
  els.sidebarTab = null;

  connectEvents();
  Promise.all([loadIndex(), loadCanned(), loadLists()]).then(async () => {
    await loadConversations();
    els.sidebarTab = null; // redraw the sidebar now that names and lists are loaded
    renderRoute();
    // First sign-in: show the welcome tour once the list is drawn
    if (!state.tourDone) setTimeout(runTour, 400);
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
  if (r.view !== 'thread') {
    state.thread = null;
    panes.clear();
    els.panes = null;
  }

  switch (r.view) {
    case 'thread': return renderPanes(r.ids);
    case 'new': return renderNewMessage();
    case 'admin': return state.me.isAdmin ? renderAdmin() : placeholder('Admins only.');
    case 'canned': return renderCanned();
    case 'security': return renderSecurityPage(els.main);
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
    ['Appearance', () => themePicker(state.theme, (t) => {
      state.theme = t;
      for (const p of panes.values()) renderPaneMessages(p);
    })],
    ['Security', () => (location.hash = '#/security')],
    state.me.isAdmin && ['Admin settings', () => (location.hash = '#/admin')],
    ['Take the tour', runTour],
    ['Refresh', () => location.reload()],
    ['Notifications', async () => (await notificationsDialog()).addEventListener('close', refreshBell)],
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
      h('label', {}, 'New password', h('input', { type: 'password', name: 'next', required: true, minLength: 10, autocomplete: 'new-password' })),
      h('p', { class: 'hint' }, 'At least 10 characters, not a common password, and not your name. A few unrelated words work well.'),
    ],
    'Save',
    async (data) => {
      await api('/me/password', { method: 'POST', body: Object.fromEntries(data) });
      toast('Password changed');
    },
  );
}

// ---------- New version available ----------

let loadedVersion = null;
async function checkForUpdate() {
  const { version } = await api('/version').catch(() => ({}));
  if (!version) return;
  loadedVersion ??= version;
  if (version === loadedVersion || document.querySelector('.update-bar')) return;
  document.body.append(h('div', { class: 'update-bar', role: 'status' },
    h('span', {}, 'TextBoss was updated.'),
    h('button', { class: 'btn primary', onclick: () => location.reload() }, 'Reload'),
    h('button', { class: 'icon-btn', title: 'Later', onclick: (e) => e.currentTarget.parentNode.remove() }, icon('close'))));
}
checkForUpdate();
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && checkForUpdate());
setInterval(checkForUpdate, 15 * 60_000);

// ---------- Live updates ----------

// Phones freeze a backgrounded app's connection, and proxies can drop idle
// ones without the browser noticing. The server pings every 25s; if nothing
// arrives for longer than that, reconnect. Every (re)connect, and coming back
// to the app, re-fetches what's on screen so nothing missed stays missing.
const STALE_MS = 65_000;
let lastEventAt = Date.now();

function reconnectEvents() {
  state.events?.close();
  state.events = null;
  connectEvents();
}

setInterval(() => {
  if (state.events && Date.now() - lastEventAt > STALE_MS) reconnectEvents();
}, 15_000);

function onReturn() {
  if (!state.me || !state.events) return;
  if (Date.now() - lastEventAt > 30_000 || state.events.readyState !== EventSource.OPEN) reconnectEvents();
  else catchUp();
}
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && onReturn());
window.addEventListener('online', onReturn);
window.addEventListener('pageshow', (e) => e.persisted && onReturn());

// Re-load the conversation list and the newest messages of every open pane
let catchUpTimer;
function catchUp() {
  clearTimeout(catchUpTimer);
  catchUpTimer = setTimeout(async () => {
    loadConversations();
    await Promise.all([...panes.values()].filter((p) => p.conv).map(async (p) => {
      const latest = await api(`/conversations/${p.id}/messages`).catch(() => null);
      if (!latest) return;
      const byId = new Map(p.messages.map((m) => [m.id, m]));
      for (const m of latest) byId.set(m.id, m);
      // Anything older than the fetched page that vanished was deleted
      const oldest = latest[0]?.id ?? Infinity;
      p.messages = [...byId.values()].filter((m) => m.id < oldest || latest.some((l) => l.id === m.id)).sort((a, b) => a.id - b.id);
      renderPaneMessages(p);
      if (p.visible && document.visibilityState === 'visible') markRead(p.id);
    }));
  }, 150);
}

function connectEvents() {
  if (state.events) return;
  const es = new EventSource('/api/events');
  state.events = es;
  lastEventAt = Date.now();
  const alive = () => (lastEventAt = Date.now());
  for (const type of ['ping', 'message', 'read', 'contacts', 'canned', 'numbers', 'broadcast']) es.addEventListener(type, alive);
  es.addEventListener('message', (e) => onMessageEvent(JSON.parse(e.data)));
  es.addEventListener('read', () => scheduleListReload());
  es.addEventListener('contacts', async () => {
    await Promise.all([loadIndex(), loadLists()]);
    renderList();
    renderThreadChrome();
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
  es.addEventListener('open', () => {
    alive();
    catchUp();
    checkForUpdate();
  });
}

let listReloadTimer;
function scheduleListReload() {
  clearTimeout(listReloadTimer);
  listReloadTimer = setTimeout(loadConversations, 150);
}

function onMessageEvent(msg) {
  scheduleListReload();
  const p = panes.get(msg.conversationId);
  if (p?.conv) {
    const i = p.messages.findIndex((m) => m.id === msg.id);
    if (i >= 0) p.messages[i] = msg;
    else p.messages.push(msg);
    renderPaneMessages(p);
    if (msg.direction === 'in' && p.visible && document.visibilityState === 'visible') markRead(p.id);
  }
  if (msg.direction === 'in' && msg.status === 'received' && (document.visibilityState !== 'visible' || !p?.visible)) {
    notify(msg);
  }
}

function notify(msg) {
  // Devices with push get the alert from the service worker instead
  if (state.pushActive || state.notifyPaused || !('Notification' in window) || Notification.permission !== 'granted') return;
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
  if (document.visibilityState !== 'visible') return;
  for (const p of panes.values()) if (p.visible) markRead(p.id);
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
    placeholder: 'Search messages, names, client ID',
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
  // App-icon badge: total unread, regardless of the current filter
  api('/badge').then((b) => updateBadge(b.unread)).catch(() => {});
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
  const open = r.view === 'thread' ? r.ids : [];
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
          class: `conv${open.includes(c.id) ? ' active' : ''}${open.length > 1 && c.id === state.focusedId ? ' focused' : ''}${c.unread ? ' unread' : ''}${c.flagged ? ' flagged' : ''}`,
          onclick: (e) => {
            if (e.target.closest('button')) return;
            e.preventDefault();
            openConversation(c.id, { beside: e.metaKey || e.ctrlKey });
          },
        },
        h('a', { class: 'conv-link', href: `#/c/${c.id}` },
          conversationAvatar(c.participants),
          h('div', { class: 'main' },
            h('div', { class: 'name', title: sharedNamesTitle(c.participants) }, conversationName(c.participants), optedOut && h('span', { class: 'tag warn' }, 'Opted out')),
            h('div', { class: 'preview' }, preview),
            multi && h('div', { class: 'via' }, `via ${numberLabel(c.numberId)}`),
          )),
        h('div', { class: 'meta' },
          h('span', { class: 'meta-time' }, relTime(c.lastMessageAt)),
          h('div', { class: 'meta-bottom' },
            h('button', {
              type: 'button',
              class: 'quick split',
              title: 'Open beside (or Cmd/Ctrl-click)',
              'aria-label': 'Open beside the current conversation',
              onclick: (e) => {
                e.stopPropagation();
                openConversation(c.id, { beside: true });
              },
            }, icon('split')),
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
  for (const c of [conversation, panes.get(conversation.id)?.conv, ...state.conversations.filter((x) => x.id === conversation.id)]) {
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
  const input = h('input', { type: 'text', placeholder: 'Name, phone or client ID', autocomplete: 'off' });
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
  autoFocus(input);
}

// ----- Conversation panes -----
//
// On desktop up to three conversations can be open side by side. The URL holds
// them left to right (#/c/12+15+18). Clicking a conversation replaces the
// focused pane; Cmd/Ctrl-click or "Open beside" adds a pane. Narrow windows
// show only as many as fit, always including the focused one.

const MAX_PANES = 3;
const panes = new Map(); // conversation id -> pane

const threadHash = (ids) => (ids.length ? `#/c/${ids.join('+')}` : '#/');
const openIds = () => (route().view === 'thread' ? route().ids : []);

// How many panes fit next to the sidebar
function paneCapacity() {
  const w = window.innerWidth;
  return w >= 1500 ? 3 : w >= 1100 ? 2 : 1;
}

function openConversation(id, { beside = false } = {}) {
  let ids = openIds();
  if (ids.includes(id)) {
    focusPane(id);
    return;
  }
  if (beside && ids.length) {
    if (ids.length >= MAX_PANES) {
      toast('Up to 3 conversations side by side; replaced the active one');
      ids = ids.map((x) => (x === state.focusedId ? id : x));
    } else {
      ids = [...ids, id];
    }
  } else if (ids.includes(state.focusedId)) {
    ids = ids.map((x) => (x === state.focusedId ? id : x));
  } else {
    ids = [id];
  }
  state.focusedId = id;
  location.hash = threadHash(ids);
}

function closePane(id) {
  const ids = openIds().filter((x) => x !== id);
  if (state.focusedId === id) state.focusedId = ids.at(-1) ?? null;
  location.hash = threadHash(ids);
}

function focusPane(id) {
  if (state.focusedId === id) return;
  state.focusedId = id;
  layoutPanes();
  renderList();
}

// Builds or reuses panes for the conversations in the URL
function renderPanes(ids) {
  if (!ids.includes(state.focusedId)) state.focusedId = ids.at(-1);
  if (!els.panes?.isConnected) {
    els.panes = h('div', { class: 'panes' });
    fill(els.main, els.panes);
  }
  for (const [id, p] of panes) {
    if (!ids.includes(id)) {
      p.el.remove();
      panes.delete(id);
    }
  }
  for (const id of ids) {
    let p = panes.get(id);
    if (!p) {
      p = createPane(id);
      panes.set(id, p);
    }
    els.panes.append(p.el); // keeps URL order
  }
  layoutPanes();
  state.thread = panes.get(state.focusedId) ?? null;
}

// Which panes are visible, and which one is focused
function layoutPanes() {
  if (!els.panes?.isConnected) return;
  const ids = openIds();
  const cap = paneCapacity();
  // Show the focused pane plus its nearest neighbours that fit
  const fi = Math.max(0, ids.indexOf(state.focusedId));
  let start = Math.min(Math.max(0, fi - (cap - 1)), Math.max(0, ids.length - cap));
  if (fi < start) start = fi;
  const visible = new Set(ids.slice(start, start + cap));
  els.panes.classList.toggle('multi', visible.size > 1);
  els.panes.style.gridTemplateColumns = `repeat(${visible.size}, minmax(0, 1fr))`;
  for (const [id, p] of panes) {
    p.visible = visible.has(id);
    p.el.classList.toggle('pane-hidden', !p.visible);
    p.el.classList.toggle('focused', id === state.focusedId);
    renderPaneChrome(p);
  }
  state.thread = panes.get(state.focusedId) ?? null;
}

window.addEventListener('resize', () => {
  clearTimeout(layoutPanes.t);
  layoutPanes.t = setTimeout(layoutPanes, 100);
});

function createPane(id) {
  const p = { id, conv: null, messages: [], hasMore: false, loading: false, visible: true };
  p.head = h('div', { class: 'thread-head' });
  p.banner = h('div', { class: 'optout-banner', hidden: true });
  p.list = h('div', { class: 'messages' }, h('div', { class: 'placeholder' }, 'Loading…'));
  p.list.addEventListener('scroll', () => {
    if (p.list.scrollTop < 80) loadOlder(p);
  });

  // Merge fields in canned responses use the first contact on a 1:1 thread
  const mergeContact = () => {
    if (!p.conv || p.conv.participants.length !== 1) return null;
    const [firstName = '', lastName = '', nickname = ''] = state.people[p.conv.participants[0]] ?? [];
    return { firstName, lastName, nickname };
  };
  p.composer = buildComposer(async (body, media) => {
    const msg = await sendWithGuard(p.id, body, media);
    if (msg === false) return false;
    if (!p.messages.some((m) => m.id === msg.id)) p.messages.push(msg);
    renderPaneMessages(p, true);
  }, { mergeContact });

  // Beside the messages on wide panes: the client's details (see renderClientPanel)
  p.side = h('aside', { class: 'client-panel', 'aria-label': 'Client details' });
  p.el = h('section', {
    class: 'pane',
    'aria-label': 'Conversation',
    onmousedown: () => focusPane(id),
    onfocusin: () => focusPane(id),
  }, p.head, h('div', { class: 'pane-body' }, h('div', { class: 'pane-main' }, h('div', { class: 'conv-backdrop', 'aria-hidden': 'true' }), p.list, p.banner, p.composer), p.side));

  (async () => {
    try {
      const [conv, messages] = await Promise.all([api(`/conversations/${id}`), api(`/conversations/${id}/messages`)]);
      p.conv = conv;
      p.messages = messages;
      p.hasMore = messages.length >= 50;
    } catch (err) {
      fill(p.list, h('div', { class: 'placeholder' }, err.message));
      return;
    }
    renderPaneChrome(p);
    renderPaneMessages(p, true);
    if (p.visible) markRead(id);
    if (id === state.focusedId) autoFocus(p.composer.textarea);
  })();
  return p;
}

function renderPaneChrome(p) {
  const t = p.conv;
  if (!t) return;
  const others = t.participants;
  const single = others.length === 1 ? others[0] : null;
  const optedOut = others.filter((x) => state.optedOut.has(x));
  const blocked = single && state.blocked.has(single);
  const multi = els.panes?.classList.contains('multi');
  // Phone (when a contact name is shown) and, with several numbers, which one this is on
  const shared = single && (state.names[single]?.length ?? 0) > 1;
  const subline = [
    single && state.names[single] && formatPhone(single),
    shared && `Shared number: ${state.names[single].join(', ')}`,
    state.numbers.length > 1 && `via ${numberLabel(t.numberId)}`,
  ].filter(Boolean).join(' · ');

  fill(p.head,
    backButton(),
    conversationAvatar(others),
    h('div', { class: 'title' },
      h('div', { class: 'name' },
        h('span', { class: 'name-text' }, conversationName(others)),
        // Phones hide the header pin/flag buttons; these show the state instead
        t.pinned && h('span', { class: 'state-mark pin', title: 'Pinned' }, icon('pin')),
        t.flagged && h('span', { class: 'state-mark flag', title: 'Flagged' }, icon('flag')),
        optedOut.length > 0 && h('span', { class: 'tag warn' }, 'Opted out'),
        blocked && h('span', { class: 'tag' }, 'Blocked')),
      subline && h('div', { class: 'sub' }, subline)),
    quickToggle(t, 'pinned', 'head'),
    quickToggle(t, 'flagged', 'head'),
    single && h('button', {
      class: 'icon-btn',
      title: shared ? 'Contacts at this number' : state.names[single] ? 'View contact' : 'Add contact',
      onclick: (e) => openContactFor(single, e.currentTarget),
    }, icon('user')),
    h('button', {
      class: 'icon-btn panel-toggle',
      title: state.theme?.clientPanel === false ? 'Show client details' : 'Hide client details',
      'aria-pressed': String(state.theme?.clientPanel !== false),
      onclick: toggleClientPanel,
    }, icon('sidepanel')),
    h('button', { class: 'icon-btn', title: 'More', onclick: (e) => paneMenu(p, e.currentTarget) }, icon('menu')),
    multi && h('button', { class: 'icon-btn pane-close', title: 'Close this pane', onclick: () => closePane(p.id) }, icon('close')),
  );

  p.banner.hidden = !optedOut.length;
  fill(p.banner, icon('warning'),
    h('span', {}, `${optedOut.map(nameFor).join(', ')} opted out of texts. Sending will ask you to confirm.`));
  renderClientPanel(p);
}

// ----- Client details panel -----

// Remembered per person, like the rest of Appearance
async function toggleClientPanel() {
  const show = state.theme?.clientPanel === false;
  state.theme = applyTheme({ ...state.theme, clientPanel: show });
  for (const p of panes.values()) renderPaneChrome(p);
  try {
    state.theme = applyTheme(await api('/me/theme', { method: 'PUT', body: state.theme }));
  } catch {}
}

const ageFrom = (dob) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob ?? '');
  if (!m) return null;
  const now = new Date();
  let age = now.getFullYear() - Number(m[1]);
  if (now.getMonth() + 1 < Number(m[2]) || (now.getMonth() + 1 === Number(m[2]) && now.getDate() < Number(m[3]))) age--;
  return age >= 0 && age < 130 ? age : null;
};

async function contactsForPhone(phone) {
  const { contacts } = await api(`/contacts?q=${phone}&limit=20&status=all`);
  const matches = contacts.filter((c) => c.phone === phone).slice(0, 5);
  return Promise.all(matches.map((c) => api(`/contacts/${c.id}`).catch(() => c)));
}

function clientCard(c) {
  const age = ageFrom(c.dob);
  const row = (label, value) => value && h('div', { class: 'cp-row' }, h('span', { class: 'cp-label' }, label), h('span', { class: 'cp-value' }, value));
  return h('div', { class: 'cp-card' },
    h('div', { class: 'cp-head' },
      avatar(`c${c.id}`, initials(fullName(c))),
      h('div', { class: 'cp-name' },
        h('a', { href: `#/contacts/${c.id}` }, fullName(c)),
        h('div', { class: 'cp-tags' },
          c.optedOut && h('span', { class: 'tag warn' }, 'Opted out'),
          c.blocked && h('span', { class: 'tag' }, 'Blocked'),
          c.inactiveAt && h('span', { class: 'tag' }, 'Inactive')))),
    row('Phone', c.phone && formatPhone(c.phone)),
    row('Born', c.dob && `${formatDob(c.dob)}${age != null ? ` (${age})` : ''}`),
    row('Client ID', c.patientId),
    row('Email', c.email && h('a', { href: `mailto:${c.email}` }, c.email)),
    c.lists?.length > 0 && row('Lists', h('span', { class: 'cp-chips' }, c.lists.map((l) => h('span', { class: 'chip' }, l.name)))),
    c.notes
      ? h('div', { class: 'cp-notes' }, h('div', { class: 'cp-label' }, 'Notes'), h('div', { class: 'cp-notes-text' }, c.notes))
      : h('div', { class: 'cp-notes hint' }, 'No notes yet.'),
    h('div', { class: 'cp-actions' },
      h('a', { class: 'btn', href: `#/contacts/${c.id}` }, 'Edit contact'),
      // Shared number: choose whose name the conversation shows
      c.sharedPhone > 0 && (c.isDisplayName
        ? h('span', { class: 'hint' }, 'Name shown')
        : h('button', { type: 'button', class: 'link-btn', onclick: async () => {
            await api(`/contacts/${c.id}/display-name`, { method: 'POST' });
            toast(`Conversation now shows ${fullName(c)}`);
          } }, 'Show this name'))));
}

let panelSeq = 0;
// Only wide windows can show the panel; fill it in when one gets wide
const wideEnough = matchMedia('(min-width: 1000px)');
wideEnough.addEventListener('change', () => wideEnough.matches && renderThreadChrome());

async function renderClientPanel(p) {
  if (!p.conv || state.theme?.clientPanel === false || !wideEnough.matches || !p.el.isConnected) return;
  const seq = ++panelSeq;
  p.panelSeq = seq;
  const phones = p.conv.participants.slice(0, 10);
  let groups;
  try {
    groups = await Promise.all(phones.map(async (phone) => ({ phone, contacts: await contactsForPhone(phone) })));
  } catch (err) {
    fill(p.side, h('p', { class: 'hint' }, err.message));
    return;
  }
  if (p.panelSeq !== seq) return; // a newer render started meanwhile
  const group = phones.length > 1;
  fill(p.side,
    h('div', { class: 'cp-title' }, group ? `${phones.length} people in this group` : 'Client details'),
    groups.map(({ phone, contacts }) => contacts.length
      ? [
          group && h('div', { class: 'cp-phone' }, formatPhone(phone)),
          !group && contacts.length > 1 && h('p', { class: 'hint' }, `${contacts.length} contacts share this number.`),
          contacts.map(clientCard),
        ]
      : h('div', { class: 'cp-card' },
          h('div', { class: 'cp-phone' }, formatPhone(phone)),
          h('p', { class: 'hint' }, 'Not in your contacts.'),
          h('div', { class: 'cp-actions' }, h('a', { class: 'btn', href: `#/contacts/new?phone=${phone}` }, 'Add contact')))));
}

function renderThreadChrome() {
  for (const p of panes.values()) renderPaneChrome(p);
}

// Several contacts can share a phone (a family); then offer each one
async function openContactFor(phone, anchor) {
  const { contacts } = await api(`/contacts?q=${phone}&limit=20&status=all`);
  const matches = contacts.filter((c) => c.phone === phone);
  if (matches.length > 1 && anchor) {
    openMenu(anchor, [
      ...matches.map((c) => [`${fullName(c)}${c.inactiveAt ? ' (inactive)' : ''}`, () => (location.hash = `#/contacts/${c.id}`)]),
      ['Add another contact', () => (location.hash = `#/contacts/new?phone=${phone}`)],
    ]);
    return;
  }
  location.hash = matches[0] ? `#/contacts/${matches[0].id}` : `#/contacts/new?phone=${phone}`;
}

// Hover text for a conversation row when a phone belongs to several contacts
function sharedNamesTitle(participants) {
  const lines = participants.filter((p) => (state.names[p]?.length ?? 0) > 1).map((p) => `${formatPhone(p)} is shared by: ${state.names[p].join(', ')}`);
  return lines.length ? lines.join('\n') : null;
}

function paneMenu(p, anchor) {
  const t = p.conv;
  const single = t.participants.length === 1 ? t.participants[0] : null;
  const blocked = single && state.blocked.has(single);
  const optedOut = single && state.optedOut.has(single);
  openMenu(anchor, [
    [t.pinned ? 'Unpin' : 'Pin to top', () => setToggle(t, 'pinned')],
    [t.flagged ? 'Remove flag' : 'Flag as important', () => setToggle(t, 'flagged')],
    ['Mark unread', async () => {
      await api(`/conversations/${t.id}/unread`, { method: 'POST' });
      closePane(t.id);
    }],
    [t.archived ? 'Move to inbox' : 'Archive', async () => {
      await api(`/conversations/${t.id}/archive`, { method: 'POST', body: { archived: !t.archived } });
      toast(t.archived ? 'Moved back to inbox' : 'Archived');
      closePane(t.id);
      loadConversations();
    }],
    single && [optedOut ? 'Opt back in' : 'Mark opted out', async () => {
      await api(`/phones/${single}/opt-out`, { method: 'PUT', body: { optedOut: !optedOut } });
      toast(optedOut ? 'Opted back in' : 'Marked as opted out');
    }],
    single && state.me.isAdmin && [blocked ? 'Unblock sender' : 'Block sender', async () => {
      if (!blocked && !(await confirmDialog('Block this sender?', `Texts from ${nameFor(single)} will be dropped and won't appear in TextBoss. You can unblock them later from this menu or Admin settings.`, 'Block', { danger: true }))) return;
      await api(`/phones/${single}/block`, { method: 'PUT', body: { blocked: !blocked } });
      toast(blocked ? 'Unblocked' : 'Blocked');
    }, blocked ? '' : 'danger'],
    state.me.isAdmin && ['Delete history', async () => {
      if (!(await confirmDialog('Delete this conversation?', 'Every message in this conversation will be permanently deleted for all users. This cannot be undone.', 'Delete', { danger: true }))) return;
      await api(`/conversations/${t.id}`, { method: 'DELETE' });
      toast('Conversation deleted');
      closePane(t.id);
      loadConversations();
    }, 'danger'],
  ]);
}

async function loadOlder(p) {
  if (!p.hasMore || p.loading || !p.messages.length) return;
  p.loading = true;
  const older = await api(`/conversations/${p.id}/messages?before=${p.messages[0].id}`).catch(() => []);
  p.loading = false;
  p.hasMore = older.length >= 50;
  if (!older.length) return;
  const prevHeight = p.list.scrollHeight;
  p.messages.unshift(...older);
  renderPaneMessages(p);
  p.list.scrollTop = p.list.scrollHeight - prevHeight;
}

function renderPaneMessages(p, forceBottom = false) {
  const box = p.list;
  if (!p.conv || !box.isConnected) return;
  const atBottom = forceBottom || box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const prevTop = box.scrollTop;
  const group = p.conv.participants.length > 1;

  const nodes = [];
  let lastDay = '';
  let prev = null;
  for (const m of p.messages) {
    const day = new Date(m.createdAt).toDateString();
    if (day !== lastDay) {
      nodes.push(h('div', { class: 'day' }, new Date(m.createdAt).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })));
      lastDay = day;
      prev = null;
    }
    const gap = prev && (prev.direction !== m.direction || prev.from !== m.from || prev.sentBy !== m.sentBy || m.createdAt - prev.createdAt > 5 * 60_000);
    // Outgoing texts from other staff (or auto-replies) are tagged and shaded;
    // your own only get your name if you turned that on in Appearance
    const other = m.direction === 'out' && m.kind !== 'auto' && m.sentById != null && m.sentById !== state.me.id;
    const tagged = m.direction === 'out' && m.sentBy && (other || m.kind === 'auto' || state.theme?.labelOwn);
    const runStart = !prev || prev.direction !== 'out' || prev.sentBy !== m.sentBy || gap;

    const media = m.media.map((url, i) => {
      const ext = url.split('?')[0].split('.').pop().toLowerCase();
      // MMS often carries a SMIL layout file alongside the picture; it has nothing to show
      if (['smil', 'smi', 'xml'].includes(ext)) return null;
      let view;
      if (['mp4', '3gp', 'mov'].includes(ext)) view = h('video', { src: url, controls: true, preload: 'metadata' });
      else if (['mp3', 'm4a', 'amr', 'wav'].includes(ext)) view = h('audio', { src: url, controls: true });
      else if (['pdf', 'vcf', 'txt'].includes(ext)) view = h('a', { class: 'file', href: url, target: '_blank', rel: 'noopener' }, `📎 ${ext.toUpperCase()} file`);
      else view = h('a', { href: url, target: '_blank', rel: 'noopener' }, h('img', { src: url, alt: 'Attachment', loading: 'lazy' }));
      // Goes through the server so provider-hosted files download instead of opening
      return h('div', { class: 'media-item' }, view,
        h('a', { class: 'media-download', href: `/api/messages/${m.id}/media/${i}`, download: '', title: 'Download' }, icon('download'), 'Download'));
    });

    const status = m.direction === 'out'
      ? { sending: 'Sending…', sent: 'Sent', delivered: 'Delivered', failed: 'Failed' }[m.status] ?? m.status
      : '';
    const showInfo = m.direction === 'out' && (m === p.messages.at(-1) || m.status === 'failed' || m.status === 'sending' || m.kind);

    nodes.push(
      h('div', { class: `msg ${m.direction}${gap ? ' gap' : ''}${other ? ' other' : ''}${m.status === 'failed' ? ' failed' : ''}${m.kind === 'auto' ? ' auto' : ''}`, title: `${m.sentBy ? `${m.sentBy} · ` : ''}${new Date(m.createdAt).toLocaleString()}` },
        group && m.direction === 'in' && (!prev || prev.from !== m.from || prev.direction !== 'in') && h('div', { class: 'sender' }, nameFor(m.from)),
        tagged && runStart && h('div', { class: 'sender' }, m.sentBy),
        media.some(Boolean) && h('div', { class: 'media' }, media),
        m.body && h('div', { class: 'bubble' }, linkify(m.body)),
        showInfo && h('div', { class: 'info' },
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

const readTimers = new Map();
function markRead(id) {
  clearTimeout(readTimers.get(id));
  readTimers.set(id, setTimeout(() => api(`/conversations/${id}/read`, { method: 'POST' }).catch(() => {}), 300));
}

boot();
