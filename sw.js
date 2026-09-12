// Paddle App service worker.
//
// Lives at the site root so its scope covers every page (on GitHub Pages
// that is /septa-scheduler/). Today it does two things: exists, so the site
// is installable, and displays / routes notifications. It deliberately has
// NO fetch handler — nothing is cached, so a deploy is never masked by a
// stale copy. The push handler is the hook for Tier-2 (server-sent) alerts.

const VERSION = 'pa-sw-1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url)
           || new URL('home.html', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) {
      if (c.url.indexOf('home.html') !== -1 && 'focus' in c) return c.focus();
    }
    return self.clients.openWindow(url);
  }));
});

// Server-sent push (Tier 2). Payload: { title, body, url }.
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Paddle App', {
    body: d.body || '',
    icon: new URL('assets/icon-192.png', self.registration.scope).href,
    badge: new URL('assets/icon-192.png', self.registration.scope).href,
    data: { url: d.url || new URL('home.html', self.registration.scope).href }
  }));
});
