// Service worker: keeps a copy of every file the app needs, so it opens with
// no network (installed on iPhone/Android, or as a desktop app).
//
// Bump VERSION — together with APP_VERSION in js/version.js — whenever any
// file changes. A new VERSION is what makes installed copies download the new
// files; the app then offers 「更新する」. test/service-worker.test.js checks
// that ASSETS lists every file and that the two versions match.

const VERSION = "1.0.0";
const CACHE = `memory-offline-${VERSION}`;

const ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/app.css",
  "./icons/apple-touch-icon.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/icon.svg",
  "./js/app.js",
  "./js/lib/card-text.js",
  "./js/lib/cards.js",
  "./js/lib/daily.js",
  "./js/lib/format.js",
  "./js/lib/hash.js",
  "./js/lib/ids.js",
  "./js/lib/import-pack.js",
  "./js/lib/mime.js",
  "./js/lib/pack-file.js",
  "./js/lib/parse-bulk.js",
  "./js/lib/progress.js",
  "./js/lib/review-order.js",
  "./js/lib/review-session.js",
  "./js/lib/snapshot.js",
  "./js/lib/spaced-repetition.js",
  "./js/lib/split-back.js",
  "./js/lib/study-file.js",
  "./js/lib/tags.js",
  "./js/lib/zip.js",
  "./js/ui/dom.js",
  "./js/ui/files.js",
  "./js/ui/images.js",
  "./js/ui/modal.js",
  "./js/ui/nav.js",
  "./js/ui/storage.js",
  "./js/ui/store.js",
  "./js/ui/study.js",
  "./js/version.js",
  "./js/views/card-form.js",
  "./js/views/cards.js",
  "./js/views/file.js",
  "./js/views/home.js",
  "./js/views/import.js",
  "./js/views/launch.js",
  "./js/views/pack.js",
  "./js/views/progress.js",
  "./js/views/review.js",
  "./vendor/fflate/esm/browser.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Skip the HTTP cache (GitHub Pages caches for 10 minutes), so a new
      // version never stores an old file.
      await cache.addAll(ASSETS.map((url) => new Request(url, { cache: "reload" })));
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith("memory-offline-") && key !== CACHE) await caches.delete(key);
      }
      await self.clients.claim();
    })()
  );
});

// The page asks for this when you tap 「更新する」.
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const scope = new URL(self.registration.scope);
  const isAppPage =
    request.mode === "navigate" &&
    (url.pathname === scope.pathname || url.pathname === `${scope.pathname}index.html`);

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      if (isAppPage) {
        const page = await cache.match(new URL("./index.html", scope).href);
        if (page) return page;
      }
      const cached = await cache.match(request, { ignoreSearch: true });
      if (cached) return cached;
      return fetch(request);
    })()
  );
});
