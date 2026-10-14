// Contacts tab: contact list with multi-select, contact form, lists and bulk messages

import {
  h, fill, icon, autoFocus, state, els, route, api, loadLists, toast, formatPhone, fullName, formatDob, numberLabel,
  numberOptions, avatar, initials, relTime, dialog, confirmDialog, paneHead, buildComposer, mergeFields,
} from './core.js';

const PAGE = 100;
let page = { contacts: [], total: 0 };

// ---------- Sidebar ----------

export function renderContactsSidebar() {
  let searchTimer;
  const search = h('input', {
    type: 'search',
    placeholder: 'Search name, phone, DOB, client ID',
    value: state.contactSearch,
    oninput: (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.contactSearch = e.target.value.trim();
        loadContacts();
      }, 250);
    },
  });

  els.contactFilter = h('select', {
    'aria-label': 'Show',
    onchange: (e) => {
      state.contactFilter = e.target.value;
      state.selected.clear();
      loadContacts();
    },
  });
  drawFilterOptions();

  els.listBar = h('div', { class: 'list-bar', hidden: true });
  els.contactCount = h('div', { class: 'contact-count' });
  els.contactList = h('div', { class: 'conv-list contact-list' });
  els.selectBar = h('div', { class: 'select-bar', hidden: true });

  fill(els.sideBody, 
    h('div', { class: 'side-head' },
      h('div', { class: 'side-search' }, search,
        h('button', { class: 'btn square', title: 'New contact', onclick: () => (location.hash = '#/contacts/new') }, icon('plus'))),
      els.contactFilter),
    els.listBar,
    els.contactCount,
    els.contactList,
    els.selectBar,
  );
  loadContacts();
}

function drawFilterOptions() {
  if (!els.contactFilter) return;
  fill(els.contactFilter, 
    h('option', { value: '' }, 'All contacts'),
    state.lists.length > 0 && h('optgroup', { label: 'Lists' },
      state.lists.map((l) => h('option', { value: `list:${l.id}` }, `${l.name} (${l.count})`))),
    h('optgroup', { label: 'Other' },
      h('option', { value: 'optedOut' }, 'Opted out'),
      h('option', { value: 'noPhone' }, 'No phone number')),
  );
  if (state.contactFilter.startsWith('list:') && !state.lists.some((l) => `list:${l.id}` === state.contactFilter)) {
    state.contactFilter = '';
  }
  els.contactFilter.value = state.contactFilter;
}

function queryParams(extra = {}) {
  const p = new URLSearchParams();
  if (state.contactSearch) p.set('q', state.contactSearch);
  const f = state.contactFilter;
  if (f.startsWith('list:')) p.set('list', f.slice(5));
  else if (f) p.set('filter', f);
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return p;
}

async function loadContacts(append = false) {
  const offset = append ? page.contacts.length : 0;
  let res;
  try {
    res = await api(`/contacts?${queryParams({ limit: PAGE, offset })}`);
  } catch (err) {
    toast(err.message);
    return;
  }
  page = { contacts: append ? [...page.contacts, ...res.contacts] : res.contacts, total: res.total };
  drawContacts();
}

export async function refreshContacts() {
  drawFilterOptions();
  if (els.contactList?.isConnected) await loadContacts();
  const r = route();
  if (r.view === 'contact' && r.id && !els.main.querySelector('form.contact-form.dirty')) renderContactsMain(r);
  if (r.view === 'contacts') renderContactsMain(r);
}

