// Gemmy / AIエージェント店舗アプリ Service Worker
// 静的シェル・CDNはCache-First（更新時は新キャッシュ名へ）、GAS動的コード取得APIはNetwork-Firstでキャッシュする。
var SHELL_CACHE = 'gemmy-shell-v1';
var GAS_CACHE = 'gemmy-gas-v1';

var PRECACHE_URLS = [
  './',
  './index.html',
  'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js',
  'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.17.0/dist/tf.min.js'
];

// オフライン再生用にキャッシュ対象とするGAS API（読み取り・コード配信系のみ）
var CACHEABLE_GAS_APIS = {
  apiAnimCode: true,
  apiSheetCall: true,
  apiGames: true,
  apiMelodyLib: true,
  apiVisualLib: true
};

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(function (cache) {
      return cache.addAll(PRECACHE_URLS);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  var allow = [SHELL_CACHE, GAS_CACHE];
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (allow.indexOf(k) === -1) return caches.delete(k);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

// JSONPのcallbackパラメータを除いた正規化キーを作る
function buildNormalizedGasKey(urlObj) {
  var params = [];
  urlObj.searchParams.forEach(function (val, key) {
    if (key === 'callback') return;
    params.push([key, val]);
  });
  params.sort(function (a, b) {
    return a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0);
  });
  var qs = params.map(function (kv) {
    return encodeURIComponent(kv[0]) + '=' + encodeURIComponent(kv[1]);
  }).join('&');
  return urlObj.origin + urlObj.pathname + (qs ? '?' + qs : '');
}

// JSONP応答 "cbName({...})" からJSON本体を抜き出す
function extractJsonFromJsonp(bodyText, cbName) {
  var trimmed = String(bodyText || '').trim();
  if (cbName && trimmed.indexOf(cbName + '(') === 0 && trimmed.slice(-1) === ')') {
    return trimmed.slice(cbName.length + 1, -1);
  }
  var firstParen = trimmed.indexOf('(');
  if (firstParen > 0 && trimmed.slice(-1) === ')') {
    return trimmed.slice(firstParen + 1, -1);
  }
  return trimmed;
}

function handleGasRequest(request, urlObj) {
  var cbName = (urlObj.searchParams.get('callback') || '').replace(/[^\w.$]/g, '');
  var cacheKey = buildNormalizedGasKey(urlObj);

  return fetch(request).then(function (networkRes) {
    if (networkRes && networkRes.ok) {
      var resClone = networkRes.clone();
      resClone.text().then(function (text) {
        var jsonPayload = extractJsonFromJsonp(text, cbName);
        if (jsonPayload) {
          caches.open(GAS_CACHE).then(function (cache) {
            cache.put(cacheKey, new Response(jsonPayload, {
              headers: { 'Content-Type': 'application/json; charset=utf-8' }
            }));
          });
        }
      }).catch(function () {});
    }
    return networkRes;
  }).catch(function () {
    return caches.open(GAS_CACHE).then(function (cache) {
      return cache.match(cacheKey).then(function (cachedJsonRes) {
        if (!cachedJsonRes) {
          return new Response('', { status: 503, statusText: 'Offline and not cached' });
        }
        return cachedJsonRes.text().then(function (jsonText) {
          if (cbName) {
            return new Response(cbName + '(' + jsonText + ');', {
              status: 200,
              headers: { 'Content-Type': 'application/javascript; charset=utf-8' }
            });
          }
          return new Response(jsonText, {
            status: 200,
            headers: { 'Content-Type': 'application/json; charset=utf-8' }
          });
        });
      });
    });
  });
}

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;

  var urlObj;
  try { urlObj = new URL(req.url); } catch (e) { return; }

  // 1. GASコード取得API（Network-First + JSONP callback書き換えフォールバック）
  if (urlObj.hostname === 'script.google.com' || urlObj.hostname === 'script.googleusercontent.com') {
    var api = urlObj.searchParams.get('api') || '';
    if (CACHEABLE_GAS_APIS[api]) {
      event.respondWith(handleGasRequest(req, urlObj));
    }
    return;
  }

  // 2. 静的シェル・CDNライブラリ（Cache-First + バックグラウンド更新不要の安定キャッシュ）
  var isShellOrCdn = (urlObj.origin === self.location.origin) ||
    (urlObj.hostname === 'cdnjs.cloudflare.com') ||
    (urlObj.hostname === 'cdn.jsdelivr.net');

  if (isShellOrCdn) {
    event.respondWith(
      caches.match(req).then(function (cached) {
        if (cached) return cached;
        return fetch(req).then(function (res) {
          if (res && res.ok) {
            var clone = res.clone();
            caches.open(SHELL_CACHE).then(function (cache) {
              cache.put(req, clone);
            });
          }
          return res;
        });
      })
    );
  }
});