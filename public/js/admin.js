// Admin settings, split into tabs of separate cards:
// BulkVS (connection + webhook), Numbers, Users, Contacts (import + API), Blocked

import {
  h, fill, icon, state, els, route, api, toast, formatPhone, numberLabel, dialog, confirmDialog,
  paneHead, relTime, formatDob,
} from './core.js';

const TABS = [
  ['bulkvs', 'BulkVS'],
  ['numbers', 'Numbers'],
  ['users', 'Users'],
  ['contacts', 'Contacts & import'],
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
    paneHead('Admin settings'),
    h('nav', { class: 'admin-tabs', 'aria-label': 'Admin sections' },
      TABS.map(([id, label]) => h('a', { href: `#/admin/${id}`, class: id === section ? 'on' : '', 'aria-current': id === section ? 'page' : null }, label))),
    body);
  fill(body, h('div', { class: 'hint' }, 'Loading…'));
  try {
    const render = { bulkvs: renderBulkvs, numbers: renderNumbers, users: renderUsers, contacts: renderContactsAdmin, blocked: renderBlocked, backup: renderBackup }[section] ?? renderBulkvs;
    const content = await render();
    if (route().view !== 'admin' || route().section !== section) return; // navigated away meanwhile
    fill(body, content);
  } catch (err) {
    fill(body, h('p', { class: 'bad' }, err.message));
  }
}

// ---------- BulkVS ----------

