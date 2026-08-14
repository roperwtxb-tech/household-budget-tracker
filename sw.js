/* Household Budget Tracker service worker
   Strategy:
     - HTML + app code  -> network first, cache as fallback  (updates apply immediately)
     - icons / vendor   -> cache first                        (never change, load instantly)
     - Supabase traffic -> never touched
   The old version was cache-first for everything, which meant a new app.js
   sat unused until the second reload. */
/* keep in step with APP_VERSION in app.js */
const APP_VERSION = '1.4.0';
const CACHE = 'hbt-' + APP_VERSION;
const SHELL = [
  './', './index.html', './app.js', './app.js?v=' + APP_VERSION, './manual.html',
  './vendor/supabase.js', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'
];

/* files whose contents change when the app is updated */
const isAppCode = url =>
  url.pathname.endsWith('.html') ||
  url.pathname.endsWith('/') ||
  url.pathname.endsWith('app.js') ||
  url.pathname.endsWith('manifest.webmanifest');

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(SHELL.map(u => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname.endsWith('supabase.co')) return;   // live data — leave alone
  if (url.origin !== self.location.origin) return;

  const put = res => {
    if (res && res.status === 200 && res.type === 'basic') {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
    }
    return res;
  };

  if (isAppCode(url)) {
    /* Network first, with a one-off query string so the request can't be
       answered from GitHub's CDN edge or the browser's HTTP cache. Without
       this an update can sit unseen for several minutes even though the
       files are already published. The response is stored under the plain
       URL so the offline fallback still finds it. */
    const fresh = new URL(req.url);
    fresh.searchParams.set('_cb', Date.now().toString(36));
    e.respondWith(
      fetch(fresh.toString(), { cache: 'reload', credentials: 'same-origin' })
        .then(res => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(req, copy));
          }
          return res;
        })
        // offline: ignoreSearch so a versioned app.js?v=… still finds its cached copy
        .catch(() => caches.match(req, { ignoreSearch: true }).then(hit => hit || caches.match('./index.html')))
    );
    return;
  }

  // everything else: cache first, refresh in the background
  e.respondWith(
    caches.match(req).then(hit => {
      const net = fetch(req).then(put).catch(() => hit);
      return hit || net;
    })
  );
});
