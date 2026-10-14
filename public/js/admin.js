// Admin settings, split into tabs of separate cards:
// Provider (BulkVS or VoIP.ms connection + webhook), Numbers, Users, Email, Contacts (import + API), Blocked, Backup

import {
  h, fill, icon, state, els, route, api, toast, formatPhone, numberLabel, dialog, confirmDialog,
  paneHead, relTime, formatDob, fullName, helpLink,
} from './core.js';

const TABS = [
  ['bulkvs', 'Provider'],
  ['numbers', 'Numbers'],
  ['users', 'Users'],
  ['email', 'Email'],
  ['hours', 'Office hours'],
  ['contacts', 'Contacts & Import'],
  ['blocked', 'Blocked'],
  ['backup', 'Backup'],
];

// A titled card: heading, one-line description, then content
function card(title, description, ...body) {
  return h('section', { class: 'card' },
    h('header', { class: 'card-head' }, h('h2', {}, title), description && h('p', {}, description)),
    h('div', { class: 'card-body' }, ...body));
}

const pill = (text, kind = '') => h('span', { class: `pill ${kind}` }, text);
const field = (label, input, hint) => h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input, hint && h('span', { class: 'hint' }, hint));

async function refreshNumbers() {
  const me = await api('/me');
  state.numbers = me.numbers;
}

export async function renderAdmin() {
  const section = route().section;
  const body = h('div', { class: 'admin-page' });
  fill(els.main,
    paneHead('Admin settings', h('div', { style: 'flex:1' }), helpLink({ bulkvs: 'admin-provider', numbers: 'admin-numbers', users: 'admin-users', email: 'admin-email', hours: 'admin-hours', contacts: 'admin-import', blocked: 'admin-blocked', backup: 'admin-backup' }[section] ?? 'admin-provider')),
    h('nav', { class: 'admin-tabs', 'aria-label': 'Admin sections' },
      TABS.map(([id, label]) => h('a', { href: `#/admin/${id}`, class: id === section ? 'on' : '', 'aria-current': id === section ? 'page' : null }, label))),
    body);
  fill(body, h('div', { class: 'hint' }, 'Loading…'));
  try {
    const render = { bulkvs: renderProvider, numbers: renderNumbers, users: renderUsersTab, email: renderEmail, hours: renderHours, contacts: renderContactsAdmin, blocked: renderBlocked, backup: renderBackup }[section] ?? renderProvider;
    const content = await render();
    if (route().view !== 'admin' || route().section !== section) return; // navigated away meanwhile
    fill(body, content);
  } catch (err) {
    fill(body, h('p', { class: 'bad' }, err.message));
  }
}

// ---------- Provider ----------

// What each provider calls its credentials, and how to set it up
const PROVIDER_INFO = {
  bulkvs: {
    intro: 'In the BulkVS portal, open API → API Credentials and copy the REST API username and password/token.',
    userLabel: 'API username',
    passLabel: 'API password / token',
    userType: 'text',
  },
  voipms: {
    intro: 'In the VoIP.ms portal, open Main Menu → SOAP and REST/JSON API. Set an API password, click Enable/Disable API to turn it on, and add this server\'s public IP address under Enabled IP Addresses.',
    userLabel: 'VoIP.ms login email',
    passLabel: 'API password (not your account password)',
    userType: 'email',
  },
};

async function renderProvider() {
  const [overview, webhook, numbers] = await Promise.all([api('/admin/provider'), api('/admin/webhook-log'), api('/admin/numbers')]);
  let chosen = overview.active;

  const result = h('div', { class: 'test-result', role: 'status' });
  const showResult = (r) => fill(result, h('span', { class: r.ok ? 'ok' : 'bad' }, r.ok ? '✓ ' : '✕ ', r.message));
  const choice = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Provider' });
  const formBox = h('div', { class: 'provider-form' });
  const webhookBox = h('div', {});
  const statusRow = h('div', { class: 'status-row' });

  const drawStatus = () => {
    const active = overview.providers[overview.active];
    fill(statusRow, overview.mockMode
      ? pill(`Not connected: mock mode (${active.name} has no credentials)`, 'warn')
      : pill(`Sending through ${active.name}${active.source === 'env' ? ' (from .env)' : ''}`, 'ok'));
  };

  const drawForm = () => {
    const info = PROVIDER_INFO[chosen];
    const st = overview.providers[chosen];
    const username = h('input', { type: info.userType, value: st.username, autocomplete: 'off', spellcheck: false });
    const password = h('input', { type: 'password', autocomplete: 'new-password', placeholder: st.passwordSet ? `Saved (${st.passwordHint}). Leave blank to keep.` : '' });
    const reveal = h('button', { type: 'button', class: 'icon-btn', title: 'Show password', onclick: () => {
      password.type = password.type === 'password' ? 'text' : 'password';
    } }, icon('eye'));
    const isActive = chosen === overview.active;
    fill(result);
    fill(formBox,
      h('p', { class: 'hint' }, info.intro),
      h('div', { class: 'form-grid' },
        field(info.userLabel, username),
        field(info.passLabel, h('div', { class: 'input-with-btn' }, password, reveal))),
      h('p', { class: 'hint' }, 'Leave a field blank to keep the current value. The saved password is never shown.',
        st.source === 'env' ? ' Saving here overrides the values in .env.' : ''),
      chosen === 'voipms' && h('p', { class: 'hint' }, 'VoIP.ms can\'t send group texts or report delivery, so messages show as Sent rather than Delivered. Texts over 160 characters go out as MMS (up to 2,048 characters, 3 attachments).'),
      h('div', { class: 'card-actions' },
        h('button', { class: 'btn primary', onclick: async () => {
          try {
            Object.assign(overview, await api('/admin/provider', { method: 'PUT', body: { provider: chosen, username: username.value, password: password.value } }));
            state.mockMode = overview.mockMode;
            toast(`${st.name} saved${isActive ? '' : ' and now in use'}`);
            drawAll();
            showResult(await api('/admin/provider/test', { method: 'POST', body: { provider: chosen } }));
          } catch (err) {
            showResult({ ok: false, message: err.message });
          }
        } }, isActive ? 'Save' : `Save and use ${st.name}`),
        h('button', { class: 'btn', onclick: async () => {
          fill(result, h('span', { class: 'hint' }, 'Testing…'));
          showResult(await api('/admin/provider/test', { method: 'POST', body: { provider: chosen, username: username.value, password: password.value } }));
        } }, 'Test connection'),
        !isActive && st.username && h('button', { class: 'btn', onclick: async () => {
          Object.assign(overview, await api('/admin/provider/active', { method: 'PUT', body: { provider: chosen } }));
          state.mockMode = overview.mockMode;
          toast(`Now sending through ${st.name}`);
          drawAll();
        } }, `Switch to ${st.name}`),
        st.source === 'admin' && h('button', { class: 'btn danger', onclick: async () => {
          const fallback = st.envConfigured ? 'TextBoss will go back to the credentials in .env.'
            : isActive ? 'TextBoss will stop sending real texts (mock mode) until new credentials are saved.' : '';
          if (!(await confirmDialog('Remove saved credentials?', `The ${st.name} username and password saved here will be deleted. ${fallback}`, 'Remove', { danger: true }))) return;
          Object.assign(overview, await api(`/admin/provider?provider=${chosen}`, { method: 'DELETE' }));
          state.mockMode = overview.mockMode;
          toast('Saved credentials removed');
          drawAll();
        } }, 'Remove saved credentials')),
      result);
  };

  const drawWebhook = () => {
    const url = overview.webhooks[chosen];
    const copy = (text) => h('div', { class: 'copy-line' }, h('code', {}, text),
      h('button', { class: 'btn', onclick: () => navigator.clipboard.writeText(text).then(() => toast('Copied')) }, 'Copy'));
    fill(webhookBox, !url
      ? h('p', { class: 'bad' }, 'WEBHOOK_SECRET is not set on the server, so incoming texts are turned off. Set it in .env and restart.')
      : chosen === 'voipms'
        ? [copy(url),
            h('ol', { class: 'steps' },
              h('li', {}, 'In the VoIP.ms portal open ', h('strong', {}, 'DID Numbers → Manage DIDs'), ' and click the edit (pencil) icon for a number.'),
              h('li', {}, 'Under ', h('strong', {}, 'Message Service (SMS/MMS)'), ', turn on SMS (and MMS), tick ', h('strong', {}, 'SMS URL Callback'), ', and paste the address above. Turning on ', h('strong', {}, 'URL Callback Retry'), ' is safe: TextBoss ignores repeats.'),
              h('li', {}, 'Click ', h('strong', {}, 'Apply changes'), ', repeat for each number, then text one from a cell phone. It should appear in Messages and in the log below.'))]
        : [copy(url),
            h('ol', { class: 'steps' },
              h('li', {}, 'In the BulkVS portal open ', h('strong', {}, 'Messaging → Messaging Webhooks'), '. Enter a name such as "TextBoss" and paste the address above as the ', h('strong', {}, 'Message URL'), ', then click Add.'),
              h('li', {}, 'Open ', h('strong', {}, 'Inbound → DIDs – Manage'), ', click each number, make sure SMS and MMS are enabled, and set its ', h('strong', {}, 'Messaging Webhook'), ' to the one you just made.'),
              h('li', {}, 'Text one of your numbers from a cell phone. It should appear in Messages and in the log below.'))]);
  };

  function drawAll() {
    fill(choice, Object.entries(overview.providers).map(([id, st]) => h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(chosen === id), class: chosen === id ? 'on' : '',
      onclick: () => { chosen = id; drawAll(); },
    }, st.name, id === overview.active && !overview.mockMode ? ' ✓' : '')));
    drawStatus();
    drawForm();
    drawWebhook();
  }
  drawAll();

  const connection = card('Texting provider',
    'TextBoss sends and receives through your BulkVS or VoIP.ms account. Choose one, enter its API credentials, and save.',
    statusRow, choice, formBox);

  const webhookCard = card('Incoming texts',
    'Your provider delivers incoming texts to this address. Without it, you can send but replies never arrive.',
    webhookBox);

  // Simulate
  const simFrom = h('input', { type: 'tel', placeholder: 'e.g. 3125550000' });
  const simTo = h('select', {}, numbers.map((n) => h('option', { value: n.phone }, n.label ? `${n.label} · ${formatPhone(n.phone)}` : formatPhone(n.phone))));
  const simText = h('input', { type: 'text', placeholder: 'Message text' });
  const simulate = card('Test an incoming text',
    'Runs a fake incoming text through the same steps as a real one, including STOP, keywords and the away message. Nothing is sent to your provider.',
    numbers.length
      ? h('div', { class: 'form-grid three' },
          field('From', simFrom), field('To', simTo), field('Message', simText))
      : h('p', { class: 'hint' }, 'Add a number first.'),
    h('div', { class: 'card-actions' }, h('button', { class: 'btn', disabled: !numbers.length, onclick: async () => {
      try {
        await api('/admin/simulate-inbound', { method: 'POST', body: { From: simFrom.value, To: [simTo.value], Message: simText.value } });
        toast('Simulated text received');
        simText.value = '';
      } catch (err) { toast(err.message); }
    } }, 'Simulate')));

  // Log
  const log = card('Recent webhook calls',
    'The raw data your provider sent, newest first. "Not applied" means TextBoss could not match it to a number or understand it.',
    webhook.entries.length
      ? h('div', { class: 'log-list' }, webhook.entries.map((e) => {
          const r = JSON.parse(e.result ?? '{}');
          return h('details', { class: 'log-entry' },
            h('summary', {},
              h('span', { class: 'log-time' }, new Date(e.received_at).toLocaleString()),
              r.blocked ? pill('Blocked sender', '') : r.ok ? pill('Applied', 'ok') : pill(`Not applied: ${r.reason}`, 'warn')),
            h('pre', {}, e.body));
        }))
      : h('p', { class: 'hint' }, 'Nothing received yet.'));

  return [connection, webhookCard, simulate, log];
}

