// Admin → Textable history: upload a Textable export (one CSV per person),
// check how each conversation was matched to a contact, fix the ones that
// need it, then import the confirmed ones.

import { h, fill, icon, api, toast, formatPhone, dialog, confirmDialog, relTime, state } from './core.js';
import { card, stat, pill } from './admin.js';

const FILTERS = [
  ['review', 'Needs review'],
  ['none', 'No match'],
  ['auto', 'Matched'],
  ['skip', 'Skipped'],
  ['confirmed', 'Confirmed'],
  ['imported', 'Imported'],
  ['all', 'All'],
];

const view = { filter: 'review', q: '' };
let data = null;

const day = (ts) => (ts ? new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
const labelText = (t) => (t.label.kind === 'name'
  ? [t.label.nick && `"${t.label.nick}"`, t.label.first, t.label.last, t.label.note && `(${t.label.note})`].filter(Boolean).join(' ')
  : t.file.replace(/\.csv$/i, ''));

const bucket = (t) => (t.importedAt ? 'imported' : t.confirmed ? 'confirmed' : t.status);

function plan(t) {
  if (t.action === 'skip') return h('span', { class: 'muted' }, 'Don\'t import');
  if (t.action === 'phone') return h('span', {}, 'Texts only, no contact');
  if (t.action === 'link') {
    return h('span', {}, 'Link to ', h('a', { href: `#/contacts/${t.contactId}` }, t.contactName || `contact #${t.contactId}`),
      t.nickname && h('span', { class: 'muted' }, `, nickname "${t.nickname}"`));
  }
  const name = [t.nickname && `"${t.nickname}"`, t.firstName, t.lastName].filter(Boolean).join(' ');
  return h('span', {}, 'New contact ', h('strong', {}, name));
}

const STATUS_PILL = {
  auto: ['Matched', 'ok'],
  review: ['Review', 'warn'],
  none: ['No match', ''],
  skip: ['Skip', ''],
  confirmed: ['Confirmed', 'accent'],
  imported: ['Imported', 'ok'],
};

async function load() {
  data = await api('/admin/textable');
}

export async function renderTextableAdmin() {
  await load();
  const root = h('div', { class: 'textable-admin' });
  const draw = () => fill(root, ...sections(draw));
  draw();
  return root;
}

function sections(draw) {
  const reload = async () => { await load(); draw(); };
  const { summary } = data;
  const c = summary.counts;
  const out = [];
  if (state.clone) {
    out.push(h('p', { class: 'callout ok' }, icon('shield'), h('span', {},
      h('strong', {}, 'This is a practice copy. '),
      'Review here, and import to see how it looks: nothing reaches the clinic. When it\'s right, use ', h('em', {}, 'Download review file'),
      ' below, then drop that file on the live TextBoss\'s Textable history tab and import there.')));
  }
  out.push(uploadCard(reload, c.total > 0));
  if (!c.total) return out;

  // ----- Review -----
  const shown = data.threads.filter((t) => (view.filter === 'all' || bucket(t) === view.filter)
    && (!view.q || `${t.file} ${t.phone} ${labelText(t)} ${t.contactName ?? ''}`.toLowerCase().includes(view.q.toLowerCase())));
  const pending = shown.filter((t) => !t.confirmed && !t.importedAt);
  const tbody = h('tbody', {});
  const search = h('input', { type: 'search', placeholder: 'Search names, phones and file names', value: view.q,
    oninput: () => { view.q = search.value; drawRows(); } });

  const counts = { review: c.review, none: c.none, auto: c.auto, skip: c.skip, confirmed: c.confirmed, imported: c.imported, all: c.total };
  const tabs = h('div', { class: 'segmented wrap' }, FILTERS.map(([id, label]) => h('button', {
    type: 'button', class: id === view.filter ? 'on' : '', onclick: () => { view.filter = id; draw(); },
  }, `${label} (${counts[id].toLocaleString()})`)));

  function drawRows() {
    const list = data.threads.filter((t) => (view.filter === 'all' || bucket(t) === view.filter)
      && (!view.q || `${t.file} ${t.phone} ${labelText(t)} ${t.contactName ?? ''}`.toLowerCase().includes(view.q.toLowerCase())));
    fill(tbody, list.length
      ? list.map((t) => {
        const [text, kind] = STATUS_PILL[bucket(t)];
        return h('tr', { class: 'clickable', onclick: () => openThread(t.id, list, reload) },
          h('td', { class: 'strong' }, labelText(t), t.label.kind !== 'name' && h('div', { class: 'hint' }, t.label.kind === 'id' ? 'ID in Textable' : 'Number in Textable')),
          h('td', { class: 'nowrap' }, formatPhone(t.phone)),
          h('td', { class: 'nowrap num' }, t.messages.toLocaleString(), h('div', { class: 'hint' }, day(t.lastAt))),
          h('td', {}, plan(t), t.reasons.length > 0 && !t.confirmed && h('div', { class: 'hint' }, t.reasons.join(' · '))),
          h('td', {}, pill(text, kind)));
      })
      : h('tr', {}, h('td', { colspan: 5, class: 'muted' }, 'Nothing here.')));
  }
  drawRows();

  const review = card('Review matches',
    'Each conversation is matched to a contact by its phone number and the name typed in Textable (nicknames, short forms and small spelling differences count). Nothing is saved to contacts or conversations until you import. Click a row to change what happens to it.',
    h('div', { class: 'stats' },
      stat('Needs review', c.review, c.review ? 'warn' : ''),
      stat('No match', c.none),
      stat('Matched', c.auto, c.auto ? 'ok' : ''),
      stat('Confirmed', c.confirmed, c.confirmed ? 'accent' : ''),
      stat('Imported', c.imported, c.imported ? 'ok' : '')),
    tabs,
    h('div', { class: 'card-actions' }, search,
      pending.length > 0 && h('button', { class: 'btn', onclick: async (e) => {
        if (view.filter === 'review' && !(await confirmDialog('Confirm without reviewing?', `${plural(pending.length, 'conversation')} were flagged for a closer look. Confirm them as shown anyway?`, 'Confirm all'))) return;
        e.target.disabled = true;
        const { changed } = await api('/admin/textable/confirm', { method: 'POST', body: { ids: pending.map((t) => t.id) } });
        toast(`Confirmed ${plural(changed, 'conversation')}`);
        reload();
      } }, `Confirm ${pending.length === shown.length ? 'all' : 'the'} ${pending.length.toLocaleString()} shown`),
      h('button', { class: 'btn', title: 'Match again, e.g. after importing contacts', onclick: async () => {
        await api('/admin/textable/rematch', { method: 'POST' });
        toast('Matched again');
        reload();
      } }, icon('refresh'), 'Re-check')),
    h('div', { class: 'table-wrap scroll tall' }, h('table', { class: 'table compact' },
      h('thead', {}, h('tr', {}, ['Name in Textable', 'Phone', 'Texts', 'What will happen', ''].map((x) => h('th', {}, x)))),
      tbody)));
  out.push(review);

  // ----- Import -----
  const archive = h('input', { type: 'checkbox', class: 'switch', checked: true });
  const archiveDays = h('input', { type: 'number', min: 30, max: 3650, value: 365, style: 'width:90px' });
  const inactive = h('input', { type: 'checkbox', class: 'switch', checked: true });
  const inactiveDays = h('input', { type: 'number', min: 30, max: 3650, value: 365, style: 'width:90px' });
  out.push(card('Import confirmed conversations',
    'Texts are added to each conversation in date order, before anything already in TextBoss, and don\'t count as unread or send notifications. Importing again never duplicates texts.',
    summary.missingNumbers.length > 0 && h('p', { class: 'callout warn' }, icon('warning'),
      h('span', {}, `Add ${summary.missingNumbers.map(formatPhone).join(', ')} under `, h('a', { href: '#/admin/numbers' }, 'Numbers'), ' first. It can stay turned off.')),
    h('div', { class: 'stats' },
      stat('Conversations', summary.ready, summary.ready ? 'accent' : ''),
      stat('Texts', summary.readyMessages),
      stat('New contacts', summary.creates),
      stat('Nicknames set', summary.nicknames),
      stat('Opt-outs', summary.optOuts.length, summary.optOuts.length ? 'warn' : '')),
    summary.optOuts.length > 0 && h('p', { class: 'hint' }, `These texted STOP in Textable and will be opted out: ${summary.optOuts.map((o) => `${formatPhone(o.phone)} (${day(o.at)})`).join(', ')}`),
    h('label', { class: 'switch-label' }, archive, h('span', {}, 'Archive conversations with no texts in the last ', archiveDays, ' days')),
    h('label', { class: 'switch-label' }, inactive, h('span', {}, 'Make new contacts inactive when they haven\'t texted in ', inactiveDays, ' days')),
    h('div', { class: 'card-actions' },
      h('button', { class: 'btn primary', disabled: !summary.ready || summary.missingNumbers.length > 0, onclick: async (e) => {
        if (!(await confirmDialog('Import Textable history?', `${plural(summary.ready, 'conversation')} with ${plural(summary.readyMessages, 'text')}${summary.creates ? `, ${plural(summary.creates, 'new contact')}` : ''}. Take a backup first if you haven't.`, 'Import'))) return;
        e.target.disabled = true;
        try {
          const r = await api('/admin/textable/import', { method: 'POST', body: {
            archiveDays: archive.checked ? Number(archiveDays.value) : 0,
            inactiveDays: inactive.checked ? Number(inactiveDays.value) : 0,
          } });
          toast(`Imported ${plural(r.messages, 'text')} into ${plural(r.conversations, 'conversation')}${r.created ? `, ${plural(r.created, 'new contact')}` : ''}`);
          reload();
        } catch (err) {
          toast(err.message);
          e.target.disabled = false;
        }
      } }, summary.ready ? `Import ${plural(summary.ready, 'conversation')}` : 'Confirm conversations to import them'),
      h('a', { class: 'btn', href: '#/admin/backup' }, 'Backup first'),
      h('a', { class: 'btn', href: '/api/admin/textable/review', download: '', title: 'Every file and choice on this page, to load on another TextBoss' }, icon('download'), 'Download review file'),
      h('div', { style: 'flex:1' }),
      h('button', { class: 'btn danger', onclick: async () => {
        if (!(await confirmDialog('Clear the uploaded files?', 'Everything not imported yet is removed from this page, including your review choices. Imported conversations stay.', 'Clear', { danger: true }))) return;
        await api('/admin/textable', { method: 'DELETE' });
        reload();
      } }, 'Clear uploads'))));
  return out;
}

// ----- Upload -----

function uploadCard(reload, hasData) {
  const status = h('div', {});
  const folder = h('input', { type: 'file', webkitdirectory: true, multiple: true, hidden: true });
  const pick = h('input', { type: 'file', accept: '.csv,.json', multiple: true, hidden: true });

  // A review file from a practice copy: the files plus every choice made there
  const loadReview = async (f) => {
    fill(status, h('p', { class: 'hint' }, `Reading ${f.name}…`));
    try {
      const r = await api('/admin/textable/review', { method: 'POST', raw: await f.text(), headers: { 'Content-Type': 'text/plain' } });
      await reload();
      // The page redraws on reload, so the outcome goes in a dialog
      dialog('Review loaded', [
        h('p', { class: 'dialog-text' }, `${plural(r.threads, 'conversation')} loaded, ${r.confirmed.toLocaleString()} confirmed as decided on the copy${r.alreadyImported ? `, ${r.alreadyImported.toLocaleString()} already imported here` : ''}.`),
        r.recheck.length > 0 && h('p', { class: 'callout warn' }, icon('warning'), h('span', {},
          `${plural(r.recheck.length, 'conversation')} need another look because the contact changed since the copy was made. They're back under Needs review or Matched.`)),
        r.recheck.length > 0 && h('ul', { class: 'facts' }, r.recheck.slice(0, 50).map((x) => h('li', {}, x))),
      ], null, () => {});
    } catch (err) {
      fill(status, h('p', { class: 'bad' }, err.message));
    }
  };

  const send = async (fileList) => {
    const review = [...fileList].find((f) => /\.json$/i.test(f.name));
    if (review) return loadReview(review);
    const files = [...fileList].filter((f) => /\.csv$/i.test(f.name));
    if (!files.length) return toast('No .csv files there');
    const total = { files: 0, messages: 0, errors: [] };
    try {
      // Batches of about 2 MB so a big export doesn't go up in one request
      for (let i = 0; i < files.length;) {
        const batch = [];
        let size = 0;
        while (i < files.length && (batch.length === 0 || size + files[i].size < 2_000_000)) {
          size += files[i].size;
          batch.push({ name: files[i].name, text: await files[i].text() });
          i++;
        }
        fill(status, h('p', { class: 'hint' }, `Reading ${i.toLocaleString()} of ${files.length.toLocaleString()} files…`));
        const r = await api('/admin/textable/files', { method: 'POST', raw: JSON.stringify({ files: batch }), headers: { 'Content-Type': 'text/plain' } });
        total.files += r.files;
        total.messages += r.messages;
        total.errors.push(...r.errors);
      }
    } catch (err) {
      fill(status, h('p', { class: 'bad' }, err.message));
      return;
    }
    toast(`Read ${plural(total.files, 'file')} with ${plural(total.messages, 'text')}`);
    await reload();
    if (total.errors.length) toast(`${plural(total.errors.length, 'file')} couldn't be read: ${total.errors.slice(0, 3).join('; ')}`);
  };
  folder.addEventListener('change', () => { send(folder.files); folder.value = ''; });
  pick.addEventListener('change', () => { send(pick.files); pick.value = ''; });

  const drop = h('div', { class: 'dropzone', tabindex: 0, role: 'button', onclick: () => folder.click(),
    onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && folder.click() },
    h('strong', {}, 'Choose the export folder'), ' or drag files here',
    h('div', { class: 'hint' }, 'The folder of .csv files from Textable, one per person, or a review file from a practice copy. ',
      h('button', { type: 'button', class: 'link-btn', onclick: (e) => { e.stopPropagation(); pick.click(); } }, 'Or pick files')));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); send(e.dataTransfer.files); });

  return card(hasData ? 'Add more Textable files' : 'Import Textable history',
    'Upload the conversation export from Textable to bring past texts into TextBoss. You check how each one is matched to a contact before anything is imported. Uploading a file again updates it and keeps your choices.',
    drop, folder, pick, status);
}

