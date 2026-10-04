/* global self, caches, fetch */
// VibeCoder's service worker. It exists for two things only: so the browser
// offers "Install", and so an installed app opened while its server is not
// running shows how to start it instead of a browser error page.
// Nothing else is cached - the API and the app's pages always come from the
// server, so a person never sees a stale plan or result.
const OFFLINE = '/offline.html';
const CACHE = 'vibecoder-offline-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll([OFFLINE, '/icons/icon-192.png'])));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE)));
});
