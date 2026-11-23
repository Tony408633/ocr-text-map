/* 纸伴 Service Worker：应用外壳离线可用，API 永不缓存。 */

const VERSION = "paperpal-v15";
const SHELL = [
  "/",
  "/app-assets/styles.css",
  "/app-assets/js/api.js",
  "/app-assets/js/ui.js",
  "/app-assets/js/voice.js",
  "/app-assets/js/store.js",
  "/app-assets/js/bluetooth.js",
  "/app-assets/js/input.js",
  "/app-assets/js/media.js",
  "/app-assets/js/autoscan.js",
  "/app-assets/js/devices.js",
  "/app-assets/js/app.js",
  "/manifest.webmanifest",
  "/favicon.svg",
  "/app-assets/icon-maskable.svg",
  "/app-assets/icon-192.png",
  "/app-assets/icon-512.png",
  "/app-assets/icon-180.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => undefined)
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

function isCacheable(response) {
  return response && response.ok && (response.type === "basic" || response.type === "default");
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/docs" || url.pathname === "/openapi.json") {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          if (isCacheable(response)) {
            caches.open(VERSION).then((cache) => cache.put("/", copy)).catch(() => undefined);
          }
          return response;
        })
        .catch(async () => (await caches.match("/")) || new Response("纸伴暂时离线。", { status: 503 }))
    );
    return;
  }

  const isImage = request.destination === "image" || /\.(png|jpe?g|webp|svg|ico)$/i.test(url.pathname);
  if (isImage) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((response) => {
            if (isCacheable(response)) {
              const copy = response.clone();
              caches.open(VERSION).then((cache) => cache.put(request, copy)).catch(() => undefined);
            }
            return response;
          })
      )
    );
    return;
  }

  if (SHELL.includes(url.pathname) || url.pathname.startsWith("/app-assets/")) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const network = fetch(request)
          .then((response) => {
            if (isCacheable(response)) {
              const copy = response.clone();
              caches.open(VERSION).then((cache) => cache.put(request, copy)).catch(() => undefined);
            }
            return response;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
  }
});
