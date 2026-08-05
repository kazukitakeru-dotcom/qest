// ファイルを更新したら CACHE_NAME を必ず上げること。
// 上げないと古いキャッシュが配られて、変更が端末に届かない。
// 新しいファイルを足したら FILES_TO_CACHE にも追加する。
const CACHE_NAME = 'questlist-v2';
const FILES_TO_CACHE = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './sync.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(FILES_TO_CACHE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // 同期（Supabase）の通信には一切触らない。
  // キャッシュを挟むと古い応答を掴んで、同期が壊れたように見えることがある。
  if (e.request.method !== 'GET') return;
  if (new URL(e.request.url).origin !== self.location.origin) return;

  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});
