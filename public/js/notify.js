// Push notifications and the app-icon badge.
// iPhone/iPad: works only from the home-screen app (iOS 16.4+), and turning it
// on must start from a tap, which the Notifications dialog provides.

import { h, fill, state, api, toast, dialog } from './core.js';

const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isMacBrowserTab = () => navigator.platform === 'MacIntel' && navigator.maxTouchPoints === 0 && !isStandalone();
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

let registration = null;

// The active service worker registration, registering it if needed.
// Resolves to null (never hangs) if this browser refuses service workers.
async function getRegistration() {
  if (registration?.active) return registration;
  try {
    registration = (await navigator.serviceWorker.getRegistration('/')) ?? (await navigator.serviceWorker.register('/sw.js'));
    if (!registration.active) {
      await Promise.race([navigator.serviceWorker.ready, new Promise((_, no) => setTimeout(no, 8000))]);
      registration = await navigator.serviceWorker.getRegistration('/');
    }
    return registration?.active ? registration : null;
  } catch {
    return null;
  }
}

export async function initPush() {
  if (!('serviceWorker' in navigator)) return;
  try {
    registration = await navigator.serviceWorker.register('/sw.js');
  } catch (err) {
    console.warn('service worker registration failed', err);
    return;
  }
  // Tapping a notification while the app is open moves to that conversation
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'navigate') location.hash = new URL(e.data.url).hash || '#/';
  });
  // Already allowed on this device: make sure the server has this subscription
  if (supported() && Notification.permission === 'granted') {
    try {
      const sub = await registration.pushManager.getSubscription();
      if (sub) {
        const status = await api('/push/status', { method: 'POST', body: { endpoint: sub.endpoint } });
        await api('/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON(), preview: status.subscribed ? status.preview : true } });
        state.pushActive = true;
      }
    } catch {}
  }
}

function keyBytes(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function subscribe(preview) {
  // Must run straight from a tap on iOS
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(permission === 'denied'
      ? 'Notifications are blocked for TextBoss. Turn them on in your device settings, then try again.'
      : 'Notification permission was not granted');
  }
  if (!(await getRegistration())) throw new Error('This browser could not start background notifications. Try reloading the app.');
  const { publicKey } = await api('/push/key');
  let sub = await registration.pushManager.getSubscription();
  if (!sub) sub = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  await api('/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON(), preview } });
  state.pushActive = true;
}

async function unsubscribe() {
  const reg = await getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } });
    await sub.unsubscribe().catch(() => {});
  }
  state.pushActive = false;
}

export function updateBadge(count) {
  if (!('setAppBadge' in navigator)) return;
  (count > 0 ? navigator.setAppBadge(count) : navigator.clearAppBadge()).catch(() => {});
}

export async function notificationsDialog() {
  const body = h('div', { class: 'notify-body' });
  const dlg = dialog('Notifications', body, null, () => {});

  const draw = async () => {
    if (isIos() && !isStandalone()) {
      fill(body,
        h('p', { class: 'dialog-text' }, 'On iPhone and iPad, notifications only work from the home-screen app.'),
        h('ol', { class: 'steps' },
          h('li', {}, 'In Safari, tap the Share button, then ', h('strong', {}, 'Add to Home Screen'), '.'),
          h('li', {}, 'Open TextBoss from the new home-screen icon and sign in.'),
          h('li', {}, 'Open this menu again and turn notifications on.')),
        h('p', { class: 'hint' }, 'Requires iOS 16.4 or later.'));
      return;
    }
    if (!supported()) {
      fill(body, h('p', { class: 'dialog-text' }, 'This browser does not support push notifications.'));
      return;
    }

    const reg = await getRegistration();
    if (!reg) {
      fill(body, h('p', { class: 'dialog-text' }, 'This browser could not start background notifications. Reload TextBoss and try again; if it keeps happening, use Safari (iPhone) or Chrome.'));
      return;
    }
    const sub = await reg.pushManager.getSubscription().catch(() => null);
    const status = sub ? await api('/push/status', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => ({})) : {};
    const on = Notification.permission === 'granted' && !!sub && status.subscribed;
    const preview = h('input', { type: 'checkbox', class: 'switch', checked: on ? status.preview : true });
    const result = h('div', { class: 'test-result', role: 'status' });

    const run = (fn) => async (e) => {
      e.target.disabled = true;
      try {
        await fn();
      } catch (err) {
        fill(result, h('span', { class: 'bad' }, '✕ ', err.message));
      }
      e.target.disabled = false;
    };

    fill(body,
      h('div', { class: 'status-row' },
        on ? h('span', { class: 'pill ok' }, 'On for this device')
          : Notification.permission === 'denied' ? h('span', { class: 'pill warn' }, 'Blocked in device settings')
          : h('span', { class: 'pill' }, 'Off for this device')),
      h('p', { class: 'dialog-text' }, 'Get an alert and a badge on the app icon when a text arrives, even when TextBoss is closed. Each phone or computer is set up separately.'),
      // In a Mac browser tab, alerts show the browser's icon and the web address
      isMacBrowserTab() && h('p', { class: 'hint' },
        'Tip: for alerts that show the TextBoss name and icon instead of the browser and web address, install it as an app. In Safari choose File → Add to Dock (in Chrome: ⋮ → Cast, save and share → Install page as app), then turn notifications on from the installed app and off here.'),
      h('label', { class: 'switch-label' }, preview,
        h('span', {}, 'Show message text', h('span', { class: 'hint' }, ' — otherwise alerts just say "New message", so patient names and messages never appear on a locked screen.'))),
      h('div', { class: 'card-actions' },
        !on && h('button', { type: 'button', class: 'btn primary', onclick: run(async () => {
          await subscribe(preview.checked);
          toast('Notifications are on for this device');
          draw();
        }) }, 'Turn on notifications'),
        on && h('button', { type: 'button', class: 'btn primary', onclick: run(async () => {
          await api('/push/test', { method: 'POST' });
          fill(result, h('span', { class: 'ok' }, '✓ Test sent. It should arrive within a few seconds.'));
        }) }, 'Send a test'),
        on && h('button', { type: 'button', class: 'btn', onclick: run(async () => {
          await unsubscribe();
          toast('Notifications are off for this device');
          draw();
        }) }, 'Turn off')),
      result);

    // Changing the preview setting on an active device saves right away
    preview.addEventListener('change', async () => {
      if (!on) return;
      await api('/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON(), preview: preview.checked } });
      toast(preview.checked ? 'Alerts will show message text' : 'Alerts will hide message text');
    });
  };
  draw();
  return dlg;
}
