const CACHE_PREFIX = "opusloops-pwa-";
const RETIRED_CACHE_PREFIXES = ["opusloops-mobile-"];
const CACHE_NAME = `${CACHE_PREFIX}v43`;
const APP_SHELL = [
  "./",
  "./index.html",
  "./frame-guard.js?v=1",
  "./styles.css?v=33",
  "./pixel-dock.css?v=1",
  "./config.js?v=1",
  "./cloud-client.js?v=8",
  "./stem-import-core.js?v=7",
  "./stem-player.js?v=1",
  "./stem-import.js?v=8",
  "./app.js?v=26",
  "./pixel-dock.mjs?v=1",
  "./manifest.webmanifest?v=5",
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
        if (event.request.mode === "navigate") return caches.match("./index.html");
        return Response.error();
      }
    })()
  );
});
