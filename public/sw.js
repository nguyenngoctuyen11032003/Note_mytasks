/* Note_mytasks service worker.
 *
 * Served from the app root (./sw.js) so its scope is the GitHub Pages
 * sub-path (/<repo>/). The build (vite.config.js → nmServiceWorker) stamps a
 * BUILD id and the list of emitted files into this file, so every deploy
 * produces a byte-different worker → the browser installs it → the page
 * offers "Tải lại".
 *
 * Strategies
 *   navigations / HTML          network-first, fall back to cached shell
 *   same-origin static files    stale-while-revalidate
 *   Google Fonts (css + woff2)  stale-while-revalidate (separate cache)
 *   everything else             not intercepted — Supabase API/auth
 *                               (*.supabase.co) is NEVER cached.
 */
const BUILD = '__NM_BUILD_ID__';
const PRECACHE = [/*__NM_PRECACHE__*/];

const PREFIX = 'nm-';
const SHELL = `${PREFIX}shell-${BUILD}`;
const FONTS = `${PREFIX}fonts-v1`;
const KEEP = new Set([SHELL, FONTS]);

const scopeUrl = new URL(self.registration.scope);
const INDEX = new URL('./index.html', scopeUrl).href;
const ROOT = scopeUrl.href;
const CORE = [ROOT, INDEX, new URL('./manifest.webmanifest', scopeUrl).href, new URL('./favicon.svg', scopeUrl).href];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      const urls = [...new Set([...CORE, ...PRECACHE.map((p) => new URL(p, scopeUrl).href)])];
      // One failing file must not abort the whole install.
      await Promise.all(urls.map((u) => cache.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    })(),
  );
  // No skipWaiting here: the page asks for it after the user accepts the update.
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith(PREFIX) && !KEEP.has(k)).map((k) => caches.delete(k)));
      if (self.registration.navigationPreload) {
        try { await self.registration.navigationPreload.enable(); } catch {}
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') self.skipWaiting();
  // After first load the page reports the files it actually used.
  if (data.type === 'CACHE_URLS' && Array.isArray(data.urls)) {
    event.waitUntil(
      caches.open(SHELL).then((cache) =>
        Promise.all(
          data.urls
            .filter((u) => isOwn(new URL(u, scopeUrl)))
            .map((u) => cache.match(u).then((hit) => hit || cache.add(u).catch(() => {}))),
        ),
      ),
    );
  }
});

function isOwn(url) {
  return url.origin === scopeUrl.origin && url.pathname.startsWith(scopeUrl.pathname);
}
function isFont(url) {
  return url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname.endsWith('supabase.co') || url.hostname.endsWith('supabase.in')) return;

  if (req.mode === 'navigate' && isOwn(url)) {
    event.respondWith(networkFirst(event));
    return;
  }
  if (isOwn(url)) {
    if (url.pathname.endsWith('/sw.js')) return;
    event.respondWith(staleWhileRevalidate(event, SHELL));
    return;
  }
  if (isFont(url)) {
    event.respondWith(staleWhileRevalidate(event, FONTS));
  }
  // Any other cross-origin request goes straight to the network.
});

async function networkFirst(event) {
  const cache = await caches.open(SHELL);
  try {
    const preload = await event.preloadResponse;
    const res = preload || (await fetch(event.request));
    // Cache the shell without the query string (?code=… from auth redirects).
    if (res && res.ok && res.type === 'basic') cache.put(INDEX, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    const hit = (await cache.match(INDEX)) || (await cache.match(ROOT));
    if (hit) return hit;
    throw err;
  }
}

async function staleWhileRevalidate(event, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(event.request);
  const network = fetch(event.request)
    .then((res) => {
      // opaque (cross-origin no-cors) responses are fine for fonts.
      if (res && (res.ok || res.type === 'opaque')) cache.put(event.request, res.clone()).catch(() => {});
      return res;
    })
    .catch(() => null);
  if (hit) {
    event.waitUntil(network);
    return hit;
  }
  const res = await network;
  return res || new Response('', { status: 504, statusText: 'Offline' });
}
