/**
 * 松江・出雲バスナビ - Service Worker
 * オフラインキャッシュとネットワーク優先更新（Network-First with Cache Fallback）を提供します。
 */

const CACHE_NAME = 'matsue-bus-nav-v20261018';
const CORE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './gtfs_data.js',
  './manifest.json'
];

// インストール時にコアアセットを事前キャッシュ
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(CORE_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// アクティベート時に古いバージョンのキャッシュを削除
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// フェッチ時はネットワーク優先で最新データを取得し、オフライン時はキャッシュから応答
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.status === 200 && response.type === 'basic') {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(() => {
        return caches.match(event.request, { ignoreSearch: true });
      })
  );
});
