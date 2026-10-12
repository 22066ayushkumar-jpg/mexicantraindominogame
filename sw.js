/* Mexican Train Dominoes service worker — network-first with offline cache fallback */
const CACHE = 'mtd-v3';
const ASSETS = [
  './', './index.html', './css/styles.css', './js/engine.js', './js/app.js',
  './favicon.svg', './manifest.webmanifest', './img/icon-192.png', './img/icon-512.png'
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  // Try the network first so updates land immediately; fall back to the cache offline.
  e.respondWith(
    fetch(e.request, { cache: 'reload' }).then((res) => {
      if (res && res.status === 200) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || caches.match('./')))
  );
});