function drawContacts() {
  if (!els.contactList?.isConnected) return;
  const r = route();
  const allShownSelected = page.contacts.length > 0 && page.contacts.every((c) => state.selected.has(c.id));

  fill(els.contactCount, 
    h('label', { class: 'check' },
      h('input', {
        type: 'checkbox',
        checked: allShownSelected,
        disabled: !page.contacts.length,
        onchange: (e) => {
          for (const c of page.contacts) e.target.checked ? state.selected.add(c.id) : state.selected.delete(c.id);
          drawContacts();
        },
      }),
      `${page.total.toLocaleString()} contact${page.total === 1 ? '' : 's'}`),
    allShownSelected && page.total > page.contacts.length && h('button', {
      class: 'link-btn',
      onclick: async () => {
        const { ids } = await api(`/contacts?${queryParams({ limit: 1, ids: 1 })}`);
        ids.forEach((id) => state.selected.add(id));
        drawContacts();
      },
    }, `Select all ${page.total.toLocaleString()}`),
  );

  fill(els.contactList, 
    ...(page.contacts.length
      ? page.contacts.map((c) => {
          const name = fullName(c);
          return h('div', { class: `conv contact-row${r.view === 'contact' && r.id === c.id ? ' active' : ''}` },
            h('input', {
              type: 'checkbox',
              'aria-label': `Select ${name}`,
              checked: state.selected.has(c.id),
              onchange: (e) => {
                e.target.checked ? state.selected.add(c.id) : state.selected.delete(c.id);
                drawContacts();
              },
            }),
            h('a', { class: 'contact-link', href: `#/contacts/${c.id}` },
              avatar(`c${c.id}`, initials(name)),
              h('div', { class: 'main' },
                h('div', { class: 'name' }, name,
                  c.optedOut && h('span', { class: 'tag warn' }, 'Opted out'),
                  c.blocked && h('span', { class: 'tag' }, 'Blocked')),
                h('div', { class: 'preview' },
                  [c.phone ? formatPhone(c.phone) : 'No phone', c.dob && `DOB ${formatDob(c.dob)}`, c.patientId && `#${c.patientId}`]
                    .filter(Boolean).join(' · ')))));
        })
      : [h('div', { class: 'empty' }, state.contactSearch || state.contactFilter ? 'No matching contacts.' : 'No contacts yet. Add one, or import a file in Admin settings.')]),
    page.contacts.length < page.total && h('button', { class: 'btn load-more', onclick: () => loadContacts(true) }, 'Load more'),
  );

  drawListBar();
  drawSelectBar();
}

function currentList() {
  return state.contactFilter.startsWith('list:') ? state.lists.find((l) => `list:${l.id}` === state.contactFilter) : null;
}

function drawListBar() {
  const list = currentList();
  els.listBar.hidden = !list;
  if (!list) return;
  fill(els.listBar, 
    h('div', { class: 'list-name' }, list.name),
    h('button', {
      class: 'link-btn',
      onclick: async () => {
        const { ids } = await api(`/contacts?${queryParams({ limit: 1, ids: 1 })}`);
        state.selected = new Set(ids);
        location.hash = '#/bulk';
        drawContacts();
      },
    }, 'Message all'),
    h('button', {
      class: 'link-btn',
      onclick: () => dialog('Rename list', h('label', {}, 'Name', h('input', { type: 'text', name: 'name', value: list.name, required: true })), 'Save',
        async (data) => {
          await api(`/lists/${list.id}`, { method: 'PATCH', body: { name: data.get('name') } });
          await loadLists();
          drawFilterOptions();
          drawListBar();
        }),
    }, 'Rename'),
    h('button', {
      class: 'link-btn danger',
      onclick: async () => {
        if (!(await confirmDialog('Delete this list?', `"${list.name}" will be deleted. The contacts in it are kept.`, 'Delete list', { danger: true }))) return;
        await api(`/lists/${list.id}`, { method: 'DELETE' });
        state.contactFilter = '';
        await loadLists();
        drawFilterOptions();
        loadContacts();
      },
    }, 'Delete'),
  );
}

function drawSelectBar() {
  const n = state.selected.size;
  els.selectBar.hidden = !n;
  if (!n) return;
  const list = currentList();
  fill(els.selectBar, 
    h('div', { class: 'select-count' }, `${n.toLocaleString()} selected`),
    h('div', { class: 'select-actions' },
      h('button', { class: 'btn primary', onclick: () => (location.hash = '#/bulk') }, 'Message'),
      h('button', { class: 'btn', onclick: addToListDialog }, 'Add to list'),
      list && h('button', {
        class: 'btn',
        onclick: async () => {
          await api(`/lists/${list.id}/members`, { method: 'POST', body: { remove: [...state.selected] } });
          state.selected.clear();
          await loadLists();
          drawFilterOptions();
          loadContacts();
          toast(`Removed from ${list.name}`);
        },
      }, 'Remove from list'),
      state.me.isAdmin && h('button', {
        class: 'btn danger',
        onclick: async () => {
          if (!(await confirmDialog(`Delete ${n} contacts?`, 'The selected contacts will be permanently deleted. Their conversations are kept.', 'Delete', { danger: true }))) return;
          await api('/contacts/delete', { method: 'POST', body: { ids: [...state.selected] } });
          state.selected.clear();
          loadContacts();
        },
      }, 'Delete'),
      h('button', { class: 'link-btn', onclick: () => { state.selected.clear(); drawContacts(); } }, 'Clear')),
  );
}

