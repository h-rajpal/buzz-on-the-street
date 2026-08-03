/* Service worker for the submit app.

   The point of this is offline capture: you find a buzzball in a basement with
   no signal, the app still opens, and the sighting sits in IndexedDB until you
   publish. So the shell is precached and served cache-first.

   Map tiles and the GitHub API are deliberately NOT cached — stale tiles are
   confusing and a cached API response would be actively wrong. */

/* Bump this whenever submit.js / submit.css change in a way users must get.
   `activate` deletes every cache whose name isn't this one, so a bump forces a
   clean refetch instead of an installed PWA sitting on stale code. */
const CACHE = 'buzz-shell-v2';

const SHELL = [
  './',
  './index.html',
  './submit.css',
  './submit.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  '../assets/store.js',
  '../assets/vendor/leaflet.js',
  '../assets/vendor/leaflet.css',
  '../assets/vendor/exifr.js',
  '../data/boroughs.geojson',
  '../data/flavours.json',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      // addAll is all-or-nothing; one 404 would leave the app with no shell
      .then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {}))))
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

self.addEventListener('fetch', e => {
  const { request } = e;
  if (request.method !== 'GET') return;

  // Never cache: the submission endpoint, map tiles, or place search. A stale
  // geocode result would silently pin the wrong location.
  const url = new URL(request.url);
  if (url.hostname.endsWith('workers.dev') ||
      url.hostname === 'api.github.com' ||
      url.hostname === 'photon.komoot.io' ||
      url.hostname.endsWith('basemaps.cartocdn.com')) return;

  e.respondWith(
    caches.match(request).then(hit => {
      if (hit) {
        // refresh in the background so the shell doesn't go stale forever
        fetch(request).then(r => {
          if (r.ok) caches.open(CACHE).then(c => c.put(request, r.clone()));
        }).catch(() => {});
        return hit;
      }
      return fetch(request).then(r => {
        if (r.ok && url.origin === self.location.origin) {
          const copy = r.clone();
          caches.open(CACHE).then(c => c.put(request, copy));
        }
        return r;
      });
    })
  );
});
