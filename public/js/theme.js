// Appearance: preset or custom brand colors, light/dark/auto mode, and the
// app icon design. Saved per user on the server, cached in localStorage so the
// page paints in the right colors before /api/me answers.

import { h, api, toast, dialog, store } from './core.js';
import { LOGO_PRESETS, DEFAULT_LOGO, normalizeLogo, logoSvg, renderPngs, applyLogo } from './logo.js';

export const PRESETS = [
  { id: 'textboss', name: 'TextBoss', accent: '#12b4d6', highlight: '#ff4b2b' },
  { id: 'classic', name: 'Classic blue', accent: '#2f6fed', highlight: '#2f6fed' },
  { id: 'forest', name: 'Forest', accent: '#2f8f5b', highlight: '#e0a100' },
  { id: 'plum', name: 'Plum', accent: '#7a4fd6', highlight: '#e0457b' },
  { id: 'sunset', name: 'Sunset', accent: '#e8590c', highlight: '#c2255c' },
  { id: 'ocean', name: 'Ocean', accent: '#0b7285', highlight: '#f08c00' },
  { id: 'slate', name: 'Slate', accent: '#475569', highlight: '#0ea5e9' },
  { id: 'rose', name: 'Rose', accent: '#d6336c', highlight: '#7048e8' },
];
export const DEFAULT_THEME = { preset: 'textboss', accent: '#12b4d6', highlight: '#ff4b2b', mode: 'auto', logo: DEFAULT_LOGO, convWidth: 'comfortable', clientPanel: true };

// Widest a conversation's messages and composer get before they're centered
const CONV_WIDTHS = { narrow: '520px', comfortable: '620px', full: '100000px' };

let current = DEFAULT_THEME;
export const currentLogo = () => normalizeLogo(current.logo);