function addToListDialog() {
  const ids = [...state.selected];
  const existing = h('select', { name: 'list' },
    h('option', { value: 'new' }, 'New list…'),
    state.lists.map((l) => h('option', { value: String(l.id) }, `${l.name} (${l.count})`)));
  const today = new Date().toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  const nameInput = h('input', { type: 'text', name: 'name', placeholder: `e.g. Weather closure ${today}` });
  const nameLabel = h('label', {}, 'New list name', nameInput);
  existing.addEventListener('change', () => (nameLabel.hidden = existing.value !== 'new'));
  dialog(`Add ${ids.length} to a list`, [h('label', {}, 'List', existing), nameLabel], 'Add', async () => {
    if (existing.value === 'new') {
      const name = nameInput.value.trim();
      if (!name) throw new Error('Give the list a name');
      const list = await api('/lists', { method: 'POST', body: { name, contactIds: ids } });
      state.contactFilter = `list:${list.id}`;
    } else {
      await api(`/lists/${existing.value}/members`, { method: 'POST', body: { add: ids } });
    }
    await loadLists();
    drawFilterOptions();
    loadContacts();
    toast('Added to list');
  });
  nameInput.focus();
}

// ---------- Main pane ----------

export function renderContactsMain(r) {
  if (r.view === 'contact') return renderContact(r.id, r.query);
  if (r.view === 'bulk') return renderBulk();
  if (r.view === 'broadcast') return renderBroadcast(r.id);
  return renderOverview();
}

async function renderOverview() {
  const broadcasts = await api('/broadcasts').catch(() => []);
  if (route().view !== 'contacts') return;
  fill(els.main, 
    h('div', { class: 'thread-head' }, h('div', { class: 'title' }, h('div', { class: 'name' }, 'Contacts'))),
    h('div', { class: 'admin' },
      h('section', {},
        h('p', { class: 'hint' }, 'Search and tick contacts on the left, then choose Message to text each of them individually, or Add to list to save the group for later.'),
        h('div', {}, h('button', { class: 'btn primary', onclick: () => (location.hash = '#/contacts/new') }, 'New contact'))),
      h('section', {},
        h('h2', {}, 'Recent bulk messages'),
        broadcasts.length
          ? h('div', { class: 'table-wrap' }, h('table', {},
              h('thead', {}, h('tr', {}, h('th', {}, 'Sent'), h('th', {}, 'Message'), h('th', {}, 'Progress'), h('th', {}, 'By'))),
              h('tbody', {}, broadcasts.map((b) => h('tr', { class: 'clickable', onclick: () => (location.hash = `#/bulk/${b.id}`) },
                h('td', {}, relTime(b.createdAt)),
                h('td', { class: 'clip' }, b.body),
                h('td', {}, progressText(b)),
                h('td', {}, b.createdBy ?? ''))))))
          : h('p', { class: 'hint' }, 'None yet.'))),
  );
}

function progressText(b) {
  const parts = [`${b.sent}/${b.total - b.skipped} sent`];
  if (b.failed) parts.push(`${b.failed} failed`);
  if (b.skipped) parts.push(`${b.skipped} skipped`);
  if (b.status !== 'done') parts.push(b.status);
  return parts.join(' · ');
}

// ----- Contact form -----