async function renderBulkvs() {
  const [provider, webhook, numbers] = await Promise.all([api('/admin/provider'), api('/admin/webhook-log'), api('/admin/numbers')]);

  // Connection
  const username = h('input', { type: 'text', value: provider.username, autocomplete: 'off', spellcheck: false });
  const password = h('input', {
    type: 'password',
    autocomplete: 'new-password',
    placeholder: provider.passwordSet ? `Saved (${provider.passwordHint}). Leave blank to keep.` : '',
  });
  const reveal = h('button', { type: 'button', class: 'icon-btn', title: 'Show password', onclick: () => {
    password.type = password.type === 'password' ? 'text' : 'password';
  } }, icon('eye'));
  const result = h('div', { class: 'test-result', role: 'status' });
  const status = provider.mockMode
    ? pill('Not connected: mock mode', 'warn')
    : provider.source === 'env' ? pill('Using credentials from .env', '') : pill('Credentials saved', 'ok');

  const showResult = (r) => fill(result, h('span', { class: r.ok ? 'ok' : 'bad' }, r.ok ? '✓ ' : '✕ ', r.message));

  const connection = card('BulkVS connection',
    'TextBoss sends and receives through your BulkVS account. In the BulkVS portal, open API → API Credentials and copy the REST API username and password/token.',
    h('div', { class: 'status-row' }, status),
    h('div', { class: 'form-grid' },
      field('Provider', h('select', { disabled: true }, h('option', {}, 'BulkVS'))),
      h('div'),
      field('API username', username),
      field('API password / token', h('div', { class: 'input-with-btn' }, password, reveal)),
    ),
    h('p', { class: 'hint' }, 'Leave a field blank to keep the current value. The saved token is never shown.',
      provider.source === 'env' ? ' Saving here overrides the values in .env.' : ''),
    h('div', { class: 'card-actions' },
      h('button', { class: 'btn primary', onclick: async () => {
        try {
          const next = await api('/admin/provider', { method: 'PUT', body: { username: username.value, password: password.value } });
          state.mockMode = next.mockMode;
          toast('BulkVS credentials saved');
          showResult(await api('/admin/provider/test', { method: 'POST', body: {} }));
          password.value = '';
          password.placeholder = next.passwordSet ? `Saved (${next.passwordHint}). Leave blank to keep.` : '';
          fill(status.parentNode, next.mockMode ? pill('Not connected: mock mode', 'warn') : pill('Credentials saved', 'ok'));
        } catch (err) {
          showResult({ ok: false, message: err.message });
        }
      } }, 'Save'),
      h('button', { class: 'btn', onclick: async () => {
        fill(result, h('span', { class: 'hint' }, 'Testing…'));
        showResult(await api('/admin/provider/test', { method: 'POST', body: { username: username.value, password: password.value } }));
      } }, 'Test connection'),
      provider.source === 'admin' && h('button', { class: 'btn danger', onclick: async () => {
        const fallback = provider.envConfigured ? 'TextBoss will go back to the credentials in .env.' : 'TextBoss will stop sending real texts (mock mode) until new credentials are saved.';
        if (!(await confirmDialog('Remove saved credentials?', `The BulkVS username and token saved here will be deleted. ${fallback}`, 'Remove', { danger: true }))) return;
        const next = await api('/admin/provider', { method: 'DELETE' });
        state.mockMode = next.mockMode;
        toast('Saved credentials removed');
        renderAdmin();
      } }, 'Remove saved credentials'),
      result),
  );

  // Webhook
  const webhookCard = card('Inbound webhook',
    'BulkVS delivers incoming texts to this address. Without it, you can send but replies never arrive.',
    webhook.url
      ? [
          h('div', { class: 'copy-line' }, h('code', {}, webhook.url),
            h('button', { class: 'btn', onclick: () => navigator.clipboard.writeText(webhook.url).then(() => toast('Copied')) }, 'Copy')),
          h('ol', { class: 'steps' },
            h('li', {}, 'In the BulkVS portal open ', h('strong', {}, 'Messaging → Messaging Webhooks'), '. Enter a name such as "TextBoss" and paste the address above as the ', h('strong', {}, 'Message URL'), ', then click Add.'),
            h('li', {}, 'Open ', h('strong', {}, 'Inbound → DIDs – Manage'), ', click each number, make sure SMS and MMS are enabled, and set its ', h('strong', {}, 'Messaging Webhook'), ' to the one you just made.'),
            h('li', {}, 'Text one of your numbers from a cell phone. It should appear in Messages and in the log below.')),
        ]
      : h('p', { class: 'bad' }, 'WEBHOOK_SECRET is not set on the server, so incoming texts are turned off. Set it in .env and restart.'),
  );

  // Simulate
  const simFrom = h('input', { type: 'tel', placeholder: 'e.g. 3125550000' });
  const simTo = h('select', {}, numbers.map((n) => h('option', { value: n.phone }, n.label ? `${n.label} · ${formatPhone(n.phone)}` : formatPhone(n.phone))));
  const simText = h('input', { type: 'text', placeholder: 'Message text' });
  const simulate = card('Test an incoming text',
    'Runs a fake incoming text through the same steps as a real one, including STOP, keywords and the away message. Nothing is sent to BulkVS.',
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
    'The raw data BulkVS sent, newest first. "Not applied" means TextBoss could not match it to a number or understand it.',
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
    'Your BulkVS numbers. Untick Active to hide a number everywhere in TextBoss; with only one active number, the number selector disappears. Texts that arrive on an inactive number are still saved.',
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
                  if (!(await confirmDialog(`Remove ${formatPhone(n.phone)}?`, 'Its conversations and messages will be deleted from TextBoss. The number stays in your BulkVS account.', 'Remove', { danger: true }))) return;
                  await api(`/admin/numbers/${n.id}`, { method: 'DELETE' });
                  await refreshNumbers();
                  renderAdmin();
                } }, 'Remove'))));
          }))))
      : h('p', { class: 'empty-note' }, 'No numbers yet. Add your first BulkVS number below.'),
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

