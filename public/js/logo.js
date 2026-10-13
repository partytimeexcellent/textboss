// App icon / logo: presets, an SVG generator, and PNG rendering for the
// home-screen icons. A logo is:
//   { preset, bg: [c1, c2, c3|null], angle: 'up'|'down'|'diag'|'solid', c1, c2, scale }
// c1 = main bubble color (and the 1st/3rd lines), c2 = the split half and the middle line.

export const LOGO_PRESETS = [
  { id: 'c2', name: 'Aqua fade', bg: ['#8a3ffc', '#d63fd0', '#ff7aa8'], angle: 'up', c1: '#ffffff', c2: '#3ee0ff', scale: 1.1 },
  { id: 'c3', name: 'Electric', bg: ['#8a3ffc', '#d63fd0', '#ff7aa8'], angle: 'up', c1: '#ffffff', c2: '#2f7bff', scale: 1.1 },
  { id: 'a', name: 'Pink purple', bg: ['#ff5fa2', '#7b4fd6', null], angle: 'diag', c1: '#12b4d6', c2: '#ffffff', scale: 1.1 },
  { id: 'b', name: 'Sunset', bg: ['#ff6fb0', '#6d4bd8', null], angle: 'down', c1: '#ffffff', c2: '#ffffff', scale: 1.1 },
  { id: 'd', name: 'Pastel', bg: ['#f7a1d4', '#9b7cf0', null], angle: 'diag', c1: '#12b4d6', c2: '#12b4d6', scale: 1.1 },
  { id: 'ocean', name: 'Ocean', bg: ['#0b7285', '#12b4d6', null], angle: 'diag', c1: '#ffffff', c2: '#ffd43b', scale: 1.1 },
  { id: 'mint', name: 'Mint', bg: ['#0ca678', '#63e6be', null], angle: 'up', c1: '#ffffff', c2: '#1864ab', scale: 1.1 },
  { id: 'dark', name: 'Original', bg: ['#0b0d12', '#0b0d12', null], angle: 'solid', c1: '#12b4d6', c2: '#ff4b2b', scale: 0.8 },
];
export const DEFAULT_LOGO = LOGO_PRESETS[0];

const BUBBLE = 'M176 88 H336 A96 96 0 0 1 432 184 V272 A96 96 0 0 1 336 368 H236 L150 452 V362 A96 96 0 0 1 80 272 V184 A96 96 0 0 1 176 88 Z M184 144 H328 A48 48 0 0 1 376 192 V264 A48 48 0 0 1 328 312 H184 A48 48 0 0 1 136 264 V192 A48 48 0 0 1 184 144 Z';
const GRADIENT_DIR = { up: [0, 1, 1, 0], down: [0, 0, 0, 1], diag: [0, 0, 1, 1], solid: [0, 0, 1, 1] };
const hex = (v, fallback) => (/^#[0-9a-f]{6}$/i.test(v ?? '') ? v : fallback);

export function normalizeLogo(logo) {
  const base = LOGO_PRESETS.find((p) => p.id === logo?.preset) ?? DEFAULT_LOGO;
  const l = { ...base, ...(logo ?? {}) };
  const bg = Array.isArray(l.bg) ? l.bg : base.bg;
  return {
    preset: String(l.preset ?? base.id),
    bg: [hex(bg[0], base.bg[0]), hex(bg[1], base.bg[1]), bg[2] ? hex(bg[2], null) : null],
    angle: GRADIENT_DIR[l.angle] ? l.angle : 'diag',
    c1: hex(l.c1, base.c1),
    c2: hex(l.c2, base.c2),
    scale: Math.min(1.3, Math.max(0.6, Number(l.scale) || 1)),
  };
}

let seq = 0;
// Square icon with its background. `rounded` adds the iOS-like corner for previews;
// the home-screen PNGs are square because the OS applies its own mask.
export function logoSvg(logo, { size = 512, rounded = true } = {}) {
  const l = normalizeLogo(logo);
  const id = `lg${++seq}`;
  const [x1, y1, x2, y2] = GRADIENT_DIR[l.angle];
  const stops = l.angle === 'solid'
    ? `<stop offset="0" stop-color="${l.bg[0]}"/>`
    : l.bg[2]
      ? `<stop offset="0" stop-color="${l.bg[0]}"/><stop offset=".55" stop-color="${l.bg[1]}"/><stop offset="1" stop-color="${l.bg[2]}"/>`
      : `<stop offset="0" stop-color="${l.bg[0]}"/><stop offset="1" stop-color="${l.bg[1]}"/>`;
  // Scale around the bubble's center (256, 270) and center it in the square
  const s = l.scale;
  const tx = (256 - s * 256).toFixed(1);
  const ty = (256 - s * 270).toFixed(1);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">`
    + `<defs><linearGradient id="${id}g" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${stops}</linearGradient>`
    + `<clipPath id="${id}c"><polygon points="520,52 600,52 600,600 36,590"/></clipPath>`
    + `<path id="${id}b" fill-rule="evenodd" d="${BUBBLE}"/></defs>`
    + `<rect width="512" height="512" ${rounded ? 'rx="112"' : ''} fill="url(#${id}g)"/>`
    + `<g transform="translate(${tx} ${ty}) scale(${s})">`
    + `<use href="#${id}b" fill="${l.c1}"/><use href="#${id}b" fill="${l.c2}" clip-path="url(#${id}c)"/>`
    + `<g stroke-width="24" stroke-linecap="round"><path d="M182 192 H330" stroke="${l.c1}"/><path d="M182 230 H304" stroke="${l.c2}"/><path d="M182 268 H262" stroke="${l.c1}"/></g>`
    + '</g></svg>';
}

export const logoDataUrl = (logo, opts) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(logoSvg(logo, opts))}`;

// PNG data URLs for the home-screen / manifest icons
export async function renderPngs(logo) {
  const draw = async (l, size) => {
    const img = new Image();
    img.src = logoDataUrl(l, { size: 512, rounded: false });
    await img.decode();
    const c = document.createElement('canvas');
    c.width = c.height = size;
    c.getContext('2d').drawImage(img, 0, 0, size, size);
    return c.toDataURL('image/png');
  };
  const l = normalizeLogo(logo);
  return {
    180: await draw(l, 180),
    192: await draw(l, 192),
    512: await draw(l, 512),
    // Android crops "maskable" icons to circles and other shapes; keep the bubble inside the safe zone
    maskable: await draw({ ...l, scale: Math.min(l.scale, 0.82) }, 512),
  };
}

// Tab icon, sidebar mark and the apple-touch-icon link for this user
export function applyLogo(logo, iconId) {
  const favicon = document.querySelector('link[rel=icon]');
  if (favicon) {
    favicon.href = logoDataUrl(logo, { size: 64 });
    favicon.type = 'image/svg+xml';
  }
  const touch = document.querySelector('link[rel=apple-touch-icon]');
  if (touch) touch.href = iconId ? `/icons/${iconId}-180.png` : '/apple-touch-icon.png';
  for (const el of document.querySelectorAll('[data-logo]')) el.innerHTML = logoSvg(logo, { size: Number(el.dataset.logo) || 28 });
}