async function renderContact(id, query) {
  let c = { firstName: '', lastName: '', phone: query?.get('phone') ?? '', dob: '', email: '', patientId: '', notes: '', optedOut: false, lists: [] };
  if (id) {
    try {
      c = await api(`/contacts/${id}`);
    } catch (err) {
      fill(els.main, paneHead('Contact'), h('div', { class: 'placeholder' }, err.message));
      return;
    }
  }
  if (route().id !== id) return;
  drawContacts();

  const field = (label, name, attrs = {}) =>
    h('label', {}, label, h('input', { type: 'text', name, value: c[name] ?? '', ...attrs }));
  const optOut = h('input', { type: 'checkbox', name: 'optedOut', checked: c.optedOut });
  const setStatus = async (inactive) => {
    await api('/contacts/status', { method: 'POST', body: { ids: [id], inactive } });
    toast(inactive ? 'Marked inactive' : 'Active again');
    renderContact(id);
  };
  const error = h('div', { class: 'form-error' });

  const form = h('form', {
    class: 'contact-form',
    oninput: () => form.classList.add('dirty'),
    onsubmit: async (e) => {
      e.preventDefault();
      error.textContent = '';
      const data = Object.fromEntries(new FormData(form));
      data.optedOut = optOut.checked;
      try {
        const saved = id
          ? await api(`/contacts/${id}`, { method: 'PATCH', body: data })
          : await api('/contacts', { method: 'POST', body: data });
        form.classList.remove('dirty');
        toast('Contact saved');
        if (!id) location.hash = `#/contacts/${saved.id}`;
        else renderContact(id);
      } catch (err) {
        error.textContent = err.message;
      }
    },
  },
    h('div', { class: 'form-grid' },
      field('First name', 'firstName', { autocomplete: 'off' }),
      field('Last name', 'lastName', { autocomplete: 'off' }),
      field('Nickname', 'nickname', { autocomplete: 'off', placeholder: 'Shown as "Nickname" First Last' }),
      h('div'),
      field('Mobile phone', 'phone', { type: 'tel', value: c.phone ? formatPhone(c.phone) : '' }),
      field('Date of birth', 'dob', { type: 'date' }),
      field('Email', 'email', { type: 'email' }),
      field('Client ID', 'patientId'),
    ),
    h('label', {}, 'Notes', h('textarea', { name: 'notes', rows: 4 }, c.notes ?? '')),
    h('label', { class: `optout-check${c.optedOut ? ' on' : ''}` },
      optOut,
      h('div', {},
        h('strong', {}, 'Opted out of texts'),
        h('div', { class: 'hint' }, 'Sending to an opted-out number requires a confirmation. This is set automatically when someone replies STOP, and cleared when they reply START.',
          c.sharedPhone ? ` It applies to the phone number, which ${c.sharedPhone} other contact${c.sharedPhone > 1 ? 's share' : ' shares'}.` : ''))),
    c.inactiveAt && h('div', { class: 'callout warn' }, icon('warning'),
      h('div', {},
        h('strong', {}, 'Inactive. '),
        `${{ import: 'Not in a client import', idle: 'No activity for a while', manual: 'Marked inactive' }[c.inactiveReason] ?? 'Marked inactive'} (${relTime(c.inactiveAt)}). Hidden from Contacts and bulk messages. Texting them makes them active again. `,
        h('button', { type: 'button', class: 'link-btn', onclick: () => setStatus(false) }, 'Make active'))),
    c.sharedWith?.length > 0 && h('div', { class: 'shared-phone' }, icon('user'),
      h('span', {}, 'Also at this number: ',
        c.sharedWith.map((o, i) => [i > 0 && ', ', h('a', { href: `#/contacts/${o.id}` }, o.name), o.inactive && h('span', { class: 'hint' }, ' (inactive)')]),
        h('span', { class: 'hint' }, '. Conversations with this number show the first contact\'s name and "+', String(c.sharedWith.length), '". If one is a duplicate, delete it or merge the details.'))),
    c.blocked && h('p', { class: 'hint bad' }, 'Texts from this number are blocked. ',
      h('button', { type: 'button', class: 'link-btn', onclick: async () => {
        await api(`/phones/${c.phone}/block`, { method: 'PUT', body: { blocked: false } });
        toast('Unblocked');
        renderContact(id);
      } }, 'Unblock')),
    c.lists?.length > 0 && h('div', { class: 'chips-row' }, h('span', { class: 'hint' }, 'Lists: '),
      c.lists.map((l) => h('a', { class: 'chip', href: '#/contacts', onclick: () => { state.contactFilter = `list:${l.id}`; drawFilterOptions(); loadContacts(); } }, l.name))),
    error,
    h('div', { class: 'form-actions' },
      h('button', { class: 'btn primary', type: 'submit' }, id ? 'Save' : 'Create contact'),
      id && c.phone && h('button', { class: 'btn', type: 'button', onclick: () => messageContact(c) }, 'Message'),
      id && !c.inactiveAt && h('button', { class: 'btn', type: 'button', title: 'Hide from Contacts and searches, e.g. a discharged client', onclick: () => setStatus(true) }, 'Mark inactive'),
      id && state.me.isAdmin && h('button', {
        class: 'btn danger',
        type: 'button',
        onclick: async () => {
          if (!(await confirmDialog('Delete this contact?', `${fullName(c)} will be permanently deleted. Their conversations are kept.`, 'Delete', { danger: true }))) return;
          await api(`/contacts/${id}`, { method: 'DELETE' });
          state.selected.delete(id);
          location.hash = '#/contacts';
        },
      }, 'Delete')),
  );

  fill(els.main, 
    paneHead(id ? fullName(c) : 'New contact', id && avatar(`c${id}`, initials(fullName(c)))),
    h('div', { class: 'admin' }, form),
  );
  autoFocus(form.querySelector('input'));
}