// ----- One conversation -----

async function openThread(id, list, reload) {
  const t = data.threads.find((x) => x.id === id);
  const messages = await api(`/admin/textable/threads/${id}/messages`);
  const done = !!t.importedAt;

  // Choices: link to a contact on this phone, a new contact (optionally copied
  // from someone with the same name and a different phone), texts only, or skip
  const options = h('div', { class: 'choice-list' });
  const nickname = h('input', { type: 'text', name: 'nickname', value: t.action === 'link' || t.action === 'create' ? t.nickname : t.label.nick, placeholder: 'Nickname (optional)' });
  const first = h('input', { type: 'text', name: 'firstName', value: t.firstName || t.label.first || t.greetings[0]?.name || '' });
  const last = h('input', { type: 'text', name: 'lastName', value: t.lastName || t.label.last || '' });
  let copyFrom = t.copyFrom ?? null;
  const copyNote = h('span', { class: 'hint' });
  const choice = (value, label, extra = {}) => h('label', { class: 'choice' },
    h('input', { type: 'radio', name: 'choice', value, checked: extra.checked, disabled: done, onchange: extra.onchange }), h('span', {}, label));
  const current = t.action === 'link' ? `link:${t.contactId}` : t.action;

  const contactLabel = (c) => [h('strong', {}, c.name), h('span', { class: 'hint' },
    [c.patientId && `#${c.patientId}`, c.dob, c.inactive && 'inactive', c.why?.length && c.why.join(', ')].filter(Boolean).join(' · '))];
  const addCandidates = (cands) => {
    for (const c of cands) {
      if (options.querySelector(`[data-contact="${c.id}"]`)) continue;
      const el = c.samePhone
        ? choice(`link:${c.id}`, ['Link to ', ...contactLabel(c)], { checked: current === `link:${c.id}` })
        : choice('create', ['New contact for this phone, copied from ', ...contactLabel(c), h('span', { class: 'hint' }, ` (has ${formatPhone(c.phone) || 'no phone'})`)], {
          onchange: () => {
            first.value = c.name.replace(/^"[^"]*"\s*/, '').split(' ')[0];
            last.value = c.name.replace(/^"[^"]*"\s*/, '').split(' ').slice(1).join(' ');
            copyFrom = c.id;
            copyNote.textContent = `Date of birth and email are copied from ${c.name}.`;
          },
        });
      el.dataset.contact = c.id;
      options.append(el);
    }
  };
  addCandidates(t.candidates);
  options.append(
    choice('create', ['New contact: ', h('span', { class: 'hint' }, 'first and last name below')], { checked: current === 'create', onchange: () => { copyFrom = null; copyNote.textContent = ''; } }),
    choice('phone', ['Texts only, no contact', h('span', { class: 'hint' }, 'The conversation shows the phone\'s current contact, or the number')], { checked: current === 'phone' }),
    choice('skip', ['Don\'t import this conversation'], { checked: current === 'skip' }));

  // Find any contact by name or phone
  const results = h('div', { class: 'hint' });
  const finder = h('input', { type: 'search', placeholder: 'Find another contact by name or phone', disabled: done });
  let timer;
  finder.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = finder.value.trim();
      if (q.length < 2) return fill(results);
      const found = await api(`/contacts?status=all&limit=8&q=${encodeURIComponent(q)}`);
      const rows = (found.contacts ?? found).map((c) => ({
        id: c.id, name: [c.nickname && `"${c.nickname}"`, c.firstName, c.lastName].filter(Boolean).join(' '), phone: c.phone,
        patientId: c.patientId, dob: c.dob, inactive: !!c.inactiveAt, samePhone: c.phone === t.phone,
      }));
      fill(results, rows.length ? `${plural(rows.length, 'contact')} added to the choices above` : 'No contacts found');
      addCandidates(rows);
    }, 250);
  });
  finder.addEventListener('keydown', (e) => e.key === 'Enter' && e.preventDefault());

  const next = h('input', { type: 'checkbox', checked: true });
  const facts = [
    `${plural(t.messages, 'text')}, ${day(t.firstAt)} – ${day(t.lastAt)}`,
    t.greetings.length > 0 && `Texts greet them as ${t.greetings.map((g) => `"${g.name}"${g.count > 1 ? ` ×${g.count}` : ''}`).join(', ')}`,
    ...t.fileNotes,
  ].filter(Boolean);

  dialog(labelText(t), [
    h('p', { class: 'dialog-text' }, h('strong', {}, formatPhone(t.phone)), h('span', { class: 'muted' }, ` · ${t.file}`)),
    h('ul', { class: 'facts' }, facts.map((f) => h('li', {}, f)), t.reasons.map((r) => h('li', { class: 'reason' }, r))),
    h('div', { class: 'thread-preview' }, messages.map((m) => h('div', { class: `bubble ${m.direction}` },
      m.body, m.attachments.length > 0 && h('div', { class: 'hint' }, `📎 ${m.attachments.map((a) => a.filename).join(', ')} (not in the export)`),
      h('div', { class: 'when' }, new Date(m.createdAt).toLocaleString())))),
    done
      ? h('p', { class: 'callout ok' }, icon('shield'), h('span', {}, `Imported ${relTime(t.importedAt)}: `, plan(t)))
      : [
        h('div', { class: 'field-label' }, 'What to do'),
        options, finder, results,
        h('div', { class: 'form-grid three' },
          h('label', {}, 'First name (new contact)', first),
          h('label', {}, 'Last name (new contact)', last),
          h('label', {}, 'Nickname', nickname)),
        copyNote,
        h('label', { class: 'switch-label inline' }, next, h('span', {}, 'Open the next one after confirming')),
      ],
  ], done ? null : 'Confirm', async (form) => {
    const value = form.get('choice');
    if (!value) throw new Error('Choose what to do with this conversation');
    const [action, contactId] = value.split(':');
    const body = { action, contactId, firstName: form.get('firstName'), lastName: form.get('lastName'), nickname: form.get('nickname'), copyFrom: action === 'create' ? copyFrom : null };
    const updated = await api(`/admin/textable/threads/${id}`, { method: 'PUT', body });
    Object.assign(t, updated);
    await reload();
    if (next.checked) {
      const after = list.slice(list.findIndex((x) => x.id === id) + 1).find((x) => !x.confirmed && !x.importedAt);
      if (after) setTimeout(() => openThread(after.id, list, reload), 0);
    }
  }, { wide: 'xl' });
  // Show the latest texts first
  const preview = document.querySelector('dialog[open] .thread-preview');
  if (preview) preview.scrollTop = preview.scrollHeight;
}
