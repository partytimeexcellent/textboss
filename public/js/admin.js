// Admin settings: numbers, users, contact import, API keys, blocked numbers, webhook

import { h, fill, state, els, api, toast, formatPhone, numberLabel, dialog, confirmDialog, paneHead, relTime, formatDob } from './core.js';

export async function renderAdmin() {
  const pane = h('div', { class: 'admin' });
  fill(els.main, paneHead('Admin settings'), pane);

  let numbers, users, webhook, imports, keys, blocked;
  try {
    [numbers, users, webhook, imports, keys, blocked] = await Promise.all([
      api('/admin/numbers'), api('/admin/users'), api('/admin/webhook-log'),
      api('/admin/imports'), api('/admin/api-keys'), api('/admin/blocked'),
    ]);
  } catch (err) {
    fill(pane, h('p', { class: 'hint' }, err.message));
    return;
  }
  const refresh = async () => {
    const me = await api('/me');
    state.numbers = me.numbers;
    renderAdmin();
  };

  // ----- Numbers -----
  const phoneInput = h('input', { type: 'tel', placeholder: 'BulkVS number, e.g. 3105551212' });
  const labelInput = h('input', { type: 'text', placeholder: 'Label, e.g. Front desk' });
  const numbersSection = h('section', { id: 'numbers' },
    h('h2', {}, 'Phone numbers'),
    h('p', { class: 'hint' }, 'Numbers from your BulkVS account that TextBoss sends and receives on. Each must have SMS/MMS enabled and use the webhook below in the BulkVS portal.'),
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
              if (!(await confirmDialog(`Remove ${formatPhone(n.phone)}?`, 'Its conversations and messages will be deleted from TextBoss.', 'Remove', { danger: true }))) return;
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

  // ----- Users -----
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
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'isAdmin', checked: !!u?.isAdmin }), 'Admin (sees every number and manages settings)'),
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

  const usersSection = h('section', { id: 'users' },
    h('h2', {}, 'Users'),
    h('p', { class: 'hint' }, 'Each user sees only the numbers assigned to them. Admins see every number. Contacts, lists and canned responses are shared by everyone.'),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Username'), h('th', {}, 'Access'), h('th', {}))),
      h('tbody', {}, users.map((u) => h('tr', {},
        h('td', {}, u.displayName),
        h('td', {}, u.username),
        h('td', {}, u.isAdmin ? 'Admin · all numbers' : u.numberIds.length ? u.numberIds.map(numberLabel).join(', ') || `${u.numberIds.length} number(s)` : 'No numbers'),
        h('td', {}, h('div', { class: 'row-actions' },
          h('button', { class: 'btn', onclick: () => userDialog(u) }, 'Edit'),
          u.id !== state.me.id && h('button', { class: 'btn danger', onclick: async () => {
            if (!(await confirmDialog(`Delete ${u.displayName}?`, 'They will no longer be able to sign in. Messages they sent are kept.', 'Delete', { danger: true }))) return;
            await api(`/admin/users/${u.id}`, { method: 'DELETE' });
            refresh();
          } }, 'Delete')))))),
    )),
    h('div', {}, h('button', { class: 'btn primary', onclick: () => userDialog(null) }, 'Add user')),
  );

  // ----- Contact import -----
  const importResult = h('div', { class: 'import-result' });
  const fileInput = h('input', { type: 'file', accept: '.xls,.xlsx,.csv', hidden: true });
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files[0];
    fileInput.value = '';
    if (!f) return;
    fill(importResult, h('p', { class: 'hint' }, `Reading ${f.name}…`));
    const send = (dryRun) => api(`/admin/import${dryRun ? '?dryRun=1' : ''}`, { method: 'POST', raw: f, headers: { 'X-Filename': f.name } });
    let r;
    try {
      r = await send(true);
    } catch (err) {
      fill(importResult, h('p', { class: 'bad' }, err.message));
      return;
    }
    const used = r.columns.filter((c) => c.field);
    const ignored = r.columns.filter((c) => !c.field);
    fill(importResult, 
      h('div', { class: 'import-preview' },
        h('div', {}, h('strong', {}, f.name), ` · ${r.rows.toLocaleString()} rows`),
        h('div', {}, h('span', { class: 'ok' }, `${r.created} new`), ` · ${r.updated} updated · ${r.unchanged} unchanged · `,
          h('span', { class: r.skipped ? 'bad' : '' }, `${r.skipped} skipped`), r.skipped ? ' (rows with no name and phone, or invalid data)' : ''),
        h('div', { class: 'hint' }, 'Columns used: ', used.map((c) => `${c.header} → ${c.field}`).join(', ')),
        ignored.length > 0 && h('div', { class: 'hint' }, 'Ignored: ', ignored.map((c) => c.header).join(', ')),
        r.errors.length > 0 && h('details', {}, h('summary', {}, `${r.errors.length} problems`), h('pre', {}, r.errors.join('\n'))),
        r.preview.length > 0 && h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, ['', 'Name', 'Phone', 'DOB', 'Email', 'Patient ID'].map((t) => h('th', {}, t)))),
          h('tbody', {}, r.preview.map((p) => h('tr', {},
            h('td', {}, p.action), h('td', {}, [p.firstName, p.lastName].filter(Boolean).join(' ')),
            h('td', {}, formatPhone(p.phone)), h('td', {}, formatDob(p.dob)), h('td', {}, p.email ?? ''), h('td', {}, p.patientId ?? '')))))),
        h('div', { class: 'row-actions left' },
          h('button', { class: 'btn primary', disabled: !r.created && !r.updated, onclick: async (e) => {
            e.target.disabled = true;
            try {
              const done = await send(false);
              toast(`Imported: ${done.created} new, ${done.updated} updated`);
              renderAdmin();
            } catch (err) {
              toast(err.message);
              e.target.disabled = false;
            }
          } }, r.created || r.updated ? `Import ${r.created + r.updated} contacts` : 'Nothing to import'),
          h('button', { class: 'btn', onclick: () => fill(importResult) }, 'Cancel'))),
    );
  });

  const importSection = h('section', { id: 'import' },
    h('h2', {}, 'Import contacts'),
    h('p', { class: 'hint' }, 'Upload an .xls, .xlsx or .csv export, such as the WebPT Patient Listing report. TextBoss finds the header row, uses the cell phone (then home, then work), and matches existing contacts by patient ID so re-importing updates them instead of making duplicates. Imports never delete contacts or clear notes. You will see a preview before anything is saved.'),
    h('div', {}, h('button', { class: 'btn primary', onclick: () => fileInput.click() }, 'Choose file…'), fileInput),
    importResult,
    h('h3', {}, 'Watched folder'),
    h('p', { class: 'hint' }, 'Files saved into this folder on the server are imported automatically within a minute, then moved to its processed/ or failed/ subfolder:'),
    h('div', { class: 'copy-line' }, h('code', {}, imports.folder)),
    h('h3', {}, 'Recent imports'),
    imports.entries.length
      ? h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, ['When', 'Source', 'File', 'Result'].map((t) => h('th', {}, t)))),
          h('tbody', {}, imports.entries.map((e) => h('tr', {},
            h('td', {}, relTime(e.created_at)), h('td', {}, e.source), h('td', { class: 'clip' }, e.filename ?? ''),
            h('td', { class: e.error ? 'bad' : '' }, e.error ?? `${e.created} new, ${e.updated} updated, ${e.skipped} skipped`))))))
      : h('p', { class: 'hint' }, 'No imports yet.'),
  );

  // ----- API keys -----
  const origin = location.origin;
  const apiSection = h('section', { id: 'api' },
    h('h2', {}, 'Contact import API'),
    h('p', { class: 'hint' }, 'Lets other software push contacts into TextBoss. Each key is shown once when created; revoke it if it leaks.'),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Name', 'Key', 'Last used', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, keys.length ? keys.map((k) => h('tr', {},
        h('td', {}, k.name), h('td', {}, h('code', {}, `${k.prefix}…`)),
        h('td', {}, k.lastUsedAt ? relTime(k.lastUsedAt) : 'Never'),
        h('td', {}, h('div', { class: 'row-actions' }, h('button', { class: 'btn danger', onclick: async () => {
          if (!(await confirmDialog(`Revoke "${k.name}"?`, 'Anything using this key will stop being able to import contacts.', 'Revoke', { danger: true }))) return;
          await api(`/admin/api-keys/${k.id}`, { method: 'DELETE' });
          renderAdmin();
        } }, 'Revoke'))))) : h('tr', {}, h('td', { colspan: 4, class: 'hint' }, 'No keys yet.'))))),
    h('div', {}, h('button', { class: 'btn primary', onclick: () => dialog('Create API key',
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

# Add ?dryRun=1 to see what would change without saving.`)),
  );

  // ----- Blocked -----
  const blockedSection = h('section', { id: 'blocked' },
    h('h2', {}, 'Blocked numbers'),
    h('p', { class: 'hint' }, 'Texts from these numbers are dropped. Block a sender from the ⋮ menu in their conversation.'),
    blocked.length
      ? h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, ['Number', 'Blocked', ''].map((t) => h('th', {}, t)))),
          h('tbody', {}, blocked.map((b) => h('tr', {},
            h('td', {}, formatPhone(b.phone), state.names[b.phone] ? ` · ${state.names[b.phone].join(', ')}` : ''),
            h('td', {}, `${relTime(b.createdAt)}${b.blockedBy ? ` by ${b.blockedBy}` : ''}`),
            h('td', {}, h('div', { class: 'row-actions' }, h('button', { class: 'btn', onclick: async () => {
              await api(`/phones/${b.phone}/block`, { method: 'PUT', body: { blocked: false } });
              toast('Unblocked');
              renderAdmin();
            } }, 'Unblock'))))))))
      : h('p', { class: 'hint' }, 'No blocked numbers.'),
  );

  // ----- Webhook -----
  const simFrom = h('input', { type: 'tel', placeholder: 'From, e.g. 3125550000' });
  const simTo = h('select', {}, numbers.map((n) => h('option', { value: n.phone }, formatPhone(n.phone))));
  const simText = h('input', { type: 'text', placeholder: 'Message text' });

  const webhookSection = h('section', { id: 'webhook' },
    h('h2', {}, 'Inbound webhook'),
    webhook.url
      ? [
          h('p', { class: 'hint' }, 'In the BulkVS portal, open Messaging → Messaging Webhooks and add a webhook with this as the Message URL. Then, under Inbound → DIDs – Manage, open each number above, enable SMS and MMS, and set its Messaging Webhook to the one you created.'),
          h('div', { class: 'copy-line' }, h('code', {}, webhook.url),
            h('button', { class: 'btn', onclick: () => navigator.clipboard.writeText(webhook.url).then(() => toast('Copied')) }, 'Copy')),
        ]
      : h('p', { class: 'hint bad' }, 'WEBHOOK_SECRET is not set on the server, so inbound messages are turned off. Set it in .env and restart.'),
    h('p', { class: 'hint' }, 'Test the inbound path without a real text. This goes through the same parser as the webhook, including STOP, keywords and the away message:'),
    h('div', { class: 'add-row' }, simFrom, numbers.length > 0 && simTo, simText,
      h('button', { class: 'btn', disabled: !numbers.length, onclick: async () => {
        try {
          await api('/admin/simulate-inbound', { method: 'POST', body: { From: simFrom.value, To: [simTo.value], Message: simText.value } });
          toast('Simulated message received');
          simText.value = '';
        } catch (err) { toast(err.message); }
      } }, 'Simulate')),
    h('h3', {}, 'Recent webhook calls'),
    webhook.entries.length
      ? webhook.entries.map((e) => {
          const result = JSON.parse(e.result ?? '{}');
          return h('div', { class: 'log-entry' },
            h('div', { class: 'meta' }, new Date(e.received_at).toLocaleString(),
              h('span', { class: result.blocked ? '' : result.ok ? 'ok' : 'bad' },
                result.blocked ? 'blocked sender, dropped' : result.ok ? 'applied' : `not applied: ${result.reason}`)),
            h('pre', {}, e.body));
        })
      : h('p', { class: 'hint' }, 'Nothing received yet.'),
  );

  const nav = h('nav', { class: 'admin-nav' },
    [['numbers', 'Numbers'], ['users', 'Users'], ['import', 'Import'], ['api', 'API'], ['blocked', 'Blocked'], ['webhook', 'Webhook']]
      .map(([id, label]) => h('button', { class: 'link-btn', onclick: () => pane.querySelector(`#${id}`).scrollIntoView({ behavior: 'smooth' }) }, label)));

  fill(pane, nav, numbersSection, usersSection, importSection, apiSection, blockedSection, webhookSection);
}
