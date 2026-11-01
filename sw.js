self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open('jobportal-store').then((cache) => {
      return cache.addAll([
        '/',
        '/static/logo.png'
      ]);
    })
  );
});

self.addEventListener('fetch', (e) => {
  e.respondWith(
    caches.match(e.request).then((response) => {
      return response || fetch(e.request);
    })
  );
});