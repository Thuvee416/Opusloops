const CACHE_PREFIX = "opusloops-pwa-";
const RETIRED_CACHE_PREFIXES = ["opusloops-mobile-"];
const CACHE_NAME = `${CACHE_PREFIX}v62`;
const APP_SHELL = [
  "./",
  "./index.html",
  "./studio.html",
  "./studio-access.js?v=1",
  "./account.html",
  "./welcome.css?v=2",
  "./welcome.js?v=2",
  "./welcome-pixels.mjs?v=3",
  "./scanner.mjs?v=1",
  "./frame-guard.js?v=1",
  "./styles.css?v=43",
  "./pixel-dock.css?v=1",
  "./grainient-mixer.css?v=1",
  "./soft-aurora-player.css?v=1",
  "./config.js?v=2",
  "./cloud-client.js?v=12",
  "./stem-import-core.js?v=9",
  "./stem-player.js?v=5",
  "./stem-import.js?v=10",
  "./app.js?v=38",
  "./pixel-dock.mjs?v=3",
  "./grainient-mixer.mjs?v=2",
  "./soft-aurora-player.mjs?v=1",
  "./manifest.webmanifest?v=6",
  "./icons/icon-192.png?v=3",
  "./icons/icon-512.png?v=3",
  "./icons/apple-touch-icon.png?v=3"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) =>
                key !== CACHE_NAME &&
                (key.startsWith(CACHE_PREFIX) ||
                  RETIRED_CACHE_PREFIXES.some((prefix) => key.startsWith(prefix)))
            )
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const requestUrl = new URL(event.request.url);
  const scopeUrl = new URL(self.registration.scope);
  const isInAppScope =
    requestUrl.origin === scopeUrl.origin && requestUrl.pathname.startsWith(scopeUrl.pathname);
  if (!isInAppScope) return;

  event.respondWith(
    (async () => {
      try {
        const response = await fetch(event.request);
        if (!response || response.status !== 200 || response.type === "opaque") return response;
        const cache = await caches.open(CACHE_NAME);
        await cache.put(event.request, response.clone());
        return response;
      } catch {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        if (event.request.mode === "navigate") {
          const page = requestUrl.pathname.split('/').pop();
          return caches.match(page === 'studio.html' ? './studio.html' : page === 'account.html' ? './account.html' : './index.html');
        }
        return Response.error();
      }
    })()
  );
});
