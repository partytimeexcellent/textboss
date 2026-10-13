// TextBoss service worker: shows push notifications and sets the app-icon
// badge while the app is closed. It does not cache anything.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'TextBoss', body: event.data?.text() ?? '' };
  }
  const tasks = [
    // iOS requires every push to show a notification
    self.registration.showNotification(data.title || 'TextBoss', {
      body: data.body || '',
      tag: data.tag,
      renotify: !!data.tag,
      icon: data.icon || '/icon-192.png',
      badge: '/badge-96.png', // monochrome, for the Android status bar
      data: { url: data.url || '/' },
    }),
  ];
  if ('setAppBadge' in self.navigator && typeof data.badge === 'number') {
    tasks.push(data.badge > 0 ? self.navigator.setAppBadge(data.badge) : self.navigator.clearAppBadge());
  }
  event.waitUntil(Promise.all(tasks).catch(() => {}));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((w) => new URL(w.url).origin === self.location.origin);
    if (existing) {
      await existing.focus();
      existing.postMessage({ type: 'navigate', url });
      return;
    }
    await self.clients.openWindow(url);
  })());
});
