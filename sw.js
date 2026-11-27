/* Service worker: deja la app disponible sin cobertura (carga la web desde el móvil y se actualiza en segundo plano). */
var CACHE = 'gx-v18';
var ASSETS = ['./', 'index.html', 'styles.css', 'app.js', 'config.js', 'manifest.webmanifest',
  'assets/logo-blanco.png', 'assets/icon-180.png', 'assets/icon-192.png', 'assets/icon-512.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return; // las llamadas al servidor de Google no se cachean
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(function (hit) {
    var net = fetch(e.request).then(function (r) { if (r && r.ok) { var cp = r.clone(); caches.open(CACHE).then(function (c) { c.put(e.request, cp); }); } return r; }).catch(function () { return hit; });
    return hit || net;
  }));
});