// ---------- Numbers ----------

async function renderNumbers() {
  const numbers = await api('/admin/numbers');
  const phone = h('input', { type: 'tel', placeholder: '3105551212' });
  const label = h('input', { type: 'text', placeholder: 'e.g. Front desk' });

  const activeCount = numbers.filter((n) => n.active).length;
  return card('Phone numbers',
    'Your phone numbers from BulkVS or VoIP.ms. Untick Active to hide a number everywhere in TextBoss; with only one active number, the number selector disappears. Texts that arrive on an inactive number are still saved.',
    numbers.length
      ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Active'), h('th', {}, 'Number'), h('th', {}, 'Label'), h('th', { class: 'right' }, 'Actions'))),
          h('tbody', {}, numbers.map((n) => {
            const input = h('input', { type: 'text', value: n.label, 'aria-label': `Label for ${formatPhone(n.phone)}` });
            const active = h('input', {
              type: 'checkbox',
              class: 'switch',
              checked: n.active,
              'aria-label': `${formatPhone(n.phone)} active`,
              onchange: async () => {
                if (!active.checked && activeCount === 1 && n.active) {
                  active.checked = true;
                  return toast('Keep at least one number active');
                }
                await api(`/admin/numbers/${n.id}`, { method: 'PATCH', body: { active: active.checked } });
                await refreshNumbers();
                toast(active.checked ? `${formatPhone(n.phone)} is active` : `${formatPhone(n.phone)} is hidden`);
                renderAdmin();
              },
            });
            return h('tr', { class: n.active ? '' : 'inactive' },
              h('td', {}, active),
              h('td', { class: 'nowrap strong' }, formatPhone(n.phone)),
              h('td', {}, input),
              h('td', {}, h('div', { class: 'row-actions' },
                h('button', { class: 'btn', onclick: async () => {
                  await api(`/admin/numbers/${n.id}`, { method: 'PATCH', body: { label: input.value } });
                  await refreshNumbers();
                  toast('Saved');
                } }, 'Save'),
                h('button', { class: 'btn danger', onclick: async () => {
                  if (!(await confirmDialog(`Remove ${formatPhone(n.phone)}?`, 'Its conversations and messages will be deleted from TextBoss. The number stays in your provider account.', 'Remove', { danger: true }))) return;
                  await api(`/admin/numbers/${n.id}`, { method: 'DELETE' });
                  await refreshNumbers();
                  renderAdmin();
                } }, 'Remove'))));
          }))))
      : h('p', { class: 'empty-note' }, 'No numbers yet. Add your first number below.'),
    h('div', { class: 'subsection' },
      h('h3', {}, 'Add a number'),
      h('div', { class: 'form-grid three' }, field('Phone number', phone), field('Label', label),
        h('div', { class: 'field align-end' }, h('button', { class: 'btn primary', onclick: async () => {
          try {
            await api('/admin/numbers', { method: 'POST', body: { phone: phone.value, label: label.value } });
            await refreshNumbers();
            toast('Number added');
            renderAdmin();
          } catch (err) { toast(err.message); }
        } }, 'Add number')))));
}

// ---------- Users ----------

async function renderUsersTab() {
  const [list, security, users] = await Promise.all([renderUsers(), api('/admin/security'), api('/admin/users')]);
  return [securityPolicyCard(security, users), list];
}

