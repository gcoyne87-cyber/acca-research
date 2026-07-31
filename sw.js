var CACHE = 'racingedge-v2';
var SHELL = ['/', '/index.html', '/icon-192.png', '/icon-512.png', '/manifest.json'];

self.addEventListener('install', function(e) {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(function(c) { return c.addAll(SHELL); })
  );
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(k) { return k !== CACHE; }).map(function(k) { return caches.delete(k); }));
    }).then(function() { return clients.claim(); })
  );
});

self.addEventListener('fetch', function(e) {
  // Always go network-first for API calls
  if (e.request.url.includes('/.netlify/functions/') || e.request.url.includes('api.')) {
    return;
  }
  e.respondWith(
    fetch(e.request).then(function(resp) {
      // Keep the offline fallback cache fresh: every successful GET updates the
      // cached copy, so a network failure can only ever serve the LAST GOOD
      // version — never a months-old install-time snapshot.
      if (resp && resp.ok && e.request.method === 'GET') {
        var copy = resp.clone();
        caches.open(CACHE).then(function(c) { c.put(e.request, copy); });
      }
      return resp;
    }).catch(function() {
      return caches.match(e.request).then(function(r) { return r || caches.match('/'); });
    })
  );
});