async function renderUsers() {
  const [users, numbers] = await Promise.all([api('/admin/users'), api('/admin/numbers')]);

  const numberChecks = (selected = []) =>
    h('div', { class: 'checks' }, numbers.length
      ? numbers.map((n) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'numberIds', value: String(n.id), checked: selected.includes(n.id) }), n.label ? `${n.label} · ${formatPhone(n.phone)}` : formatPhone(n.phone)))
      : h('span', { class: 'hint' }, 'Add numbers first.'));

  const userDialog = (u) => dialog(
    u ? `Edit ${u.displayName}` : 'Add user',
    [
      !u && h('label', {}, 'Username', h('input', { type: 'text', name: 'username', required: true, autocomplete: 'off' })),
      h('label', {}, 'Display name', h('input', { type: 'text', name: 'displayName', value: u?.displayName ?? '' })),
      h('label', {}, u ? 'New password (leave blank to keep)' : 'Password (8+ characters)', h('input', { type: 'password', name: 'password', required: !u, minLength: 8, autocomplete: 'new-password' })),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'isAdmin', checked: !!u?.isAdmin }), 'Admin: sees every number and can change these settings'),
      h('div', { class: 'field-label' }, 'Numbers this user can use'), numberChecks(u?.numberIds),
    ],
    u ? 'Save' : 'Add user',
    async (data) => {
      const body = { displayName: data.get('displayName'), isAdmin: data.get('isAdmin') === 'on', numberIds: data.getAll('numberIds').map(Number) };
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
      h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Username'), h('th', {}, 'Access'), h('th', { class: 'right' }, 'Actions'))),
      h('tbody', {}, users.map((u) => h('tr', {},
        h('td', { class: 'strong' }, u.displayName, u.id === state.me.id && h('span', { class: 'hint' }, ' (you)')),
        h('td', {}, u.username),
        h('td', {}, u.isAdmin ? pill('Admin · all numbers', 'accent') : u.numberIds.length ? u.numberIds.map(numberLabel).join(', ') : pill('No numbers', 'warn')),
        h('td', {}, h('div', { class: 'row-actions' },
          h('button', { class: 'btn', onclick: () => userDialog(u) }, 'Edit'),
          u.id !== state.me.id && h('button', { class: 'btn danger', onclick: async () => {
            if (!(await confirmDialog(`Delete ${u.displayName}?`, 'They will no longer be able to sign in. Messages they sent are kept.', 'Delete', { danger: true }))) return;
            await api(`/admin/users/${u.id}`, { method: 'DELETE' });
            renderAdmin();
          } }, 'Delete')))))))),
    h('div', { class: 'card-actions' }, h('button', { class: 'btn primary', onclick: () => userDialog(null) }, 'Add user')));
}

// ---------- Contacts & import ----------

const FIELD_NAMES = { firstName: 'First name', lastName: 'Last name', nickname: 'Nickname', phone: 'Phone', dob: 'Date of birth', email: 'Email', patientId: 'Patient ID', notes: 'Notes' };
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