async function renderUsers() {
  const [users, numbers, security] = await Promise.all([api('/admin/users'), api('/admin/numbers'), api('/admin/security')]);

  const numberChecks = (selected = []) =>
    h('div', { class: 'checks' }, numbers.length
      ? numbers.map((n) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'numberIds', value: String(n.id), checked: selected.includes(n.id) }), n.label ? `${n.label} · ${formatPhone(n.phone)}` : formatPhone(n.phone)))
      : h('span', { class: 'hint' }, 'Add numbers first.'));

  const userDialog = (u) => dialog(
    u ? `Edit ${u.displayName}` : 'Add user',
    [
      !u && h('label', {}, 'Username', h('input', { type: 'text', name: 'username', required: true, autocomplete: 'off' })),
      h('label', {}, 'Display name', h('input', { type: 'text', name: 'displayName', value: u?.displayName ?? '' })),
      h('label', {}, u ? 'Email (for password resets and emailed sign-in codes)' : 'Email (required: for password resets and sign-in codes)', h('input', { type: 'email', name: 'email', value: u?.email ?? '', required: !u, autocomplete: 'off' })),
      h('label', {}, u ? 'New password (leave blank to keep)' : 'Password', h('input', { type: 'password', name: 'password', required: !u, minLength: 10, autocomplete: 'new-password' })),
      h('p', { class: 'hint' }, 'At least 10 characters, not a common password, and not your name. A few unrelated words work well.'),
      h('label', {}, 'Confirm password', h('input', { type: 'password', name: 'confirm', required: !u, autocomplete: 'new-password' })),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'isAdmin', checked: !!u?.isAdmin }), 'Admin: sees every number and can change these settings'),
      h('div', { class: 'field-label' }, 'Numbers this user can use'), numberChecks(u?.numberIds),
    ],
    u ? 'Save' : 'Add user',
    async (data) => {
      if ((data.get('password') || data.get('confirm')) && data.get('password') !== data.get('confirm')) throw new Error('The two passwords don\'t match');
      const body = { displayName: data.get('displayName'), email: data.get('email'), isAdmin: data.get('isAdmin') === 'on', numberIds: data.getAll('numberIds').map(Number) };
      if (data.get('password')) body.password = data.get('password');
      if (u) await api(`/admin/users/${u.id}`, { method: 'PATCH', body });
      else await api('/admin/users', { method: 'POST', body: { ...body, username: data.get('username') } });
      toast(u ? 'User updated' : 'User added');
      renderAdmin();
    },
  );

  return card('Users',
    'Who can sign in, and which numbers each person can see and send from. Contacts, lists and canned responses are shared by everyone.',
    h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Username'), h('th', {}, 'Access'), h('th', {}, 'Two-factor'), h('th', { class: 'right' }, 'Actions'))),
      h('tbody', {}, users.map((u) => h('tr', {},
        h('td', { class: 'strong' }, u.displayName, u.id === state.me.id && h('span', { class: 'hint' }, ' (you)')),
        h('td', {}, u.username, u.email ? h('div', { class: 'hint' }, u.email) : h('div', { class: 'hint' }, 'No email')),
        h('td', {}, u.isAdmin ? pill('Admin · all numbers', 'accent') : u.numberIds.length ? u.numberIds.map(numberLabel).join(', ') : pill('No numbers', 'warn')),
        h('td', {}, u.mfa.totp || u.mfa.passkeys
          ? pill([u.mfa.totp && 'App', u.mfa.passkeys && `${u.mfa.passkeys} passkey${u.mfa.passkeys > 1 ? 's' : ''}`].filter(Boolean).join(' + '), 'ok')
          : pill('Off', security.require2fa ? 'warn' : '')),
        h('td', {}, h('div', { class: 'row-actions' },
          h('button', { class: 'btn', onclick: () => userDialog(u) }, 'Edit'),
          (u.mfa.totp || u.mfa.passkeys > 0) && u.id !== state.me.id && h('button', { class: 'btn', title: 'For a lost phone or security key', onclick: async () => {
            if (!(await confirmDialog(`Reset two-factor for ${u.displayName}?`, 'Their authenticator app and passkeys are removed and they are signed out everywhere. They sign in with just their password and set two-factor up again' + (security.require2fa ? ' (required).' : '.'), 'Reset', { danger: true }))) return;
            await api(`/admin/users/${u.id}/reset-2fa`, { method: 'POST' });
            toast(`Two-factor reset for ${u.displayName}`);
            renderAdmin();
          } }, 'Reset 2FA'),
          u.id !== state.me.id && h('button', { class: 'btn danger', onclick: async () => {
            if (!(await confirmDialog(`Delete ${u.displayName}?`, 'They will no longer be able to sign in. Messages they sent are kept.', 'Delete', { danger: true }))) return;
            await api(`/admin/users/${u.id}`, { method: 'DELETE' });
            renderAdmin();
          } }, 'Delete')))))))),
    h('div', { class: 'card-actions' }, h('button', { class: 'btn primary', onclick: () => userDialog(null) }, 'Add user')));
}

function securityPolicyCard(security, users) {
  const missing = users.filter((u) => !u.mfa.totp && !u.mfa.passkeys);
  const toggle = h('input', { type: 'checkbox', class: 'switch', checked: security.require2fa, onchange: async () => {
    try {
      await api('/admin/security', { method: 'PUT', body: { require2fa: toggle.checked } });
      toast(toggle.checked ? 'Two-factor sign-in is now required' : 'Two-factor sign-in is now optional');
      renderAdmin();
    } catch (err) {
      toggle.checked = !toggle.checked;
      toast(err.message);
    }
  } });
  return card('Sign-in security',
    'Two-factor sign-in asks for a code from an authenticator app or a passkey (Face ID, Touch ID, Windows Hello, a security key) after the password. Each person sets it up under ⋮ → Security.',
    h('label', { class: 'switch-label' }, toggle,
      h('span', {}, h('strong', {}, 'Require two-factor sign-in for everyone'),
        h('span', { class: 'hint' }, ' — people without it are taken through setup the next time they use TextBoss.'))),
    !security.require2fa && h('label', { class: 'switch-label' },
      h('input', { type: 'checkbox', class: 'switch', checked: security.remind2fa, onchange: async (e) => {
        try {
          await api('/admin/security', { method: 'PUT', body: { remind2fa: e.target.checked } });
          toast(e.target.checked ? 'Reminders are on' : 'Reminders are off');
        } catch (err) {
          e.target.checked = !e.target.checked;
          toast(err.message);
        }
      } }),
      h('span', {}, h('strong', {}, 'Remind people who haven\'t set it up'),
        h('span', { class: 'hint' }, ' — a banner in the app they can snooze for a day, and a daily email if they have an email address (Admin settings → Email). Starts a day after their account is created.'))),
    missing.length > 0 && h('p', { class: 'hint' }, `Not set up yet: ${missing.map((u) => u.displayName).join(', ')}.`),
    h('p', { class: 'hint' }, 'Someone without their phone or key can get an emailed code instead, if their email is saved and email is set up (Admin settings → Email). Otherwise use Reset 2FA next to their name. Failed sign-ins lock that username for 15 minutes after 8 wrong passwords or 6 wrong codes.'));
}

// ---------- Office hours ----------

