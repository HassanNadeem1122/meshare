// meshare service worker: makes the app installable and the shell loadable
// offline. It does NOT (and cannot) keep WebRTC seeding alive after the tab
// closes - RTCPeerConnection only exists in window contexts.
const CACHE = 'meshare-shell-v1';
const SHELL = [
  './',
  'manifest.json',
  'icon-192.png',
  'icon-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/peerjs/1.5.4/peerjs.min.js'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // Network-first for page navigations so deploys land; cached shell offline.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request).then(hit => hit || caches.match('./')))
    );
    return;
  }
  // Cache-first for shell assets; everything else (TURN credentials, signaling)
  // passes straight to the network and is never cached.
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request)));
});
