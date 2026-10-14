// Canned responses: reusable messages, keyword auto-replies and the away message

import { h, fill, state, els, api, loadCanned, toast, dialog, confirmDialog, paneHead, uploadFile, ATTACH_ACCEPT, helpLink } from './core.js';

export async function renderCanned() {
  await loadCanned();
  const away = state.canned.find((c) => c.isAway);

  fill(els.main, 
    paneHead('Canned responses', h('div', { style: 'flex:1' }), helpLink('canned'), h('button', { class: 'btn primary', onclick: () => editCanned(null) }, 'Add canned response')),
    h('div', { class: 'admin' },
      h('section', {},
        h('p', { class: 'hint' }, 'Insert these from the ', h('strong', {}, 'canned responses'), ' button next to the message box. A keyword makes TextBoss reply automatically when someone texts exactly that word. The away message, when one is on, auto-replies to other incoming texts (once per conversation every 12 hours). Use it for unplanned closures; regular closed hours and holidays are set by an admin under Admin settings → Office hours. While an away message is on, it is sent instead of the after-hours reply.'),
        away && h('div', { class: 'away-on' }, h('strong', {}, 'Away message is on: '), away.name, ' ',
          h('button', { class: 'link-btn', onclick: () => save(away, { ...away, isAway: false }) }, 'Turn off'))),
      h('section', {},
        state.canned.length
          ? h('div', { class: 'canned-list' }, state.canned.map((c) =>
              h('div', { class: 'canned-item' },
                h('div', { class: 'canned-top' },
                  h('strong', {}, c.name),
                  c.keyword && h('span', { class: 'tag' }, `Keyword: ${c.keyword}`),
                  c.isAway && h('span', { class: 'tag warn' }, 'Away message'),
                  c.media.length > 0 && h('span', { class: 'tag' }, `${c.media.length} attachment${c.media.length > 1 ? 's' : ''}`),
                  h('div', { class: 'row-actions' },
                    h('button', { class: 'btn', onclick: () => editCanned(c) }, 'Edit'),
                    h('button', { class: 'btn danger', onclick: async () => {
                      if (!(await confirmDialog('Delete canned response?', `"${c.name}" will be deleted.`, 'Delete', { danger: true }))) return;
                      await api(`/canned/${c.id}`, { method: 'DELETE' });
                      renderCanned();
                    } }, 'Delete'))),
                h('div', { class: 'canned-body' }, c.body))))
          : h('p', { class: 'hint' }, 'No canned responses yet.')),
    ),
  );
}

async function save(existing, body) {
  if (existing) await api(`/canned/${existing.id}`, { method: 'PUT', body });
  else await api('/canned', { method: 'POST', body });
  toast('Saved');
  renderCanned();
}

function editCanned(c) {
  const media = [...(c?.media ?? [])];
  const mediaRow = h('div', { class: 'chips-row' });
  const drawMedia = () =>
    fill(mediaRow, ...media.map((url, i) =>
      h('span', { class: 'chip' }, url.split('/').pop().slice(0, 12) + '…',
        h('button', { type: 'button', onclick: () => { media.splice(i, 1); drawMedia(); } }, '×'))));
  drawMedia();
  const file = h('input', { type: 'file', accept: ATTACH_ACCEPT, hidden: true, onchange: async () => {
    for (const f of file.files) {
      try {
        media.push((await uploadFile(f)).url);
      } catch (err) {
        toast(err.message);
      }
    }
    file.value = '';
    drawMedia();
  } });
  const away = h('input', { type: 'checkbox', name: 'isAway', checked: !!c?.isAway, class: 'switch' });

  dialog(
    c ? 'Edit canned response' : 'Add canned response',
    [
      h('label', {}, 'Friendly name', h('input', { type: 'text', name: 'name', required: true, value: c?.name ?? '', placeholder: 'e.g. Weather cancellation' })),
      h('label', {}, 'Auto-reply to keyword (optional)', h('input', { type: 'text', name: 'keyword', value: c?.keyword ?? '', placeholder: 'e.g. HOURS', autocomplete: 'off' })),
      h('details', { class: 'help' }, h('summary', {}, 'Choosing keywords'),
        h('p', {}, 'A keyword should be one short word. It only triggers when the entire incoming text matches it exactly (any capitalization). For example, "please send me your hours" does not trigger HOURS. STOP, START, HELP and similar words are reserved by carriers.')),
      h('label', {}, 'Message body', h('textarea', { name: 'body', required: true, rows: 5 }, c?.body ?? '')),
      h('div', { class: 'hint' }, 'Merge fields: {first_name}, {last_name}, {full_name}, and {nickname} (the first name if there is no nickname) are filled in from the contact.'),
      h('label', { class: 'switch-label' }, away, h('span', {}, 'Away message', h('span', { class: 'hint' }, ' — auto-reply to incoming texts while this is on. Only one can be on.'))),
      h('div', {}, h('button', { type: 'button', class: 'btn', onclick: () => file.click() }, 'Upload attachment'), file),
      mediaRow,
    ],
    c ? 'Save' : 'Add canned response',
    async (data) => {
      await save(c, {
        name: data.get('name'),
        keyword: data.get('keyword'),
        body: data.get('body'),
        isAway: away.checked,
        media,
      });
    },
    { wide: true },
  );
}