const DAY_NAMES = [['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'], ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday']];

// Common US office holidays falling in the next 12 months
function usHolidays(from = new Date()) {
  const out = [];
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const nth = (y, m, weekday, n) => { // n-th weekday of month (n = -1: last)
    if (n > 0) {
      const d = new Date(y, m, 1);
      d.setDate(1 + ((weekday - d.getDay() + 7) % 7) + (n - 1) * 7);
      return d;
    }
    const d = new Date(y, m + 1, 0);
    d.setDate(d.getDate() - ((d.getDay() - weekday + 7) % 7));
    return d;
  };
  for (const y of [from.getFullYear(), from.getFullYear() + 1]) {
    out.push(['New Year\'s Day', new Date(y, 0, 1)], ['Memorial Day', nth(y, 4, 1, -1)], ['Independence Day', new Date(y, 6, 4)],
      ['Labor Day', nth(y, 8, 1, 1)], ['Thanksgiving', nth(y, 10, 4, 4)], ['Christmas Day', new Date(y, 11, 25)]);
  }
  const end = new Date(from);
  end.setFullYear(end.getFullYear() + 1);
  const today = iso(from);
  return out.filter(([, d]) => iso(d) >= today && d <= end).map(([name, d]) => ({ from: iso(d), to: iso(d), name, message: '' }));
}

async function renderHours() {
  const data = await api('/admin/hours');
  const cfg = structuredClone(data.config);
  // First time: the server's zone is often UTC (Docker), so start from this browser's
  if (!data.saved) cfg.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || cfg.timezone;
  const fmt = (ts) => ts ? new Date(ts).toLocaleString([], { timeZone: cfg.timezone, weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';
  const statusPill = (st) => !st.enabled ? pill('Schedule off', '')
    : st.open ? pill(`Open now${st.until ? ` · closes ${fmt(st.until)}` : ''}`, 'ok')
    : pill(`Closed now${st.closure ? ` (${st.closure.name || 'closure'})` : ''}${st.until ? ` · opens ${fmt(st.until)}` : ''}`, 'warn');
  const statusRow = h('div', { class: 'status-row' }, statusPill(data.status));

  const enabled = h('input', { type: 'checkbox', class: 'switch', checked: cfg.enabled });
  const zones = (Intl.supportedValuesOf?.('timeZone') ?? [cfg.timezone]).filter((z) => /^(America|Pacific\/Honolulu|US\/)/.test(z) || z === cfg.timezone);
  const tz = h('select', {}, zones.map((z) => h('option', { value: z, selected: z === cfg.timezone }, z.replace(/_/g, ' '))));
  tz.addEventListener('change', () => (cfg.timezone = tz.value));
  const message = h('textarea', { rows: 3, maxlength: 1600 }, cfg.message);

  // Weekly hours
  const weekBox = h('div', { class: 'hours-week' });
  const timeInput = (value, onchange) => h('input', { type: 'time', value, step: 300, onchange: (e) => onchange(e.target.value) });
  const drawWeek = () => fill(weekBox, DAY_NAMES.map(([d, name]) => {
    const ranges = cfg.week[d];
    const open = h('input', { type: 'checkbox', checked: ranges.length > 0, onchange: (e) => {
      cfg.week[d] = e.target.checked ? [{ start: '08:00', end: '17:00' }] : [];
      drawWeek();
    } });
    return h('div', { class: 'hours-day' },
      h('label', { class: 'check hours-name' }, open, name),
      h('div', { class: 'hours-ranges' },
        ranges.length ? ranges.map((r, i) => h('div', { class: 'hours-range' },
          timeInput(r.start, (v) => (r.start = v)), h('span', { class: 'hint' }, 'to'), timeInput(r.end, (v) => (r.end = v)),
          ranges.length > 1 && h('button', { type: 'button', class: 'icon-btn', title: 'Remove these hours', onclick: () => { ranges.splice(i, 1); drawWeek(); } }, icon('close'))))
          : h('span', { class: 'hint' }, 'Closed all day'),
        ranges.length > 0 && ranges.length < 3 && h('button', { type: 'button', class: 'link-btn', onclick: () => {
          const last = ranges.at(-1);
          ranges.push({ start: last.end < '13:00' ? '13:00' : last.end, end: '17:00' });
          drawWeek();
        } }, '+ Add hours (e.g. after lunch)')));
  }));
  drawWeek();
  const copyMonday = h('button', { type: 'button', class: 'btn', onclick: () => {
    for (const d of ['tue', 'wed', 'thu', 'fri']) cfg.week[d] = structuredClone(cfg.week.mon);
    drawWeek();
    toast('Monday\'s hours copied to Tuesday–Friday');
  } }, 'Copy Monday to weekdays');

  // Closures
  const closureBox = h('div', {});
  const drawClosures = () => fill(closureBox, cfg.closures.length
    ? h('div', { class: 'table-wrap' }, h('table', { class: 'table compact closures' },
        h('thead', {}, h('tr', {}, ['Name', 'From', 'To', 'Message (optional)', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, cfg.closures.map((c, i) => h('tr', {},
          h('td', {}, h('input', { type: 'text', value: c.name, placeholder: 'e.g. Christmas', oninput: (e) => (c.name = e.target.value) })),
          h('td', {}, h('input', { type: 'date', value: c.from, onchange: (e) => { c.from = e.target.value; if (!c.to || c.to < c.from) { c.to = c.from; drawClosures(); } } })),
          h('td', {}, h('input', { type: 'date', value: c.to, onchange: (e) => (c.to = e.target.value) })),
          h('td', {}, h('input', { type: 'text', value: c.message, placeholder: 'Uses the after-hours reply', oninput: (e) => (c.message = e.target.value) })),
          h('td', {}, h('button', { type: 'button', class: 'icon-btn', title: 'Remove', onclick: () => { cfg.closures.splice(i, 1); drawClosures(); } }, icon('close'))))))))
    : h('p', { class: 'empty-note' }, 'No closures yet.'));
  drawClosures();
  const today = new Date().toLocaleDateString('en-CA');
  const addClosure = h('button', { type: 'button', class: 'btn', onclick: () => {
    cfg.closures.push({ from: today, to: today, name: '', message: '' });
    drawClosures();
  } }, icon('plus'), 'Add a closure');
  const addHolidays = h('button', { type: 'button', class: 'btn', onclick: () => {
    const have = new Set(cfg.closures.map((c) => c.from));
    const add = usHolidays().filter((x) => !have.has(x.from));
    cfg.closures.push(...add);
    cfg.closures.sort((a, b) => a.from.localeCompare(b.from));
    drawClosures();
    toast(add.length ? `Added ${add.length} holidays. Remove any you stay open for, then Save.` : 'Those holidays are already listed');
  } }, 'Add US holidays (next 12 months)');

  const result = h('div', { class: 'test-result', role: 'status' });
  const save = h('button', { class: 'btn primary', onclick: async () => {
    try {
      const r = await api('/admin/hours', { method: 'PUT', body: { ...cfg, enabled: enabled.checked, message: message.value } });
      Object.assign(cfg, structuredClone(r.config));
      fill(statusRow, statusPill(r.status));
      fill(result);
      drawWeek();
      drawClosures();
      toast('Office hours saved');
    } catch (err) {
      fill(result, h('span', { class: 'bad' }, '✕ ', err.message));
    }
  } }, 'Save');

  return [
    card('After-hours auto-reply',
      'When a client texts while the office is closed, TextBoss replies automatically, once per conversation until you reopen. Keyword replies still work any time. Group texts and opted-out clients never get auto-replies.',
      statusRow,
      data.away && h('p', { class: 'callout warn' }, icon('warning'), h('span', {}, 'The away message is switched on under Canned responses, so it is sent instead of the after-hours reply. Turn it off there to use this schedule.')),
      h('label', { class: 'switch-label' }, enabled, h('span', {}, h('strong', {}, 'Reply automatically outside office hours'))),
      h('div', { class: 'form-grid' }, field('Time zone', tz), h('div')),
      field('After-hours reply', message, 'Merge fields work here: {first_name}, {last_name}, {full_name}, {nickname}.')),
    card('Office hours',
      'Times are in the time zone above. Add a second set of hours for a lunch break.',
      weekBox,
      h('div', { class: 'card-actions' }, copyMonday)),
    card('Holidays and closures',
      'Closed all day on these dates, whatever the weekly hours say. Give one its own message to mention when you reopen.',
      closureBox,
      h('div', { class: 'card-actions' }, addClosure, addHolidays)),
    h('div', { class: 'card-actions sticky-save' }, save, result),
  ];
}

// ---------- Email ----------

const SMTP_PRESETS = [
  ['Google Workspace / Gmail', 'smtp.gmail.com', 587, 'starttls'],
  ['Microsoft 365 / Outlook', 'smtp.office365.com', 587, 'starttls'],
  ['iCloud Mail', 'smtp.mail.me.com', 587, 'starttls'],
];

async function renderEmail() {
  const s = await api('/admin/email');
  const host = h('input', { type: 'text', value: s.host, placeholder: 'smtp.example.com', autocomplete: 'off', spellcheck: false });
  const port = h('input', { type: 'number', value: s.port, min: 1, max: 65535 });
  const security = h('select', {},
    [['starttls', 'STARTTLS (usually port 587)'], ['tls', 'SSL/TLS (usually port 465)'], ['none', 'None (local relay only)']]
      .map(([v, label]) => h('option', { value: v, selected: s.security === v }, label)));
  const username = h('input', { type: 'text', value: s.username, autocomplete: 'off', spellcheck: false });
  const password = h('input', { type: 'password', autocomplete: 'new-password', placeholder: s.hasPassword ? 'Saved. Leave blank to keep.' : '' });
  const from = h('input', { type: 'text', value: s.from, placeholder: 'TextBoss <textboss@yourcompany.com>', spellcheck: false });
  const testTo = h('input', { type: 'email', placeholder: 'you@example.com' });
  const result = h('div', { class: 'test-result', role: 'status' });
  const showResult = (ok, message) => fill(result, h('span', { class: ok ? 'ok' : 'bad' }, ok ? '✓ ' : '✕ ', message));

  const presets = h('div', { class: 'row-actions left' }, SMTP_PRESETS.map(([name, hst, prt, sec]) => h('button', { type: 'button', class: 'btn', onclick: () => {
    host.value = hst;
    port.value = prt;
    security.value = sec;
  } }, name)));

  const smtp = card('Sending email',
    'TextBoss emails people a code when they use "Forgot password?" or don\'t have their passkey or authenticator app with them. Use any email account\'s SMTP settings.',
    h('div', { class: 'status-row' }, s.configured ? pill('Set up', 'ok') : pill('Not set up: "Forgot password?" is hidden', 'warn')),
    h('div', { class: 'field-label' }, 'Fill in for'), presets,
    h('div', { class: 'form-grid' },
      field('SMTP server', host),
      field('Port', port),
      field('Security', security),
      h('div'),
      field('Username', username, 'Usually the full email address'),
      field('Password', password, 'For Google, Microsoft and iCloud this is an app password, not the normal one'),
      field('Send from', from, 'Must be an address this account is allowed to send as'),
    ),
    h('div', { class: 'card-actions' },
      h('button', { class: 'btn primary', onclick: async () => {
        try {
          await api('/admin/email', { method: 'PUT', body: { host: host.value, port: port.value, security: security.value, username: username.value, password: password.value, from: from.value } });
          password.value = '';
          toast('Email settings saved');
          renderAdmin();
        } catch (err) {
          showResult(false, err.message);
        }
      } }, 'Save'),
      s.configured && h('button', { class: 'btn danger', onclick: async () => {
        if (!(await confirmDialog('Remove email settings?', '"Forgot password?" and emailed sign-in codes will stop working until new settings are saved.', 'Remove', { danger: true }))) return;
        await api('/admin/email', { method: 'DELETE' });
        toast('Email settings removed');
        renderAdmin();
      } }, 'Remove')),
    result);

  const result2 = h('div', { class: 'test-result', role: 'status' });
  const test = s.configured && card('Send a test',
    'Check that email arrives (look in spam too). Save any changes above first.',
    h('div', { class: 'input-with-btn' }, testTo,
      h('button', { class: 'btn', onclick: async (e) => {
        e.target.disabled = true;
        fill(result2, h('span', { class: 'hint' }, 'Sending…'));
        try {
          await api('/admin/email/test', { method: 'POST', body: { to: testTo.value } });
          fill(result2, h('span', { class: 'ok' }, `✓ Sent to ${testTo.value}`));
        } catch (err) {
          fill(result2, h('span', { class: 'bad' }, `✕ ${err.message}`));
        } finally {
          e.target.disabled = false;
        }
      } }, 'Send test')));
  if (test) test.querySelector('.card-body').append(result2);

  const users = await api('/admin/users');
  const missing = users.filter((u) => !u.email);
  const people = card('Staff email addresses',
    'Each person can add their own under ⋮ → My account, or you can add them under Users → Edit.',
    missing.length
      ? h('p', { class: 'hint' }, `No email yet: ${missing.map((u) => u.displayName).join(', ')}. They can't reset their own password or get emailed codes.`)
      : h('p', { class: 'ok' }, '✓ Everyone has an email address.'));

  return [smtp, test, people];
}

// ---------- Contacts & import ----------

const FIELD_NAMES = { firstName: 'First name', lastName: 'Last name', nickname: 'Nickname', phone: 'Phone', dob: 'Date of birth', email: 'Email', patientId: 'Client ID', notes: 'Notes' };
const showValue = (field, v) => (field === 'phone' ? formatPhone(v) : field === 'dob' ? formatDob(v) : v) || '(empty)';

function csvDownload(filename, rows) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const blob = new Blob([rows.map((r) => r.map(esc).join(',')).join('\r\n')], { type: 'text/csv' });
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  a.remove();
}

function stat(label, value, kind = '') {
  return h('div', { class: `stat ${kind}` }, h('div', { class: 'stat-value' }, value.toLocaleString()), h('div', { class: 'stat-label' }, label));
}

// Checkbox list of clients missing from an import, all ticked to start
function missingPicker(list) {
  const checks = list.map((m) => h('input', { type: 'checkbox', checked: true, value: String(m.id) }));
  const count = h('span', { class: 'hint' });
  const sync = () => (count.textContent = `${checks.filter((c) => c.checked).length.toLocaleString()} of ${list.length.toLocaleString()} ticked`);
  checks.forEach((c) => c.addEventListener('change', sync));
  const all = (on) => () => { checks.forEach((c) => (c.checked = on)); sync(); };
  sync();
  const el = h('div', { class: 'missing-picker' },
    h('div', { class: 'row-actions left' },
      h('button', { type: 'button', class: 'link-btn', onclick: all(true) }, 'Tick all'),
      h('button', { type: 'button', class: 'link-btn', onclick: all(false) }, 'Untick all'),
      count),
    h('div', { class: 'table-wrap scroll' }, h('table', { class: 'table compact' },
      h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Name'), h('th', {}, 'Client ID'), h('th', {}, 'Phone'))),
      h('tbody', {}, list.map((m, i) => h('tr', {},
        h('td', {}, checks[i]),
        h('td', { class: 'strong nowrap' }, h('a', { href: `#/contacts/${m.id}` }, m.name)),
        h('td', {}, m.patientId), h('td', { class: 'nowrap' }, m.phone ? formatPhone(m.phone) : '')))))));
  return { el, ids: () => checks.filter((c) => c.checked).map((c) => Number(c.value)) };
}

function importReport(file, r, onConfirm) {
  const used = r.columns.filter((c) => c.field);
  const ignored = r.columns.filter((c) => !c.field);
  const base = file.name.replace(/\.[^.]+$/, '');
  let picker = null;
  let inactivate = null;
  const inactivateIds = () => (inactivate?.checked ? picker.ids() : []);

  return h('div', { class: 'import-report' },
    h('div', { class: 'import-file' }, h('strong', {}, file.name), ` · ${r.rows.toLocaleString()} rows read`),
    h('div', { class: 'stats' },
      stat('New', r.created, r.created ? 'ok' : ''),
      stat('Updated', r.updated, r.updated ? 'accent' : ''),
      stat('Unchanged', r.unchanged),
      stat('Skipped', r.skipped),
      stat('Problems', r.issueCount, r.issueCount ? 'warn' : ''),
      r.fullList && stat('Not in file', r.missingCount, r.missingCount ? 'warn' : '')),
    r.reactivated > 0 && h('p', { class: 'hint' }, `${r.reactivated.toLocaleString()} inactive contact${r.reactivated === 1 ? ' is' : 's are'} in this file and will become active again.`),

    r.fullList && r.missingCount > 0 && (() => {
      picker = missingPicker(r.missing);
      inactivate = h('input', { type: 'checkbox', class: 'switch', checked: true });
      return h('div', { class: 'subsection' },
        h('div', { class: 'subsection-head' },
          h('h3', {}, `In TextBoss but not in this file (${r.missingCount.toLocaleString()})`),
          h('button', { class: 'btn', onclick: () => csvDownload(`${base}-not-in-file.csv`, [
            ['Name', 'Client ID', 'Phone'], ...r.missing.map((m) => [m.name, m.patientId, m.phone]),
          ]) }, icon('download'), 'Download as CSV')),
        h('p', { class: 'hint' }, 'Clients with a client ID who aren\'t in this export, for example discharged clients. Inactive contacts are hidden from Contacts and searches but keep their conversations, and become active again if they text or show up in a later import.'),
        r.missingCount > r.activeWithId * 0.5 && h('p', { class: 'callout warn' }, icon('warning'), h('span', {}, `That's more than half of your active clients. Make sure this file is the full list of current clients, not a partial export.`)),
        h('label', { class: 'switch-label' }, inactivate, h('span', {}, h('strong', {}, 'Mark the ticked contacts inactive'))),
        picker.el,
        r.missing.length < r.missingCount && h('p', { class: 'hint' }, `Showing the first ${r.missing.length.toLocaleString()}.`));
    })(),

    r.issueCount > 0 && h('div', { class: 'subsection' },
      h('div', { class: 'subsection-head' },
        h('h3', {}, `Problems to fix (${r.issueCount.toLocaleString()})`),
        h('button', { class: 'btn', onclick: () => csvDownload(`${base}-problems.csv`, [
          ['Row', 'Name', 'Client ID', 'Field', 'Value', 'Problem'],
          ...r.issues.map((x) => [x.row, x.name, x.patientId, x.field, x.value, x.problem]),
        ]) }, icon('download'), 'Download as CSV')),
      h('p', { class: 'hint' }, 'These contacts are still imported, just without the bad value (an existing good value is kept). Fix them in your client software and the next import will fill them in. Row numbers match the spreadsheet.'),
      h('div', { class: 'table-wrap scroll' }, h('table', { class: 'table compact' },
        h('thead', {}, h('tr', {}, ['Row', 'Name', 'Client ID', 'Field', 'Value', 'Problem'].map((t) => h('th', {}, t)))),
        h('tbody', {}, r.issues.map((x) => h('tr', {},
          h('td', { class: 'num' }, x.row), h('td', { class: 'strong nowrap' }, x.name), h('td', {}, x.patientId),
          h('td', {}, x.field), h('td', {}, h('code', {}, x.value || '(empty)')), h('td', { class: 'muted' }, x.problem)))))),
      r.issues.length < r.issueCount && h('p', { class: 'hint' }, `Showing the first ${r.issues.length.toLocaleString()}.`)),

    r.changeCount > 0 && h('div', { class: 'subsection' },
      h('div', { class: 'subsection-head' },
        h('h3', {}, `What will change (${r.changeCount.toLocaleString()} contacts)`),
        h('button', { class: 'btn', onclick: () => csvDownload(`${base}-changes.csv`, [
          ['Row', 'Name', 'Client ID', 'Field', 'Old', 'New'],
          ...r.changes.flatMap((c) => c.diff.map((d) => [c.row, c.name, c.patientId, FIELD_NAMES[d.field] ?? d.field, d.from, d.to])),
        ]) }, icon('download'), 'Download as CSV')),
      h('div', { class: 'table-wrap scroll' }, h('table', { class: 'table compact' },
        h('thead', {}, h('tr', {}, ['Row', 'Name', 'Change'].map((t) => h('th', {}, t)))),
        h('tbody', {}, r.changes.map((c) => h('tr', {},
          h('td', { class: 'num' }, c.row), h('td', { class: 'strong nowrap' }, c.name),
          h('td', {}, c.diff.map((d) => h('div', { class: 'diff' },
            h('span', { class: 'muted' }, `${FIELD_NAMES[d.field] ?? d.field}: `),
            h('del', {}, showValue(d.field, d.from)), ' → ', h('ins', {}, showValue(d.field, d.to))))))))))),

    h('details', { class: 'columns' }, h('summary', {}, `Columns used (${used.length})${ignored.length ? `, ignored (${ignored.length})` : ''}`),
      h('p', { class: 'hint' }, used.map((c) => `${c.header} → ${FIELD_NAMES[c.field] ?? c.field}`).join(' · ')),
      ignored.length > 0 && h('p', { class: 'hint' }, 'Ignored: ', ignored.map((c) => c.header).join(', '))),

    h('div', { class: 'card-actions' },
      h('button', { class: 'btn primary', disabled: !r.created && !r.updated && !r.reactivated && !r.missingCount, onclick: (e) => onConfirm(e, inactivateIds()) },
        r.created || r.updated || r.reactivated || r.missingCount ? `Import: ${r.created} new, ${r.updated} updated` : 'Nothing new to import'),
      h('button', { class: 'btn', onclick: () => renderAdmin() }, 'Cancel')));
}

async function renderContactsAdmin() {
  const [imports, keys] = await Promise.all([api('/admin/imports'), api('/admin/api-keys')]);

  const report = h('div', {});
  const fileInput = h('input', { type: 'file', accept: '.xls,.xlsx,.csv', hidden: true });
  const drop = h('div', { class: 'dropzone', tabindex: 0, role: 'button', onclick: () => fileInput.click(),
    onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && fileInput.click() },
    h('strong', {}, 'Choose a file'), ' or drag it here', h('div', { class: 'hint' }, '.xls, .xlsx or .csv, such as a client list exported from your scheduling software'));

  const handle = async (f) => {
    if (!f) return;
    fill(report, h('p', { class: 'hint' }, `Reading ${f.name}…`));
    const send = (dryRun) => api(`/admin/import${dryRun ? '?dryRun=1' : ''}`, { method: 'POST', raw: f, headers: { 'X-Filename': f.name } });
    try {
      const r = await send(true);
      drop.hidden = true;
      fill(report, importReport(f, r, async (e, inactivateIds) => {
        e.target.disabled = true;
        try {
          const done = await send(false);
          const off = inactivateIds.length
            ? (await api('/contacts/status', { method: 'POST', body: { ids: inactivateIds, inactive: true, reason: 'import' } })).changed
            : 0;
          toast(`Imported: ${done.created} new, ${done.updated} updated${off ? `, ${off} marked inactive` : ''}`);
          renderAdmin();
        } catch (err) {
          toast(err.message);
          e.target.disabled = false;
        }
      }));
    } catch (err) {
      fill(report, h('p', { class: 'bad' }, err.message));
    }
  };
  fileInput.addEventListener('change', () => { handle(fileInput.files[0]); fileInput.value = ''; });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); handle(e.dataTransfer.files[0]); });

  const upload = card('Import contacts from a file',
    'You will see what would change before anything is saved. Clients are matched by client ID, so importing the full list again updates changed details (like a new phone number) instead of making duplicates. Imports never delete contacts or clear notes.',
    drop, fileInput, report);

  const folder = card('Watched folder',
    'Save exports into this folder on the server and they are imported automatically within a minute, then moved into processed/ or failed/.',
    h('div', { class: 'copy-line' }, h('code', {}, imports.folder)),
    h('p', { class: 'hint' }, 'With Docker this is the import/ folder next to compose.yaml.'));

  const history = card('Import history', 'The last 30 imports from any source.',
    imports.entries.length
      ? h('div', { class: 'table-wrap' }, h('table', { class: 'table compact' },
          h('thead', {}, h('tr', {}, ['When', 'Source', 'File', 'New', 'Updated', 'Skipped', 'Problems', 'Not in file'].map((t) => h('th', {}, t)))),
          h('tbody', {}, imports.entries.map((e) => h('tr', {},
            h('td', { class: 'nowrap' }, relTime(e.created_at)), h('td', {}, e.source), h('td', { class: 'clip' }, e.filename ?? ''),
            ...(e.error
              ? [h('td', { colspan: 5, class: 'bad' }, e.error)]
              : [h('td', { class: 'num' }, e.created), h('td', { class: 'num' }, e.updated), h('td', { class: 'num' }, e.skipped), h('td', { class: `num nowrap${e.issues ? ' warn-text' : ''}` }, e.issues ?? 0,
                    e.has_problems ? h('button', { class: 'link-btn', style: 'margin-left:8px', onclick: () => showProblems(e) }, 'View') : null),
                  h('td', { class: 'num nowrap' }, e.missing == null ? '' : e.missing,
                    e.reviewable ? h('button', { class: 'link-btn', style: 'margin-left:8px', onclick: () => reviewMissing(e) }, 'Review') : null)]))))))
      : h('p', { class: 'hint' }, 'No imports yet.'));

  const origin = location.origin;
  const apiCard = card('Import API',
    'Lets other software push contacts into TextBoss. Each key is shown once when it is created; revoke it if it leaks.',
    keys.length
      ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
          h('thead', {}, h('tr', {}, ['Name', 'Key', 'Last used', ''].map((t) => h('th', {}, t)))),
          h('tbody', {}, keys.map((k) => h('tr', {},
            h('td', { class: 'strong' }, k.name), h('td', {}, h('code', {}, `${k.prefix}…`)),
            h('td', {}, k.lastUsedAt ? relTime(k.lastUsedAt) : 'Never'),
            h('td', {}, h('div', { class: 'row-actions' }, h('button', { class: 'btn danger', onclick: async () => {
              if (!(await confirmDialog(`Revoke "${k.name}"?`, 'Anything using this key will stop being able to import contacts.', 'Revoke', { danger: true }))) return;
              await api(`/admin/api-keys/${k.id}`, { method: 'DELETE' });
              renderAdmin();
            } }, 'Revoke'))))))))
      : h('p', { class: 'empty-note' }, 'No API keys yet.'),
    h('div', { class: 'card-actions' }, h('button', { class: 'btn primary', onclick: () => dialog('Create API key',
      h('label', {}, 'Name (what will use it)', h('input', { type: 'text', name: 'name', required: true, placeholder: 'e.g. Client list sync' })),
      'Create', async (data) => {
        const { key } = await api('/admin/api-keys', { method: 'POST', body: { name: data.get('name') } });
        dialog('Copy your API key now', [
          h('p', { class: 'dialog-text' }, 'This is the only time the full key is shown.'),
          h('div', { class: 'copy-line' }, h('code', {}, key),
            h('button', { type: 'button', class: 'btn', onclick: () => navigator.clipboard.writeText(key).then(() => toast('Copied')) }, 'Copy')),
        ], null, () => {});
        renderAdmin();
      }) }, 'Create API key')),
    h('details', {}, h('summary', {}, 'How to use the API'),
      h('pre', { class: 'code-block' },
`# JSON (fields: firstName, lastName, phone, dob, email, patientId, notes, optedOut)
curl -X POST ${origin}/api/v1/contacts \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"contacts":[{"firstName":"Jane","lastName":"Doe","phone":"5415550100","dob":"1980-01-31","patientId":"12345"}]}'

# Or send a spreadsheet export as-is
curl -X POST ${origin}/api/v1/contacts \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -H "Content-Type: application/vnd.ms-excel" \\
  --data-binary @ClientReport.xls

# Add ?dryRun=1 to see what would change without saving.`)));

  return [upload, latestProblemsCard(imports.entries), folder, await inactiveCard(), history, apiCard];
}

