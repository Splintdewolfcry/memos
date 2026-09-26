/**
 * Offline app shell worker.
 *
 * Strategy per docs/design/offline-caching.md:
 *  - navigations: network-first, cached index.html as fallback
 *  - build assets: precache hit, else network-then-store
 *  - /file/*: network-then-store, full 200 responses only, size-capped
 *  - /api, /memos.api.v1*, SSE: never intercepted, so every online read is a
 *    live query and no code path can serve a stale API response
 *
 * The build hash and the precache manifest are placeholder tokens in the
 * constants below; web/scripts/vite-plugin-offline-shell.mjs substitutes both
 * at build time. Keep the literal tokens out of this comment: substituting them
 * here would inline the whole manifest a second time in a file served no-cache.
 *
 * Routing decisions and the caching strategies live in ./sw-routing.mjs, which
 * this worker imports as an ES module (registration passes type: "module").
 */
import { handleAsset, handleAttachment, handleNavigation, isAttachmentPath, isBypassedPath } from "./sw-routing.mjs";

const BUILD_HASH = "__BUILD_HASH__";
const SHELL_CACHE = `memos-shell-${BUILD_HASH}`;
const ATTACHMENT_CACHE = `memos-attachments-${BUILD_HASH}`;
const PRECACHE_URLS = ["__PRECACHE_MANIFEST__"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      // Activate without waiting for every tab to close, so a fresh deploy takes
      // effect on the next navigation rather than the next browser restart.
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== SHELL_CACHE && key !== ATTACHMENT_CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isBypassedPath(url.pathname)) return;

  // The handlers take their globals injected so vitest can drive them with
  // fakes; here they get the real ones.
  const deps = { fetch, caches, shellCache: SHELL_CACHE, attachmentCache: ATTACHMENT_CACHE };

  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(request, deps));
    return;
  }
  if (isAttachmentPath(url.pathname)) {
    event.respondWith(handleAttachment(request, deps));
    return;
  }
  event.respondWith(handleAsset(request, url.pathname, deps));
});
