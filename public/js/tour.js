// Guided tour: a click-through overlay that spotlights parts of the real app,
// shown once on a person's first sign-in and again from ⋮ → Help → Welcome tour.
// Ends with a checklist of setup still to do on this account and device.

import { h, fill, icon, state, api } from './core.js';

const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isPhone = () => matchMedia('(max-width: 760px)').matches;
const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function visible(selector) {
  for (const el of document.querySelectorAll(selector)) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden') return el;
  }
  return null;
}

async function waitFor(selector, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const el = visible(selector);
    if (el) return el;
    await wait(80);
  }
  return null;
}

const goHome = async () => {
  if (location.hash.startsWith('#/c/') || location.hash.startsWith('#/contacts') || location.hash.startsWith('#/admin') || location.hash.startsWith('#/security')) location.hash = '#/';
  await waitFor('.conv-list');
};

function firstConversation() {
  return document.querySelector('.conv-list .conv-link')?.getAttribute('href') ?? null;
}

const openFirstConversation = async () => {
  const href = firstConversation();
  if (href && location.hash !== href) location.hash = href;
  await waitFor('.pane .composer-tools', 3000);
};

// How to install TextBoss as an app (a progressive web app) on each kind of device
const INSTALL = [
  ['iphone', 'iPhone and iPad', ['Open TextBoss in Safari.', 'Tap the Share button (the square with an arrow).', 'Tap Add to Home Screen, then Add.', 'Open TextBoss from the new icon and sign in. Notifications on iPhone only work from this icon.']],
  ['android', 'Android', ['Open TextBoss in Chrome.', 'Tap ⋮ (top right), then Add to Home screen or Install app.', 'Open it from the new icon.']],
  ['mac', 'Mac', ['Open TextBoss in Safari.', 'Choose File → Add to Dock, then Add.', 'In Chrome or Edge instead: click the install icon at the right of the address bar.']],
  ['windows', 'Windows', ['Open TextBoss in Edge or Chrome.', 'Click the install icon at the right of the address bar (or ⋯ → Apps → Install this site as an app).', 'Pin it to the taskbar or Start menu if you like.']],
];
function thisDevice() {
  const ua = navigator.userAgent;
  if (isIos()) return 'iphone';
  if (/Android/.test(ua)) return 'android';
  if (/Mac/.test(ua)) return 'mac';
  if (/Windows/.test(ua)) return 'windows';
  return null;
}

function installBody() {
  const mine = thisDevice();
  const section = ([id, name, list]) => [h('strong', {}, name), h('ol', { class: 'steps' }, list.map((t) => h('li', {}, t)))];
  const others = INSTALL.filter(([id]) => id !== mine);
  return [
    h('p', {}, 'Add TextBoss to your home screen, Dock or taskbar so it opens like a regular app: its own icon and window, no browser bar, and an unread count on the icon.'),
    isIos() && h('p', {}, h('strong', {}, 'On iPhone and iPad this is required for notifications.')),
    mine && section(INSTALL.find(([id]) => id === mine)),
    h('details', { class: 'tour-more' }, h('summary', {}, mine ? 'Other devices' : 'Show the steps'), others.map(section)),
  ];
}

