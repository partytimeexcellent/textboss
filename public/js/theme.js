// Appearance: preset or custom brand colors, plus light/dark/auto mode.
// Saved per user on the server, cached in localStorage so the page paints in
// the right colors before /api/me answers.

import { h, api, toast, dialog, store } from './core.js';

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
export const DEFAULT_THEME = { preset: 'textboss', accent: '#12b4d6', highlight: '#ff4b2b', mode: 'auto' };

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
  const root = document.documentElement;
  root.style.setProperty('--brand', t.accent);
  root.style.setProperty('--brand-text', textOn(t.accent));
  root.style.setProperty('--brand-2', t.highlight);
  root.style.setProperty('--brand-2-text', textOn(t.highlight));
  if (t.mode === 'auto') delete root.dataset.mode;
  else root.dataset.mode = t.mode;
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', t.accent);
  store('tb.theme', JSON.stringify(t));
  return t;
}

// Paint from the cached theme immediately on load
try {
  applyTheme(JSON.parse(store('tb.theme') ?? 'null'));
} catch {
  applyTheme(null);
}

export function themePicker(current, onSaved = () => {}) {
  const original = { ...DEFAULT_THEME, ...(current ?? {}) };
  let t = { ...original };
  let saved = false;

  const accent = h('input', { type: 'color', value: t.accent });
  const highlight = h('input', { type: 'color', value: t.highlight });
  const swatches = h('div', { class: 'swatches' });
  const modes = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Mode' });

  const update = (patch) => {
    t = { ...t, ...patch };
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
  };
  accent.addEventListener('input', () => update({ preset: 'custom', accent: accent.value }));
  highlight.addEventListener('input', () => update({ preset: 'custom', highlight: highlight.value }));
  update({});

  const preview = h('div', { class: 'theme-preview' },
    h('div', { class: 'msg in' }, h('div', { class: 'bubble' }, 'Hi! Are you open today?')),
    h('div', { class: 'msg out' }, h('div', { class: 'bubble' }, 'Yes, until 5pm. See you soon!')),
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
      h('div', { class: 'field-label' }, 'Preview'), preview,
      h('p', { class: 'hint' }, 'Saved to your account, so it follows you to other devices. Other users keep their own choice.'),
    ],
    'Save',
    async () => {
      await api('/me/theme', { method: 'PUT', body: t });
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
