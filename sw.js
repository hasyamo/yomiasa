/* YOMIASA Service Worker
 * アプリシェル（HTML/CSS/JS/アイコン）をキャッシュし、オフラインでも起動できるようにする。
 * note記事の取得（プロキシ経由）はネットワーク優先で、キャッシュしない。
 */
var CACHE = 'yomiasa-v0.1.1';

// スコープ基準（/yomiasa/）からの相対でアプリシェルを列挙。
// style.css / app.js は index.html と同じ ?v= 付きURLでプリキャッシュする
// （クエリ違いはSWのキャッシュ照合では別物扱いなので、URLを揃える）。
var SHELL = [
  './',
  './index.html',
  './style.css?v=0.1.1',
  './app.js?v=0.1.1',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(SHELL);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  // 旧バージョンのキャッシュを掃除
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.map(function (k) {
          if (k !== CACHE) return caches.delete(k);
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  // 同一オリジン（アプリシェル）のみキャッシュ対象。
  // note APIプロキシや外部フォント等はそのままネットワークへ。
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then(function (cached) {
      if (cached) {
        // キャッシュを返しつつ裏で更新（stale-while-revalidate）
        fetchAndCache(req);
        return cached;
      }
      return fetchAndCache(req).catch(function () {
        // オフライン時のフォールバック：ナビゲーションなら index を返す
        if (req.mode === 'navigate') return caches.match('./index.html');
        return Response.error();
      });
    })
  );
});

function fetchAndCache(req) {
  return fetch(req).then(function (res) {
    if (res && res.ok && res.type === 'basic') {
      var copy = res.clone();
      caches.open(CACHE).then(function (cache) {
        cache.put(req, copy);
      });
    }
    return res;
  });
}
