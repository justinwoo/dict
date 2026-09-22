// Offline support.
//
// Two very different policies, on purpose:
//
//   app shell (html/js/css)  network-first. It is tens of KB and it changes
//                            whenever the app is edited, so it is never served
//                            stale while online. The cache exists only as the
//                            offline fallback.
//   dictionary data          cache-first, and never revalidated. Tens of MB
//                            that only change on a rebuild; the page requests
//                            them with a ?v=<build date> stamp, so a rebuild
//                            is simply a different URL.
//
// meta.json carries that stamp, so it must not be cached hard itself.

const VERSION = 'v3';
const SHELL_CACHE = `dict-shell-${VERSION}`;
const DATA_CACHE = `dict-data-${VERSION}`;

const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'worker.js',
  'lib/kana.js',
  'lib/pinyin.js',
  'lib/deconjugate.js',
  'manifest.webmanifest',
  'icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL_CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== SHELL_CACHE && key !== DATA_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

/** Cache-first, for the data files: tens of megabytes that never change. */
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone());
  return res;
}

/**
 * Network-first, for the app shell. Cache-first here means an edit to app.js
 * or worker.js is invisible until the cache is manually cleared — which is
 * exactly the trap it sounds like. The shell is a few tens of KB, so going to
 * the network costs nothing when online, and the cache still covers offline.
 */
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(request)
      || (request.mode === 'navigate' ? await cache.match('index.html') : null);
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/__dev')) return; // dev live-reload stream

  // meta.json is how the page learns the current build stamp; caching it hard
  // would pin the app to whichever dataset it first saw.
  const isVersionedData = url.pathname.includes('/data/')
    && !url.pathname.endsWith('/meta.json');

  e.respondWith(
    isVersionedData
      ? cacheFirst(request, DATA_CACHE).catch(() => caches.match(request))
      : networkFirst(request, SHELL_CACHE),
  );
});