// ----- Problems saved with an import -----

const PROBLEM_COLUMNS = ['Row', 'Name', 'Client ID', 'Field', 'Value', 'Problem'];
const problemRow = (x) => [x.row, x.name, x.patientId, x.field, x.value, x.problem];
const problemsCsv = (entry, issues) => csvDownload(`${(entry.filename || 'import').replace(/\.[^.]+$/, '')}-problems.csv`, [PROBLEM_COLUMNS, ...issues.map(problemRow)]);

async function showProblems(entry) {
  const r = await api(`/admin/imports/${entry.id}/problems`);
  if (!r.issues.length) return toast('The details of these problems weren\'t saved (imports before this update only kept the count)');
  dialog(`Problems in ${r.filename || `the ${r.source} import`}`, [
    h('p', { class: 'dialog-text' },
      `${r.issueCount.toLocaleString()} problem${r.issueCount === 1 ? '' : 's'} from the import ${relTime(r.createdAt)}. These contacts were still imported, just without the bad value. Fix them in your client software and the next import fills them in. Row numbers match that file.`),
    h('div', { class: 'card-actions' }, h('button', { type: 'button', class: 'btn', onclick: () => problemsCsv(r, r.issues) }, icon('download'), 'Download as CSV')),
    h('div', { class: 'table-wrap scroll' }, h('table', { class: 'table compact' },
      h('thead', {}, h('tr', {}, PROBLEM_COLUMNS.map((t) => h('th', {}, t)))),
      h('tbody', {}, r.issues.map((x) => h('tr', {},
        h('td', { class: 'num' }, x.row), h('td', { class: 'strong nowrap' }, x.name), h('td', {}, x.patientId),
        h('td', {}, x.field), h('td', {}, h('code', {}, x.value || '(empty)')), h('td', { class: 'muted' }, x.problem)))))),
    r.issues.length < r.issueCount && h('p', { class: 'hint' }, `Showing the first ${r.issues.length.toLocaleString()}.`),
  ], null, () => {}, { wide: 'xl' });
}