function steps(actions) {
  const admin = state.me.isAdmin;
  const hasConv = !!firstConversation();
  return [
    {
      title: `Welcome to TextBoss, ${state.me.displayName.split(' ')[0]}`,
      body: [
        'TextBoss is your team\'s shared inbox for texting clients from your organization\'s phone numbers.',
        'This quick tour shows you around in about a minute. Use Next, or the arrow keys.',
      ],
    },
    {
      target: '.conv-list', before: goHome,
      title: 'Conversations',
      body: [
        'Every text to and from your organization lands here, newest first. Unread ones are bold.',
        'The whole team shares these threads, so everyone sees the same history no matter who replied.',
        isPhone() ? null : 'Hover over a conversation to pin it to the top or flag it for follow-up.',
      ],
    },
    {
      target: '.side-head select', when: () => state.numbers.length > 1, before: goHome,
      title: 'Your numbers',
      body: ['Switch between your organization\'s phone numbers, or see them all at once. New messages go out from the number you pick.'],
    },
    {
      target: '.side-head input[type=search]', before: goHome,
      title: 'Search',
      body: ['Find any conversation by message text, a client\'s name, phone number or client ID.'],
    },
    {
      target: '.filter-chips', before: goHome,
      title: 'Filters',
      body: ['Show only unread or flagged conversations. Archived ones are tucked away here too, and come back by themselves when the client texts again.'],
    },
    {
      target: '.new-btn', before: goHome,
      title: 'Start a new text',
      body: ['Text a phone number or a contact, or several people at once for a group text.', isPhone() ? null : 'Shortcut: press N.'],
    },
    {
      target: '.pane .thread-head', when: () => hasConv, before: openFirstConversation,
      title: 'A conversation',
      body: [
        isPhone()
          ? `Up top: the client's contact card, and ⋮ to pin, flag, mark as unread, archive or opt out${admin ? ', or block a sender' : ''}. The arrow takes you back to the list.`
          : `Up top: pin, flag, the client's contact card, and ⋮ for more, like mark as unread, archive or opt out${admin ? ', or block a sender' : ''}.`,
        admin ? 'As an admin you can also delete a conversation\'s history from ⋮.' : null,
      ],
    },
    {
      target: '.pane .messages', when: () => hasConv, before: openFirstConversation, place: 'over',
      title: 'Who said what',
      body: [
        'Clients are on the left and your team is on the right.',
        'Every text from your team shows who sent it. A teammate\'s are a different shade from yours, so you can see at a glance who already replied.',
      ],
    },
    {
      target: '.pane .composer-tools', when: () => hasConv, before: openFirstConversation,
      title: 'Writing a reply',
      body: [
        'Attach photos or PDFs, add an emoji, or insert a canned response: a saved reply that can fill in the client\'s name for you.',
        'If a client opted out of texts, TextBoss warns you before anything is sent.',
      ],
    },
    {
      target: '.conv-list .conv', when: () => hasConv && matchMedia('(min-width: 1100px)').matches, before: goHome,
      title: 'Side by side',
      body: ['Cmd-click (Ctrl-click on Windows) a conversation, or use its Open beside button, to keep up to three conversations open at once.'],
    },
    {
      target: '.tabs a[data-tab=contacts]', before: goHome,
      title: 'Contacts',
      body: [
        'Clients\' names, phone numbers, birthdays and notes. Select several to put them in a list, then text the whole list at once, for example to announce a weather closure.',
        'Each client gets their own copy, and anyone who opted out is skipped.',
      ],
    },
    {
      target: '.bell-btn', before: goHome,
      title: 'Notifications',
      body: [
        'Get an alert when a client texts, even when TextBoss is closed. Each phone and computer is set up once.',
        'After that, tap the bell to pause alerts on this device and tap it again to turn them back on.',
      ],
    },
    {
      when: () => !isStandalone(), before: goHome,
      title: 'Install TextBoss as an app',
      render: installBody,
    },
    {
      target: '.side-top .icon-btn[title=Menu]', before: goHome,
      title: 'The menu',
      body: [
        'My account (password, passkeys and your email), Appearance (colors and your own app icon), Notifications, and Help: the full user manual and this tour again.',
        admin ? 'Admin settings live here too: your texting provider, numbers, users, email and contact imports.' : null,
      ],
    },
    { checklist: true, before: goHome, title: 'Finish setting up', actions },
  ];
}

async function checklistItems(actions) {
  const sec = await api('/me/security').catch(() => ({}));
  const bell = document.querySelector('.bell-btn')?.dataset.state;
  const items = [
    {
      done: bell === 'on' || bell === 'paused',
      title: 'Turn on notifications on this device',
      text: isIos() && !isStandalone() ? 'On iPhone, add TextBoss to your Home Screen first (below).' : 'So you know when a client texts.',
      label: 'Turn on', run: actions.notifications,
    },
    // New accounts always have an email; only older ones can be missing it
    !sec.email && {
      done: false,
      title: 'Add your email address',
      text: 'Lets you reset a forgotten password, or get a sign-in code if you don\'t have your phone.',
      label: 'Add email', run: actions.security,
    },
    {
      done: !!sec.enabled,
      title: 'Turn on two-factor sign-in',
      text: 'A passkey (Face ID, Touch ID, Windows Hello) or an authenticator app keeps client messages safe. Add a passkey on each device you use.',
      label: 'Set up', run: actions.security,
    },
  ];
  if (!isStandalone()) {
    items.push({
      done: false,
      title: 'Install TextBoss as an app',
      text: isIos() ? 'In Safari tap Share → Add to Home Screen. Needed for notifications on iPhone.'
        : /Android/.test(navigator.userAgent) ? 'In Chrome tap ⋮ → Add to Home screen (or Install app).'
        : /Mac/.test(navigator.userAgent) && !/Chrome|Edg\//.test(navigator.userAgent) ? 'In Safari choose File → Add to Dock.'
        : 'Click the install icon at the right of the address bar.',
    });
  }
  if (state.me.isAdmin) {
    items.push({
      done: false,
      title: 'Admin: check your settings',
      text: 'Connect your texting provider (BulkVS or VoIP.ms), add your numbers and staff, and set up email so staff can reset their own passwords.',
      label: 'Open', run: actions.admin,
    });
  }
  return items.filter(Boolean);
}

