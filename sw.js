// Sculpt Scan offline support
const VERSION = 'sculpt-scan-v2';
const APP = ['./', './index.html', './scan-core.js', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];
const CDN = 'https://cdn.jsdelivr.net/npm/three@0.170.0/';

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    await c.addAll(APP);
    for (const u of [CDN + 'build/three.module.js', CDN + 'examples/jsm/controls/OrbitControls.js']) {
      try { await c.add(new Request(u, { mode: 'cors' })); } catch {}
    }
    self.skipWaiting();
  })());
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.href.startsWith(CDN)) {   // library files never change: cache first
    e.respondWith(caches.match(req).then((r) => r || fetch(req).then((res) => { const c = res.clone(); caches.open(VERSION).then((x) => x.put(req, c)); return res; })));
    return;
  }
  if (url.origin !== location.origin) return;
  // app files: network first so updates arrive, cache when offline
  e.respondWith(fetch(req).then((res) => {
    if (res.ok) { const c = res.clone(); caches.open(VERSION).then((x) => x.put(req, c)); }
    return res;
  }).catch(() => caches.match(req).then((r) => r || caches.match('./index.html'))));
});