// Black or white text, whichever contrasts more with the color (WCAG luminance)
function textOn(hex) {
  const lin = (c) => {
    const v = parseInt(hex.slice(c, c + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * lin(1) + 0.7152 * lin(3) + 0.0722 * lin(5);
  return (L + 0.05) / 0.05 > 1.05 / (L + 0.05) ? '#0d0f12' : '#ffffff';
}

export function applyTheme(theme) {
  const t = { ...DEFAULT_THEME, ...(theme ?? {}) };
  t.logo = normalizeLogo(t.logo);
  current = t;
  const root = document.documentElement;
  root.style.setProperty('--brand', t.accent);
  root.style.setProperty('--brand-text', textOn(t.accent));
  root.style.setProperty('--brand-2', t.highlight);
  root.style.setProperty('--brand-2-text', textOn(t.highlight));
  if (t.mode === 'auto') delete root.dataset.mode;
  else root.dataset.mode = t.mode;
  root.style.setProperty('--conv-max', CONV_WIDTHS[t.convWidth] ?? CONV_WIDTHS.comfortable);
  root.classList.toggle('no-client-panel', t.clientPanel === false);
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', t.accent);
  applyLogo(t.logo, t.iconId);
  store('tb.theme', JSON.stringify(t));
  return t;
}

// Paint from the cached theme immediately on load
try {
  applyTheme(JSON.parse(store('tb.theme') ?? 'null'));
} catch {
  applyTheme(null);
}

const ANGLES = [['up', 'Diagonal ↗'], ['diag', 'Diagonal ↘'], ['down', 'Top to bottom'], ['solid', 'Solid color']];

// The app icon part of the Appearance dialog
function logoDesigner(getLogo, setLogo) {
  const presets = h('div', { class: 'logo-presets' });
  const big = h('div', { class: 'logo-preview-big' });
  const small = h('div', { class: 'logo-preview-small' });
  const color = (title) => h('input', { type: 'color', title });
  const bg1 = color('Background color 1');
  const bg2 = color('Background color 2');
  const bg3 = color('Background color 3');
  const threeColors = h('input', { type: 'checkbox' });
  const angle = h('select', {}, ANGLES.map(([v, label]) => h('option', { value: v }, label)));
  const c1 = color('Bubble color');
  const c2 = color('Second bubble color');
  const scale = h('input', { type: 'range', min: 60, max: 130, step: 1 });
  const scaleOut = h('span', { class: 'hint' });

  const draw = () => {
    const l = getLogo();
    presets.replaceChildren(...LOGO_PRESETS.map((p) =>
      h('button', { type: 'button', class: `logo-preset${l.preset === p.id ? ' on' : ''}`, title: p.name, onclick: () => setLogo({ ...p, preset: p.id }) },
        h('span', { html: logoSvg(p, { size: 52 }) }), h('span', { class: 'swatch-name' }, p.name))));
    big.innerHTML = logoSvg(l, { size: 96 });
    small.innerHTML = logoSvg(l, { size: 40 }) + logoSvg(l, { size: 20 });
    bg1.value = l.bg[0];
    bg2.value = l.bg[1];
    bg3.value = l.bg[2] ?? '#ff7aa8';
    threeColors.checked = !!l.bg[2];
    bg3.disabled = !l.bg[2] || l.angle === 'solid';
    bg2.disabled = l.angle === 'solid';
    angle.value = l.angle;
    c1.value = l.c1;
    c2.value = l.c2;
    scale.value = Math.round(l.scale * 100);
    scaleOut.textContent = `${Math.round(l.scale * 100)}%`;
  };
  const custom = (patch) => setLogo({ ...getLogo(), ...patch, preset: 'custom' });
  bg1.addEventListener('input', () => custom({ bg: [bg1.value, getLogo().bg[1], getLogo().bg[2]] }));
  bg2.addEventListener('input', () => custom({ bg: [getLogo().bg[0], bg2.value, getLogo().bg[2]] }));
  bg3.addEventListener('input', () => custom({ bg: [getLogo().bg[0], getLogo().bg[1], bg3.value] }));
  threeColors.addEventListener('change', () => custom({ bg: [getLogo().bg[0], getLogo().bg[1], threeColors.checked ? bg3.value : null] }));
  angle.addEventListener('change', () => custom({ angle: angle.value }));
  c1.addEventListener('input', () => custom({ c1: c1.value }));
  c2.addEventListener('input', () => custom({ c2: c2.value }));
  scale.addEventListener('input', () => custom({ scale: Number(scale.value) / 100 }));

  const el = h('div', { class: 'logo-designer' },
    presets,
    h('div', { class: 'logo-custom' },
      h('div', { class: 'logo-previews' }, big, small),
      h('div', { class: 'logo-controls' },
        h('div', { class: 'logo-row' }, h('span', { class: 'logo-row-label' }, 'Background'), bg1, bg2,
          h('label', { class: 'check small' }, threeColors, bg3)),
        h('div', { class: 'logo-row' }, h('span', { class: 'logo-row-label' }, 'Direction'), angle),
        h('div', { class: 'logo-row' }, h('span', { class: 'logo-row-label' }, 'Bubble'), c1, c2),
        h('div', { class: 'logo-row' }, h('span', { class: 'logo-row-label' }, 'Size'), scale, scaleOut))),
    h('p', { class: 'hint' }, 'Used for your browser tab, the sidebar and notifications right away. Your home-screen icon changes the next time you add TextBoss to the Home Screen (remove it and add it again) — iPhone, Android and Mac all keep the icon from when the app was added.'));
  el.redraw = draw;
  draw();
  return el;
}

export function themePicker(currentTheme, onSaved = () => {}) {
  const original = { ...DEFAULT_THEME, ...(currentTheme ?? {}) };
  original.logo = normalizeLogo(original.logo);
  let t = { ...original };
  let saved = false;

  const accent = h('input', { type: 'color', value: t.accent });
  const highlight = h('input', { type: 'color', value: t.highlight });
  const swatches = h('div', { class: 'swatches' });
  const modes = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Mode' });
  let designer;

  const update = (patch) => {
    t = { ...t, ...patch };
    t.logo = normalizeLogo(t.logo);
    applyTheme(t); // live preview
    accent.value = t.accent;
    highlight.value = t.highlight;
    swatches.replaceChildren(...PRESETS.map((p) =>
      h('button', {
        type: 'button',
        class: `swatch${t.preset === p.id ? ' on' : ''}`,
        title: p.name,
        onclick: () => update({ preset: p.id, accent: p.accent, highlight: p.highlight }),
      },
        h('span', { class: 'swatch-colors' },
          h('span', { style: `background:${p.accent}` }),
          h('span', { style: `background:${p.highlight}` })),
        h('span', { class: 'swatch-name' }, p.name))));
    modes.replaceChildren(...[['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']].map(([v, label]) =>
      h('button', { type: 'button', role: 'radio', 'aria-checked': String(t.mode === v), class: t.mode === v ? 'on' : '', onclick: () => update({ mode: v }) }, label)));
    designer?.redraw();
  };
  accent.addEventListener('input', () => update({ preset: 'custom', accent: accent.value }));
  highlight.addEventListener('input', () => update({ preset: 'custom', highlight: highlight.value }));
  designer = logoDesigner(() => t.logo, (logo) => update({ logo }));
  update({});

  const labelOwn = h('input', { type: 'checkbox', checked: !!t.labelOwn });
  const clientPanel = h('input', { type: 'checkbox', checked: t.clientPanel !== false });
  clientPanel.addEventListener('change', () => update({ clientPanel: clientPanel.checked }));
  const widths = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Conversation width' });
  const drawWidths = () => widths.replaceChildren(...[['narrow', 'Narrow'], ['comfortable', 'Comfortable'], ['full', 'Full width']].map(([v, label]) =>
    h('button', { type: 'button', role: 'radio', 'aria-checked': String((t.convWidth ?? 'comfortable') === v), class: (t.convWidth ?? 'comfortable') === v ? 'on' : '', onclick: () => { update({ convWidth: v }); drawWidths(); } }, label)));
  drawWidths();
  const ownName = h('div', { class: 'sender' }, 'You');
  const syncOwnName = () => { ownName.hidden = !t.labelOwn; };
  labelOwn.addEventListener('change', () => { t = { ...t, labelOwn: labelOwn.checked }; syncOwnName(); });
  syncOwnName();

  const preview = h('div', { class: 'theme-preview' },
    h('div', { class: 'msg in' }, h('div', { class: 'bubble' }, 'Hi! Are you open today?')),
    h('div', { class: 'msg out other' }, h('div', { class: 'sender' }, 'Front desk'), h('div', { class: 'bubble' }, 'Yes, until 5pm.')),
    h('div', { class: 'msg out gap' }, ownName, h('div', { class: 'bubble' }, 'See you soon!')),
    h('div', { class: 'theme-preview-row' },
      h('button', { type: 'button', class: 'btn primary' }, 'Button'),
      h('a', { href: '#', onclick: (e) => e.preventDefault() }, 'Link'),
      h('span', { class: 'badge' }, '3'),
      h('span', { class: 'flag-dot', title: 'Flagged' })));

  const dlg = dialog(
    'Appearance',
    [
      h('div', { class: 'field-label' }, 'Mode'), modes,
      h('div', { class: 'field-label' }, 'Theme'), swatches,
      h('div', { class: 'field-label' }, 'Custom colors'),
      h('div', { class: 'color-row' },
        h('label', { class: 'color-field' }, accent, h('span', {}, h('strong', {}, 'Accent'), h('span', { class: 'hint' }, 'Buttons, links, your messages'))),
        h('label', { class: 'color-field' }, highlight, h('span', {}, h('strong', {}, 'Highlight'), h('span', { class: 'hint' }, 'Unread counts, flags')))),
      h('div', { class: 'field-label' }, 'Conversation width on big screens'), widths,
      h('label', { class: 'check' }, clientPanel, h('span', {}, 'Show client details beside conversations', h('span', { class: 'hint' }, ' — on wide screens: phone, birthday, client ID, notes and lists'))),
      h('div', { class: 'field-label' }, 'Preview'), preview,
      h('label', { class: 'check' }, labelOwn, h('span', {}, 'Show my name on messages I send', h('span', { class: 'hint' }, ' — messages from other staff always show who sent them, in a slightly different shade'))),
      h('div', { class: 'field-label' }, 'App icon'), designer,
      h('p', { class: 'hint' }, 'Saved to your account, so it follows you to other devices. Other users keep their own choice.'),
    ],
    'Save',
    async () => {
      // A new icon design needs PNG copies on the server for the home screen
      if (JSON.stringify(t.logo) !== JSON.stringify(original.logo) || !t.iconId) {
        const pngs = await renderPngs(t.logo);
        t.iconId = (await api('/me/icon', { method: 'POST', body: pngs })).iconId;
      }
      t = await api('/me/theme', { method: 'PUT', body: t });
      applyTheme(t);
      onSaved(t);
      saved = true;
      toast('Appearance saved');
    },
    { wide: true },
  );
  // Cancel restores what was there before
  dlg.addEventListener('close', () => {
    if (!saved) applyTheme(original);
  });
}