async function messageContact(c) {
  if (!state.numbers.length) return toast('No numbers you can send from');
  const open = async (numberId) => {
    const { id } = await api('/conversations', { method: 'POST', body: { numberId, to: [c.phone] } });
    location.hash = `#/c/${id}`;
  };
  if (state.numbers.length === 1) return open(state.numbers[0].id);
  const select = h('select', { name: 'numberId' }, numberOptions());
  dialog(`Message ${fullName(c)}`, h('label', {}, 'From', select), 'Open conversation', () => open(Number(select.value)));
}

// ----- Bulk message -----

let bulkRender = 0;

async function renderBulk() {
  const ids = [...state.selected];
  if (!ids.length) {
    fill(els.main, paneHead('Bulk message'),
      h('div', { class: 'placeholder' }, 'Tick contacts in the list on the left, then choose Message.'));
    return;
  }
  if (!state.numbers.length) {
    fill(els.main, paneHead('Bulk message'), h('div', { class: 'placeholder' }, 'There are no numbers you can send from.'));
    return;
  }
  const token = ++bulkRender;
  const contacts = await api('/contacts/lookup', { method: 'POST', body: { ids } });
  if (route().view !== 'bulk' || token !== bulkRender) return;

  const noPhone = contacts.filter((c) => !c.phone);
  const optedOut = contacts.filter((c) => c.phone && (c.optedOut || c.blocked));
  const textable = contacts.filter((c) => c.phone && !c.optedOut && !c.blocked);
  const phones = new Set(textable.map((c) => c.phone));
  // Matches the server: one text per phone, unless merge fields make them differ
  const textCount = (text) => new Set(textable.map((c) => `${c.phone}\n${mergeFields(text, c)}`)).size;
  const plural = (n) => `${n} ${n === 1 ? 'text' : 'texts'}`;

  const fromSelect = h('select', {}, numberOptions());
  if (state.filterNumber !== 'all') fromSelect.value = state.filterNumber;
  const preview = h('div', { class: 'bubble-preview', hidden: true });
  const error = h('div', { class: 'form-error' });
  const summary = h('strong', {});

  const composer = buildComposer(async (body, media) => {
    if (!textable.length) throw new Error('None of the selected contacts can be texted');
    const n = textCount(body);
    const ok = await confirmDialog(
      `Send ${plural(n)}?`,
      `Each person gets their own text from ${numberLabel(Number(fromSelect.value))}. ` +
        (optedOut.length + noPhone.length ? `${optedOut.length + noPhone.length} selected contacts will be skipped. ` : '') +
        'Replies arrive in their individual conversations.',
      'Send',
    );
    if (!ok) return false;
    const b = await api('/broadcasts', { method: 'POST', body: { numberId: Number(fromSelect.value), contactIds: ids, body, media } });
    state.selected.clear();
    drawContacts();
    location.hash = `#/bulk/${b.id}`;
  }, { errorEl: error, placeholder: 'Message. Use {first_name} to personalize.', sendLabel: 'Send' });

  // Live count, and how the first recipient will see it
  const update = () => {
    const text = composer.textarea.value;
    const n = textCount(text);
    summary.textContent = `${plural(n)} to ${phones.size} ${phones.size === 1 ? 'number' : 'numbers'}`;
    composer.sendBtn.textContent = `Send ${plural(n)}`;
    preview.hidden = !/\{((first|last|full)_name|nickname)\}/i.test(text) || !textable.length;
    fill(preview, h('div', { class: 'hint' }, `Preview for ${fullName(textable[0] ?? {})}:`),
      h('div', { class: 'bubble' }, mergeFields(text, textable[0])));
  };
  composer.textarea.addEventListener('input', update);
  update();

  const names = (arr) => arr.slice(0, 50).map(fullName).join(', ') + (arr.length > 50 ? `, and ${arr.length - 50} more` : '');

  fill(els.main, 
    paneHead('Bulk message'),
    h('div', { class: 'admin bulk' },
      h('section', {},
        state.numbers.length > 1 && h('label', { class: 'inline-label' }, 'From', fromSelect),
        h('div', { class: 'recipient-summary' },
          h('div', {}, summary,
            textable.length !== phones.size ? ` · ${textable.length} contacts share ${phones.size} phones; a shared phone gets one text unless {first_name} makes them differ` : ''),
          h('details', {}, h('summary', {}, 'Show recipients'), h('p', { class: 'hint' }, names(textable))),
          optedOut.length > 0 && h('div', { class: 'warn-text' }, `${optedOut.length} opted out or blocked, will be skipped: ${names(optedOut)}`),
          noPhone.length > 0 && h('div', { class: 'warn-text' }, `${noPhone.length} with no phone number, will be skipped: ${names(noPhone)}`)),
        h('div', { class: 'hint' }, 'Merge fields: {first_name}, {last_name}, {full_name}, {nickname} (falls back to the first name). Texts go out one per second; you can leave this page while they send.'),
        h('div', {}, h('button', { class: 'link-btn', onclick: addToListDialog }, 'Save these recipients as a list'))),
      preview,
      error,
    ),
    composer,
  );
  autoFocus(composer.textarea);
}