let active = null;

// Newer features, for people who already know the basics. Each step links to the manual.
function tipSteps() {
  const admin = state.me.isAdmin;
  return [
    {
      title: 'Tips and newer features',
      body: ['A quick look at features that are easy to miss. Each step has a link to the user manual if you want the details.'],
    },
    {
      target: '.client-panel', when: () => !!firstConversation(), before: async () => { await openFirstConversation(); await wait(300); },
      title: 'Client details beside the conversation',
      body: ['On a big screen, the client\'s phone, birthday, client ID, email, lists and notes sit beside the messages, so you don\'t have to leave the conversation to check them.'],
      fallback: 'Your window is too narrow to show it right now. Make the window wider, or open TextBoss on a bigger screen.',
      more: 'client-panel',
    },
    {
      target: '.pane .panel-toggle', when: () => !!firstConversation(), before: openFirstConversation,
      title: 'Show or hide the panel',
      body: ['This button hides or shows the client details. TextBoss remembers your choice on every device.'],
      more: 'client-panel',
    },
    {
      target: '.pane .thread-head', when: () => !!firstConversation(), before: openFirstConversation,
      title: 'Numbers several people share',
      body: [
        'A name followed by "+1" means more than one contact shares that phone number, like a parent and their children. The header lists everyone at the number.',
        'To choose whose name is shown, open that contact and click "Show this name for the number". It\'s also used for {first_name} in canned replies and bulk texts.',
      ],
      more: 'shared-numbers',
    },
    {
      target: '.pane .messages', place: 'over', when: () => !!firstConversation(), before: openFirstConversation,
      title: 'Who replied',
      body: ['Every text from your team shows who sent it, and a teammate\'s messages are a different shade from yours.'],
      more: 'conversations',
    },
    {
      target: '.conv-list .conv', when: () => matchMedia('(min-width: 1100px)').matches && !!firstConversation(), before: goHome,
      title: 'Several conversations at once',
      body: ['Cmd-click (Ctrl-click on Windows) a conversation, or use its Open beside button, to keep up to three open side by side.'],
      more: 'side-by-side',
    },
    {
      target: '.bell-btn', before: goHome,
      title: 'Pause notifications',
      body: ['Once notifications are set up on a device, one click on the bell pauses them, and another turns them back on. Each device is separate.'],
      more: 'notifications',
    },
    {
      target: '.side-top .icon-btn[title=Menu]', before: goHome,
      title: 'Make it yours',
      body: [
        '⋮ → Appearance sets how wide conversations are on big screens (Narrow, Comfortable or Full width), how the conversation stands out from the empty space beside it (Card, Shaded column or Plain), your colors and your own app icon.',
        admin ? 'As an admin, also look at Admin settings → Office hours, for automatic replies when you\'re closed, and the Inactive contacts card under Contacts & Import.' : null,
      ],
      more: 'appearance',
    },
    {
      title: 'The user manual',
      body: ['Everything TextBoss does is explained, with pictures, in the user manual. Open it any time from ⋮ → Help → User manual.'],
      link: { label: 'Open the user manual', href: '/manual/' },
    },
  ];
}

export function startTipsTour() {
  return startTour({ list: tipSteps() });
}