function importReport(file, r, onConfirm) {
  const used = r.columns.filter((c) => c.field);
  const ignored = r.columns.filter((c) => !c.field);
  const base = file.name.replace(/\.[^.]+$/, '');

  return h('div', { class: 'import-report' },
    h('div', { class: 'import-file' }, h('strong', {}, file.name), ` · ${r.rows.toLocaleString()} rows read`),
    h('div', { class: 'stats' },
      stat('New', r.created, r.created ? 'ok' : ''),
      stat('Updated', r.updated, r.updated ? 'accent' : ''),
      stat('Unchanged', r.unchanged),
      stat('Skipped', r.skipped),
      stat('Problems', r.issueCount, r.issueCount ? 'warn' : '')),

    r.issueCount > 0 && h('div', { class: 'subsection' },
      h('div', { class: 'subsection-head' },
        h('h3', {}, `Problems to fix (${r.issueCount.toLocaleString()})`),
        h('button', { class: 'btn', onclick: () => csvDownload(`${base}-problems.csv`, [
          ['Row', 'Name', 'Patient ID', 'Field', 'Value', 'Problem'],
          ...r.issues.map((x) => [x.row, x.name, x.patientId, x.field, x.value, x.problem]),
        ]) }, icon('download'), 'Download as CSV')),
      h('p', { class: 'hint' }, 'These contacts are still imported, just without the bad value (an existing good value is kept). Fix them in WebPT and the next import will fill them in. Row numbers match the spreadsheet.'),
      h('div', { class: 'table-wrap scroll' }, h('table', { class: 'table compact' },
        h('thead', {}, h('tr', {}, ['Row', 'Name', 'Patient ID', 'Field', 'Value', 'Problem'].map((t) => h('th', {}, t)))),
        h('tbody', {}, r.issues.map((x) => h('tr', {},
          h('td', { class: 'num' }, x.row), h('td', { class: 'strong nowrap' }, x.name), h('td', {}, x.patientId),
          h('td', {}, x.field), h('td', {}, h('code', {}, x.value || '(empty)')), h('td', { class: 'muted' }, x.problem)))))),
      r.issues.length < r.issueCount && h('p', { class: 'hint' }, `Showing the first ${r.issues.length.toLocaleString()}.`)),

    r.changeCount > 0 && h('div', { class: 'subsection' },
      h('div', { class: 'subsection-head' },
        h('h3', {}, `What will change (${r.changeCount.toLocaleString()} contacts)`),
        h('button', { class: 'btn', onclick: () => csvDownload(`${base}-changes.csv`, [
          ['Row', 'Name', 'Patient ID', 'Field', 'Old', 'New'],
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
      h('button', { class: 'btn primary', disabled: !r.created && !r.updated, onclick: onConfirm },
        r.created || r.updated ? `Import: ${r.created} new, ${r.updated} updated` : 'Nothing new to import'),
      h('button', { class: 'btn', onclick: () => renderAdmin() }, 'Cancel')));
}

async function renderContactsAdmin() {
  const [imports, keys] = await Promise.all([api('/admin/imports'), api('/admin/api-keys')]);

  const report = h('div', {});
  const fileInput = h('input', { type: 'file', accept: '.xls,.xlsx,.csv', hidden: true });
  const drop = h('div', { class: 'dropzone', tabindex: 0, role: 'button', onclick: () => fileInput.click(),
    onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && fileInput.click() },
    h('strong', {}, 'Choose a file'), ' or drag it here', h('div', { class: 'hint' }, '.xls, .xlsx or .csv, such as the WebPT Patient Listing report'));

  const handle = async (f) => {
    if (!f) return;
    fill(report, h('p', { class: 'hint' }, `Reading ${f.name}…`));
    const send = (dryRun) => api(`/admin/import${dryRun ? '?dryRun=1' : ''}`, { method: 'POST', raw: f, headers: { 'X-Filename': f.name } });
    try {
      const r = await send(true);
      drop.hidden = true;
      fill(report, importReport(f, r, async (e) => {
        e.target.disabled = true;
        try {
          const done = await send(false);
          toast(`Imported: ${done.created} new, ${done.updated} updated`);
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
    'You will see what would change before anything is saved. Patients are matched by patient ID, so importing the full list again updates changed details (like a new phone number) instead of making duplicates. Imports never delete contacts or clear notes.',
    drop, fileInput, report);

  const folder = card('Watched folder',
    'Save exports into this folder on the server and they are imported automatically within a minute, then moved into processed/ or failed/.',
    h('div', { class: 'copy-line' }, h('code', {}, imports.folder)),
    h('p', { class: 'hint' }, 'With Docker this is the import/ folder next to compose.yaml.'));

  const history = card('Import history', 'The last 30 imports from any source.',
    imports.entries.length
      ? h('div', { class: 'table-wrap' }, h('table', { class: 'table compact' },
          h('thead', {}, h('tr', {}, ['When', 'Source', 'File', 'New', 'Updated', 'Skipped', 'Problems'].map((t) => h('th', {}, t)))),
          h('tbody', {}, imports.entries.map((e) => h('tr', {},
            h('td', { class: 'nowrap' }, relTime(e.created_at)), h('td', {}, e.source), h('td', { class: 'clip' }, e.filename ?? ''),
            ...(e.error
              ? [h('td', { colspan: 4, class: 'bad' }, e.error)]
              : [h('td', { class: 'num' }, e.created), h('td', { class: 'num' }, e.updated), h('td', { class: 'num' }, e.skipped), h('td', { class: `num${e.issues ? ' warn-text' : ''}` }, e.issues ?? 0)]))))))
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
      h('label', {}, 'Name (what will use it)', h('input', { type: 'text', name: 'name', required: true, placeholder: 'e.g. WebPT sync script' })),
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
  --data-binary @PatientReport.xls

# Add ?dryRun=1 to see what would change without saving.`)));

  return [upload, folder, history, apiCard];
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
    'One file with everything: messages, contacts, lists, canned responses, users, settings (including saved BulkVS credentials) and attachments.',
    h('div', { class: 'callout warn' }, icon('warning'),
      h('div', {}, h('strong', {}, 'This file contains patient information and passwords. '),
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
        '. Keep the same ', h('code', {}, 'WEBHOOK_SECRET'), ' so the BulkVS webhook address still works, and update ', h('code', {}, 'PUBLIC_URL'), ' if the address changes.'),
      h('li', {}, 'Open the new server and create a temporary admin account (it is replaced by the restore).'),
      h('li', {}, 'Go to Admin settings → Backup → ', h('strong', {}, 'Restore from a backup'), ' and choose the file.'),
      h('li', {}, 'If the web address changed, update the Message URL in BulkVS (Messaging → Messaging Webhooks) to the new one shown on the BulkVS tab.')));

  return [download, restore, move];
}