// The latest import's problems, so they're easy to find again
function latestProblemsCard(entries) {
  const latest = entries.find((e) => !e.error);
  if (!latest) return null;
  if (!latest.issues) {
    return card('Problems to fix', null, h('p', { class: 'ok' }, `✓ The latest import (${latest.filename || latest.source}, ${relTime(latest.created_at)}) had no problems.`));
  }
  return card('Problems to fix',
    'Contacts in the latest import with a bad phone number, email or date of birth, or no name. Fix them in your client software and they\'re corrected on the next import.',
    h('p', {}, h('strong', {}, `${latest.issues.toLocaleString()} problem${latest.issues === 1 ? '' : 's'}`), ` in ${latest.filename || `the ${latest.source} import`} (${relTime(latest.created_at)}).`),
    latest.has_problems
      ? h('div', { class: 'card-actions' },
          h('button', { class: 'btn primary', onclick: () => showProblems(latest) }, 'View problems'),
          h('button', { class: 'btn', onclick: async () => {
            const r = await api(`/admin/imports/${latest.id}/problems`);
            problemsCsv(r, r.issues);
          } }, icon('download'), 'Download as CSV'))
      : h('p', { class: 'hint' }, 'The details weren\'t saved for this import (it ran before this update). They will be for the next one.'));
}

