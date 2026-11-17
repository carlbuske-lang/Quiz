/* QuizMaster – Offline-Speicher. Die App läuft nach dem ersten Öffnen auch ohne Internet. */
const CACHE = 'quizmaster-13.1';
const FILES = ["apple-touch-icon.png", "boot.js", "dateien/index.json", "engine.js", "icon.png", "icons/apple-touch-icon.png", "icons/icon-192.png", "icons/icon-512-maskable.png", "icons/icon-512.png", "index.html", "ipad.css", "ipad.js", "manifest.json", "schriften/LIZENZEN.txt", "schriften/barlow-600.woff2", "schriften/barlow-700.woff2", "schriften/fraunces.woff2", "schriften/geist.woff2", "schriften/spacegrotesk.woff2", "vendor/LIZENZEN.txt", "vendor/pdf.min.mjs", "vendor/pdf.worker.min.mjs", "vendor/peerjs.min.js", "vendor/qrcode.js"];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(['./', ...FILES.map(f => f === 'index.html' ? './index.html' : f)])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('quizmaster-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin) return;
  if (r.mode === 'navigate') {
    // Seite immer aus dem Speicher, egal mit welchen Zusätzen (?beamer, ?join=…, ?code=…)
    e.respondWith(caches.match('./index.html').then(m => m || fetch(r)).catch(() => fetch(r)));
    return;
  }
  e.respondWith(caches.match(r, { ignoreSearch: true }).then(m => m || fetch(r)));
});
self.addEventListener('message', e => { if (e.data === 'skip') self.skipWaiting(); });