export async function startTour({ onFinish, actions, list: given }) {
  if (active) return;
  const list = given ?? steps(actions);
  let i = 0;

  const root = h('div', { class: 'tour', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tour-title' });
  const spot = h('div', { class: 'tour-spot' });
  const card = h('div', { class: 'tour-card' });
  root.append(spot, card);
  document.body.append(root);
  active = root;

  const finish = () => {
    window.removeEventListener('resize', place);
    document.removeEventListener('keydown', onKey, true);
    root.remove();
    active = null;
    onFinish?.();
  };

  let target = null;
  function place() {
    const pad = 6;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cw = Math.min(list[i].checklist || list[i].render ? 440 : 360, vw - 32);
    card.style.width = `${cw}px`;
    const ch = card.offsetHeight;
    if (!target) {
      spot.hidden = true;
      root.classList.add('dim');
      card.style.left = `${(vw - cw) / 2}px`;
      card.style.top = `${Math.max(16, (vh - ch) / 2)}px`;
      return;
    }
    root.classList.remove('dim');
    spot.hidden = false;
    const r = target.getBoundingClientRect();
    const top = Math.max(4, r.top - pad);
    const bottom = Math.min(vh - 4, r.bottom + pad);
    Object.assign(spot.style, { left: `${r.left - pad}px`, top: `${top}px`, width: `${r.width + pad * 2}px`, height: `${bottom - top}px` });
    let y;
    if (list[i].place !== 'over' && bottom + 12 + ch < vh) y = bottom + 12;
    else if (list[i].place !== 'over' && top - 12 - ch > 0) y = top - 12 - ch;
    else y = vh - ch - 16; // big target: float the card near the bottom, over it
    const x = Math.min(Math.max(16, r.left + r.width / 2 - cw / 2), vw - cw - 16);
    card.style.left = `${x}px`;
    card.style.top = `${Math.max(16, y)}px`;
  }

  const applies = (s) => !s.when || s.when();
  // dir: which way to look for the next step that applies here
  async function show(n, dir = 1) {
    while (n > 0 && n < list.length - 1 && !applies(list[n])) n += dir;
    i = Math.max(0, Math.min(list.length - 1, n));
    const step = list[i];
    card.classList.add('loading');
    await step.before?.();
    target = step.target ? await waitFor(step.target) : null;
    target?.scrollIntoView?.({ block: 'nearest' });

    const last = i === list.length - 1;
    let body = step.checklist ? await checklist(step.actions)
      : step.render ? step.render()
      : (Array.isArray(step.body) ? step.body : [step.body]).filter(Boolean).map((t) => h('p', {}, t));
    if (step.target && !target && step.fallback) body = [...body, h('p', { class: 'hint' }, step.fallback)];
    if (step.more) body = [...body, h('a', { class: 'tour-more-link', href: `/manual/#${step.more}`, target: '_blank', rel: 'noopener' }, 'Read more in the manual')];
    if (step.link) body = [...body, h('a', { class: 'btn', href: step.link.href, target: '_blank', rel: 'noopener' }, step.link.label)];
    const counted = list.filter(applies);
    const pos = counted.indexOf(step) + 1;
    fill(card,
      h('div', { class: 'tour-head' },
        h('h2', { id: 'tour-title' }, step.title),
        h('button', { class: 'icon-btn', title: 'Close tour', 'aria-label': 'Close tour', onclick: finish }, icon('close'))),
      h('div', { class: 'tour-body' }, body),
      h('div', { class: 'tour-foot' },
        h('span', { class: 'tour-count' }, `${pos} of ${counted.length}`),
        i > 0 && h('button', { class: 'btn', onclick: () => show(i - 1, -1) }, 'Back'),
        h('button', { class: 'btn primary', onclick: () => (last ? finish() : show(i + 1)) }, last ? 'Done' : i === 0 ? 'Start the tour' : 'Next')));
    card.classList.remove('loading');
    place();
    card.querySelector('.btn.primary')?.focus({ preventScroll: true });
  }

  async function checklist(acts) {
    const items = await checklistItems(acts);
    const left = items.filter((x) => !x.done).length;
    return [
      h('p', {}, left ? 'A few things to do so TextBoss works well for you. You can come back to these any time.' : 'You\'re all set up. Nice work!'),
      h('ul', { class: 'tour-checklist' }, items.map((x) => h('li', { class: x.done ? 'done' : '' },
        h('span', { class: 'tour-check', 'aria-hidden': 'true' }, x.done ? '✓' : ''),
        h('div', {}, h('strong', {}, x.title, x.done && h('span', { class: 'sr-only' }, ' (done)')), h('div', { class: 'hint' }, x.text)),
        !x.done && x.run && h('button', { class: 'btn', onclick: () => { finish(); x.run(); } }, x.label)))),
      h('p', { class: 'hint' }, 'Replay this tour any time from ⋮ → Help → Welcome tour.'),
    ];
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      finish();
    } else if (e.key === 'ArrowRight' && i < list.length - 1) {
      e.preventDefault();
      show(i + 1);
    } else if (e.key === 'ArrowLeft' && i > 0) {
      e.preventDefault();
      show(i - 1, -1);
    }
  }
  window.addEventListener('resize', place);
  document.addEventListener('keydown', onKey, true);
  show(0);
}
