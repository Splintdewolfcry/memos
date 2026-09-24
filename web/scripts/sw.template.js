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
 * __PRECACHE_MANIFEST__ and __BUILD_HASH__ are substituted at build time by
 * web/scripts/vite-plugin-offline-shell.mjs.
 */
import {
  ATTACHMENT_CACHE_CAP_BYTES,
  isAttachmentPath,
  isBypassedPath,
  isCacheableAttachmentResponse,
  isImmutableAssetPath,
  selectEvictions,
} from "./sw-routing.mjs";

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

  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(request));
    return;
  }
  if (isAttachmentPath(url.pathname)) {
    event.respondWith(handleAttachment(request));
    return;
  }
  event.respondWith(handleAsset(request, url.pathname));
});

/** Network-first: online stays current, offline falls back to the shell. */
async function handleNavigation(request) {
  try {
    const response = await fetch(request);
    const cache = await caches.open(SHELL_CACHE);
    await cache.put("/index.html", response.clone());
    return response;
  } catch {
    const cached = await caches.match("/index.html", { cacheName: SHELL_CACHE });
    // Without a cached shell there is nothing to show; let the browser render
    // its own error rather than fabricate a page.
    return cached ?? Response.error();
  }
}

/**
 * Hashed assets are immutable, so cache-first is safe and saves a round trip.
 * Anything else revalidates through the network first.
 */
async function handleAsset(request, pathname) {
  if (isImmutableAssetPath(pathname)) {
    const cached = await caches.match(request, { cacheName: SHELL_CACHE });
    if (cached) return cached;
  }

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await caches.match(request, { cacheName: SHELL_CACHE });
    if (cached) return cached;
    throw error;
  }
}

/** Network-then-store for attachments, capped so media cannot fill the device. */
async function handleAttachment(request) {
  try {
    const response = await fetch(request);
    if (isCacheableAttachmentResponse(request.method, request.headers.has("range"), response.status)) {
      const cache = await caches.open(ATTACHMENT_CACHE);
      await cache.put(request, response.clone());
      // Eviction is not awaited into the response path: the user should not wait
      // on bookkeeping to see an image.
      void enforceAttachmentCap(cache);
    }
    return response;
  } catch {
    const cached = await caches.match(request, { cacheName: ATTACHMENT_CACHE });
    return cached ?? Response.error();
  }
}

async function enforceAttachmentCap(cache) {
  const keys = await cache.keys();
  const entries = [];
  for (const key of keys) {
    const response = await cache.match(key);
    if (!response) continue;
    const blob = await response.clone().blob();
    entries.push({ url: key.url, size: blob.size });
  }
  const evictions = selectEvictions(entries, ATTACHMENT_CACHE_CAP_BYTES);
  await Promise.all(evictions.map((url) => cache.delete(url)));
}