async function reviewMissing(entry) {
  const list = await api(`/admin/imports/${entry.id}/missing`);
  if (!list.length) return toast('Everyone from that list is already inactive or back in a newer import');
  const picker = missingPicker(list);
  dialog(`Not in ${entry.filename ?? 'that import'}`, [
    h('p', { class: 'dialog-text' }, `${list.length.toLocaleString()} active client${list.length === 1 ? ' was' : 's were'} not in this import (${relTime(entry.created_at)}). Mark the ticked ones inactive? They become active again if they text or appear in a later import.`),
    picker.el,
  ], 'Mark inactive', async () => {
    const { changed } = await api('/contacts/status', { method: 'POST', body: { ids: picker.ids(), inactive: true, reason: 'import' } });
    toast(`${changed} marked inactive`);
    renderAdmin();
  }, { wide: true });
}

// ---------- Inactive contacts ----------

const IDLE_CHOICES = [[0, 'Off'], [180, '6 months'], [365, '1 year'], [730, '2 years'], [1095, '3 years']];
const REASONS = { import: 'Not in import', idle: 'No activity', manual: 'Marked by staff' };

async function inactiveCard() {
  const s = await api('/admin/contacts/inactive-settings');
  const custom = !IDLE_CHOICES.some(([d]) => d === s.idleDays);
  const idle = h('select', {}, IDLE_CHOICES.map(([d, label]) => h('option', { value: String(d), selected: d === s.idleDays }, label)),
    h('option', { value: 'custom', selected: custom }, 'Custom…'));
  const days = h('input', { type: 'number', min: 30, max: 3650, value: custom ? s.idleDays : 365, style: 'width:110px', hidden: !custom });
  const daysLabel = h('span', { class: 'hint', hidden: !custom }, 'days');
  const auto = h('input', { type: 'checkbox', class: 'switch', checked: s.autoInactivateMissing });
  const preview = h('p', { class: 'hint' });
  const chosen = () => (idle.value === 'custom' ? Number(days.value) || 0 : Number(idle.value));
  const showPreview = async () => {
    days.hidden = daysLabel.hidden = idle.value !== 'custom';
    const d = chosen();
    if (!d || d === s.idleDays) return fill(preview);
    const r = await api(`/admin/contacts/inactive-settings?previewDays=${d}`);
    fill(preview, r.wouldInactivate ? h('span', { class: 'warn-text' }, `Saving will mark ${r.wouldInactivate.toLocaleString()} contact${r.wouldInactivate === 1 ? '' : 's'} inactive now.`) : 'No contacts would be marked inactive right now.');
  };
  idle.addEventListener('change', showPreview);
  days.addEventListener('input', showPreview);

  // Browse
  const search = h('input', { type: 'search', placeholder: 'Search inactive contacts' });
  const reason = h('select', {}, h('option', { value: '' }, 'Any reason'), Object.entries(REASONS).map(([v, l]) => h('option', { value: v }, l)));
  const table = h('div', {});
  let offset = 0;
  let rows = [];
  const selected = new Set();
  const bar = h('div', { class: 'card-actions' });
  const drawBar = () => fill(bar, selected.size > 0 && [
    h('button', { class: 'btn primary', onclick: async () => {
      const { changed } = await api('/contacts/status', { method: 'POST', body: { ids: [...selected], inactive: false } });
      toast(`${changed} made active again`);
      selected.clear();
      load(true);
    } }, `Make ${selected.size} active again`),
    h('button', { class: 'link-btn', onclick: () => { selected.clear(); draw(); } }, 'Clear')]);
  let total = 0;
  const draw = () => {
    fill(table, rows.length
      ? [h('div', { class: 'table-wrap scroll' }, h('table', { class: 'table compact' },
          h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Name'), h('th', {}, 'Client ID'), h('th', {}, 'Phone'), h('th', {}, 'Why'), h('th', {}, 'Since'))),
          h('tbody', {}, rows.map((c) => {
            const box = h('input', { type: 'checkbox', checked: selected.has(c.id), onchange: () => { box.checked ? selected.add(c.id) : selected.delete(c.id); drawBar(); } });
            return h('tr', {},
              h('td', {}, box),
              h('td', { class: 'strong nowrap' }, h('a', { href: `#/contacts/${c.id}` }, fullName(c))),
              h('td', {}, c.patientId), h('td', { class: 'nowrap' }, c.phone ? formatPhone(c.phone) : ''),
              h('td', {}, REASONS[c.inactiveReason] ?? ''), h('td', { class: 'nowrap' }, relTime(c.inactiveAt)));
          })))),
        rows.length < total && h('button', { class: 'btn', onclick: () => load(false) }, `Show more (${(total - rows.length).toLocaleString()} left)`)]
      : h('p', { class: 'empty-note' }, search.value || reason.value ? 'No inactive contacts match.' : 'No inactive contacts.'));
    drawBar();
  };
  const load = async (reset) => {
    if (reset) {
      offset = 0;
      rows = [];
    }
    const q = new URLSearchParams({ status: 'inactive', limit: 100, offset, q: search.value });
    if (reason.value) q.set('reason', reason.value);
    const r = await api(`/contacts?${q}`);
    total = r.total;
    rows.push(...r.contacts);
    offset = rows.length;
    draw();
  };
  let t;
  search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => load(true), 250); });
  reason.addEventListener('change', () => load(true));
  load(true);

  return card('Inactive contacts',
    `Inactive contacts are hidden from Contacts, searches and bulk messages, but keep their conversations. Any text to or from them, or showing up in an import, makes them active again. ${s.counts.active.toLocaleString()} active, ${s.counts.inactive.toLocaleString()} inactive.`,
    h('div', { class: 'form-grid' },
      field('Mark inactive after no activity for', h('div', { class: 'row-actions left' }, idle, days, daysLabel),
        'Activity means a text either way, an edit, or being in an import. Checked every few hours.'),
      h('div')),
    preview,
    h('label', { class: 'switch-label' }, auto,
      h('span', {}, h('strong', {}, 'Watched folder: mark clients missing from the export inactive'),
        h('span', { class: 'hint' }, ' — for when the folder receives the full list of current clients. Skipped if more than half would go at once. When off, use Review in the import history.'))),
    h('div', { class: 'card-actions' }, h('button', { class: 'btn primary', onclick: async () => {
      try {
        const r = await api('/admin/contacts/inactive-settings', { method: 'PUT', body: { idleDays: chosen(), autoInactivateMissing: auto.checked } });
        toast(r.changed ? `Saved. ${r.changed} contact${r.changed === 1 ? '' : 's'} marked inactive.` : 'Saved');
        renderAdmin();
      } catch (err) {
        toast(err.message);
      }
    } }, 'Save')),
    h('div', { class: 'subsection' },
      h('div', { class: 'row-actions left' }, search, reason),
      table, bar));
}

