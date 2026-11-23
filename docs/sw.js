/* 纸伴 Pages 版 Service Worker：相对路径，项目站点可用。 */
const VERSION = "paperpal-pages-v1";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./js/api.js",
  "./js/ui.js",
  "./js/voice.js",
  "./js/store.js",
  "./js/bluetooth.js",
  "./js/input.js",
  "./js/media.js",
  "./js/autoscan.js",
  "./js/devices.js",
  "./js/app.js",
  "./manifest.webmanifest",
  "./icon.svg",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-180.png",
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

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes("/api/")) return;
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => (await caches.match("./index.html")) || Response.error())
    );
    return;
  }
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request)
          .then((response) => {
            if (response && response.ok) {
              const copy = response.clone();
              caches.open(VERSION).then((cache) => cache.put(request, copy)).catch(() => undefined);
            }
            return response;
          })
          .catch(() => cached)
    )
  );
});