// ----- Bulk message progress -----

async function renderBroadcast(id) {
  let b;
  try {
    b = await api(`/broadcasts/${id}`);
  } catch (err) {
    fill(els.main, paneHead('Bulk message'), h('div', { class: 'placeholder' }, err.message));
    return;
  }
  if (route().id !== id) return;
  const done = b.sent + b.failed + b.skipped;
  const pct = b.total ? Math.round((done / b.total) * 100) : 100;
  const label = { running: 'Sending…', done: 'Finished', cancelled: 'Cancelled' }[b.status] ?? b.status;

  fill(els.main, 
    paneHead('Bulk message'),
    h('div', { class: 'admin' },
      h('section', {},
        h('div', { class: 'bubble-preview' }, h('div', { class: 'bubble' }, b.body)),
        h('div', { class: 'hint' }, `From ${numberLabel(b.numberId)} · by ${b.createdBy ?? 'unknown'} · ${new Date(b.createdAt).toLocaleString()}`),
        h('div', { class: 'progress' }, h('div', { class: 'progress-bar', style: `width:${pct}%` })),
        h('div', {}, h('strong', {}, label), ` · ${progressText(b)}`),
        b.status === 'running' && h('div', {}, h('button', {
          class: 'btn danger',
          onclick: async () => {
            await api(`/broadcasts/${id}/cancel`, { method: 'POST' });
            renderBroadcast(id);
          },
        }, 'Stop sending'))),
      h('section', {},
        h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Phone'), h('th', {}, 'Status'), h('th', {}, 'Message'))),
          h('tbody', {}, b.items.map((it) => h('tr', {},
            h('td', {}, formatPhone(it.phone)),
            h('td', { class: it.status === 'failed' ? 'bad' : it.status === 'sent' ? 'ok' : '' }, it.status, it.error ? ` (${it.error})` : ''),
            h('td', { class: 'clip' }, it.body)))))))),
  );
}

let broadcastTimer;
export function onBroadcastEvent(b) {
  const r = route();
  if (r.view === 'broadcast' && r.id === b.id) {
    clearTimeout(broadcastTimer);
    broadcastTimer = setTimeout(() => renderBroadcast(b.id), 300);
  }
}