// ---------- Blocked ----------

async function renderBlocked() {
  const blocked = await api('/admin/blocked');
  return card('Blocked numbers',
    'Texts from these numbers are dropped and never appear in TextBoss. Block someone from the ⋮ menu in their conversation.',
    blocked.length
      ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Number'), h('th', {}, 'Contact'), h('th', {}, 'Blocked'), h('th', { class: 'right' }, 'Actions'))),
          h('tbody', {}, blocked.map((b) => h('tr', {},
            h('td', { class: 'strong nowrap' }, formatPhone(b.phone)),
            h('td', {}, state.names[b.phone]?.join(', ') ?? ''),
            h('td', {}, `${relTime(b.createdAt)}${b.blockedBy ? ` by ${b.blockedBy}` : ''}`),
            h('td', {}, h('div', { class: 'row-actions' }, h('button', { class: 'btn', onclick: async () => {
              await api(`/phones/${b.phone}/block`, { method: 'PUT', body: { blocked: false } });
              toast('Unblocked');
              renderAdmin();
            } }, 'Unblock'))))))))
      : h('p', { class: 'empty-note' }, 'No blocked numbers.'));
}

// ---------- Backup ----------

async function waitForRestart(statusEl) {
  const started = Date.now();
  // Wait for the server to go down, then come back up
  await new Promise((r) => setTimeout(r, 2000));
  while (Date.now() - started < 120_000) {
    try {
      const res = await fetch('/api/setup', { cache: 'no-store' });
      if (res.ok) {
        fill(statusEl, h('span', { class: 'ok' }, '✓ Restore complete. Reloading…'));
        setTimeout(() => location.assign('/'), 1200);
        return;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  fill(statusEl, h('span', { class: 'bad' },
    'The server has not come back yet. If you are not using Docker, start TextBoss again; the restore finishes as it starts.'));
}

async function renderBackup() {
  const download = card('Download a backup',
    'One file with everything: messages, contacts, lists, canned responses, users, settings (including saved provider credentials) and attachments.',
    h('div', { class: 'callout warn' }, icon('warning'),
      h('div', {}, h('strong', {}, 'This file contains client information and passwords. '),
        'Store it somewhere private and delete copies you no longer need.')),
    h('div', { class: 'card-actions' },
      h('a', { class: 'btn primary', href: '/api/admin/backup', download: '' }, icon('download'), 'Download backup')),
    h('p', { class: 'hint' }, 'The backup is taken while TextBoss keeps running; there is no need to stop it first.'));

  const status = h('div', { class: 'test-result', role: 'status' });
  const fileInput = h('input', { type: 'file', accept: '.gz,.tgz,application/gzip', hidden: true });
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files[0];
    fileInput.value = '';
    if (!f) return;
    const ok = await confirmDialog(
      'Replace all data with this backup?',
      `Everything currently in TextBoss on this server will be replaced with the contents of ${f.name}. The current data is kept in a "pre-restore" folder on the server in case you need it back. Everyone will need to sign in again with the accounts from the backup.`,
      'Restore', { danger: true });
    if (!ok) return;
    fill(status, h('span', { class: 'hint' }, `Uploading ${f.name}…`));
    try {
      const r = await api('/admin/restore', { method: 'POST', raw: f, headers: { 'Content-Type': 'application/gzip' } });
      const c = r.manifest.counts ?? {};
      fill(status, h('span', { class: 'hint' },
        `Backup from ${new Date(r.manifest.createdAt).toLocaleString()} accepted (${c.conversations ?? 0} conversations, ${c.messages ?? 0} messages, ${r.manifest.mediaRestored} attachments). Restarting the server…`));
      waitForRestart(status);
    } catch (err) {
      fill(status, h('span', { class: 'bad' }, '✕ ', err.message));
    }
  });

  const restore = card('Restore from a backup',
    'Upload a backup file to replace everything on this server with it. Use this to move TextBoss to a new server, or to undo a mistake.',
    h('div', { class: 'card-actions' }, h('button', { class: 'btn danger', onclick: () => fileInput.click() }, 'Choose backup file…'), fileInput),
    status,
    h('p', { class: 'hint' }, 'TextBoss restarts to finish the restore. With Docker that happens automatically within a few seconds.'));

  const move = card('Moving to a new server', null,
    h('ol', { class: 'steps' },
      h('li', {}, 'Here: ', h('strong', {}, 'Download backup'), '.'),
      h('li', {}, 'On the new server, install TextBoss as in the README and copy over your ', h('code', {}, '.env'),
        '. Keep the same ', h('code', {}, 'WEBHOOK_SECRET'), ' so the incoming-text address still works, and update ', h('code', {}, 'PUBLIC_URL'), ' if the address changes.'),
      h('li', {}, 'Open the new server and create a temporary admin account (it is replaced by the restore).'),
      h('li', {}, 'Go to Admin settings → Backup → ', h('strong', {}, 'Restore from a backup'), ' and choose the file.'),
      h('li', {}, 'If the web address changed, update the incoming-text address in your provider\'s portal to the new one shown on the Provider tab.')));

  return [download, restore, move];
}
