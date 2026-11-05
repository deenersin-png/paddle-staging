// Paddle App service worker.
//
// Lives at the site root so its scope covers every page (on GitHub Pages
// that is /septa-scheduler/). It does three things:
//
//  1. Keeps the site installable and displays / routes notifications. The
//     push handler is the hook for Tier-2 (server-sent) alerts.
//
//  2. Fetch: NETWORK-FIRST WITH REVALIDATION for same-origin files. GitHub
//     Pages serves everything with Cache-Control: max-age=600, so after a
//     deploy a browser can happily pair a fresh home.html with a ten-minute-
//     old pa-assignments.js and throw "X is not a function". Asking the
//     server every time (cache: 'no-cache' => conditional request, a cheap
//     304 when unchanged) means a deploy is never masked by a stale module.
//
//  3. Offline: whatever was fetched successfully is kept in a cache and
//     served only when the network fails - a depot parking lot with one bar
//     still gets the paddle viewer it loaded this morning.

const VERSION = 'pa-sw-6';
const CACHE = 'pa-cache-v3';

// What the worker hands the PAGE is marked no-store. The browser's in-memory
// cache otherwise reuses a module it loaded minutes earlier without asking
// this worker (observed: pa-store.js served with zero network and zero worker
// time right after a deploy), so a new page ran against an old module and
// failed to start. Freshness is decided here; the worker's own fetch still
// uses the HTTP cache to revalidate cheaply (a 304 when nothing changed).
function forPage(res) {
  if (!res || res.type !== 'basic') return res;   // leave redirects and opaque responses untouched
  const headers = new Headers(res.headers);
  headers.set('Cache-Control', 'no-store');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
  await self.clients.claim();
})()));

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;          // gstatic, SEPTA, fonts: browser default
  e.respondWith((async () => {
    try {
      const res = await fetch(req, { cache: 'no-cache' });  // always revalidate with the server
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      }
      return forPage(res);
    } catch (_) {
      const hit = await caches.match(req, { ignoreSearch: false });
      if (hit) return forPage(hit);
      throw _;
    }
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url)
           || new URL('home.html', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) {
      if (c.url.indexOf('home.html') === -1 || !('focus' in c)) continue;
      // A swap alert opens the Swap tab, not whatever tab was left open.
      if (url.indexOf('view=swap') !== -1 && 'navigate' in c) return c.navigate(url).then(w => (w || c).focus());
      return c.focus();
    }
    return self.clients.openWindow(url);
  }));
});

// Server-sent push (Tier 2). Payload: { title, body, url, tag }, either
// bare or as Cloud Messaging wraps it ({ data: {...} } for the Swap board's
// data-only messages, { notification: {...} } for console test sends).
//
// EVERY push must end in a shown notification, whatever goes wrong: iPhone
// counts a push it did not see shown against the site and, after a few,
// cancels the site's push subscription without a word - alerts then stop
// until they are turned off and on. So nothing here may throw before
// showNotification, and a failed show falls back to a plain one.
self.addEventListener('push', e => {
  let d = {};
  try {
    try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
    if (d && d.data && (d.data.title || d.data.body)) d = d.data;
    else if (d && d.notification) d = { ...d.notification, url: (d.data && d.data.url) || (d.fcmOptions && d.fcmOptions.link) };
    if (!d || typeof d !== 'object') d = {};
  } catch (_) { d = {}; }
  const scope = self.registration.scope;
  const show = self.registration.showNotification(String(d.title || 'Paddle App'), {
    body: String(d.body || ''),
    tag: d.tag ? String(d.tag) : undefined,
    icon: scope + 'assets/icon-192.png',
    badge: scope + 'assets/icon-192.png',
    data: { url: d.url || scope + 'home.html' }
  }).catch(() => self.registration.showNotification(String(d.title || 'Paddle App'), { body: String(d.body || '') }));
  e.waitUntil(show);
});

// The browser replaced or dropped the push subscription (Chrome and Firefox
// say so here; iPhone never fires this, which is why the page re-checks on
// every open). Subscribe again with the same key straight away, and tell any
// open page, whose refreshPush() then hands the server the new token. With
// no page open, the next open does it.
self.addEventListener('pushsubscriptionchange', e => {
  e.waitUntil((async () => {
    try {
      const key = e.oldSubscription && e.oldSubscription.options && e.oldSubscription.options.applicationServerKey;
      if (!e.newSubscription && key) await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    } catch (_) {}
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    list.forEach(c => c.postMessage({ type: 'pa-push-changed' }));
  })());
});
