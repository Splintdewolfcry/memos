/**
 * Routing decisions, caching strategies and eviction for the offline service
 * worker.
 *
 * Kept separate from sw.template.js so vitest can import it directly: a service
 * worker script has no module exports at runtime, but the decisions inside it
 * are the part worth testing. The handlers take their globals as an injected
 * `deps` argument for the same reason — the worker passes the real `fetch` and
 * `caches`, tests pass hand-rolled fakes.
 *
 * The bypass list mirrors shouldSkipFrontendStatic in server/frontend/frontend.go
 * minus /file, which this worker does cache. Keep the two in step.
 */

/** Total attachment cache budget. Oldest entries are evicted past this. */
export const ATTACHMENT_CACHE_CAP_BYTES = 500 * 1024 * 1024;

/** Shell entry the navigation fallback serves offline. */
const SHELL_ENTRY = "/index.html";

/**
 * Paths this worker must never intercept. server/frontend/frontend.go skips
 * serving them as static frontend files; see isServiceWorkerAsset there for the
 * separate no-cache header set.
 */
export const BYPASS_PREFIXES = ["/api", "/memos.api.v1"];

/** True when the worker must not touch the request at all. */
export function isBypassedPath(pathname) {
  // The SSE stream must not be buffered or delayed; see useLiveMemoRefresh.ts.
  if (pathname.startsWith("/api/v1/sse")) return true;
  return BYPASS_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`) || pathname.startsWith(`${prefix}.`));
}

/** Attachment binaries and user avatars, served from /file by fileserver.go. */
export function isAttachmentPath(pathname) {
  return pathname.startsWith("/file/attachments/") || pathname.startsWith("/file/users/");
}

/**
 * Only complete responses are storable. Cache.put rejects non-200 range
 * responses, and a request that asked for a range may be answered 200 by a
 * backend that ignores Range — caching that would poison later full reads.
 */
export function isCacheableAttachmentResponse(method, hasRangeHeader, status) {
  return method === "GET" && !hasRangeHeader && status === 200;
}

/** Content-hashed build output under /assets/ never changes for a given name. */
export function isImmutableAssetPath(pathname) {
  return pathname.startsWith("/assets/");
}

/**
 * Oldest-first eviction down to capBytes. `entries` must already be ordered
 * oldest to newest. Returns the URLs to delete.
 */
export function selectEvictions(entries, capBytes) {
  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  const evict = [];
  for (const entry of entries) {
    if (total <= capBytes) break;
    evict.push(entry.url);
    total -= entry.size;
  }
  return evict;
}

/**
 * @typedef {object} WorkerDeps
 * @property {(request: Request) => Promise<Response>} fetch
 * @property {CacheStorage} caches
 * @property {string} shellCache name of the shell cache, build-hash scoped
 * @property {string} attachmentCache name of the attachment cache
 * @property {number} [attachmentCapBytes] eviction budget override
 */

/**
 * Fire-and-forget cache write. A rejected open or put — QuotaExceededError on a
 * full device is the expected case — must never reach the caller, because
 * degrading to online-only beats turning a good response into a network error.
 */
function storeResponse(cacheStorage, cacheName, request, response) {
  cacheStorage
    .open(cacheName)
    .then((cache) => cache.put(request, response.clone()))
    .catch(() => {});
}

/**
 * Network-first: online stays current, offline falls back to the cached shell.
 *
 * Only an OK response is stored, so a transient 502 during a deploy restart or
 * a CDN challenge page cannot overwrite the precached shell — that would make
 * every later offline cold load render the error document instead of the app.
 */
export async function handleNavigation(request, deps) {
  const { fetch: fetchFn, caches: cacheStorage, shellCache } = deps;

  let response;
  try {
    response = await fetchFn(request);
  } catch {
    const cached = await cacheStorage.match(SHELL_ENTRY, { cacheName: shellCache });
    // Without a cached shell there is nothing to show; let the browser render
    // its own error rather than fabricate a page.
    return cached ?? Response.error();
  }

  if (response.ok) {
    storeResponse(cacheStorage, shellCache, SHELL_ENTRY, response);
  }
  return response;
}

/**
 * Hashed assets are immutable, so cache-first is safe and saves a round trip.
 * Anything else revalidates through the network first.
 */
export async function handleAsset(request, pathname, deps) {
  const { fetch: fetchFn, caches: cacheStorage, shellCache } = deps;

  if (isImmutableAssetPath(pathname)) {
    const cached = await cacheStorage.match(request, { cacheName: shellCache });
    if (cached) return cached;
  }

  let response;
  try {
    response = await fetchFn(request);
  } catch (error) {
    const cached = await cacheStorage.match(request, { cacheName: shellCache });
    if (cached) return cached;
    throw error;
  }

  if (response.ok) {
    storeResponse(cacheStorage, shellCache, request, response);
  }
  return response;
}

/**
 * Network-then-store for attachments, capped so media cannot fill the device.
 * Eviction follows a put that actually succeeded and is never awaited into the
 * response path: the user should not wait on bookkeeping to see an image.
 */
export async function handleAttachment(request, deps) {
  const { fetch: fetchFn, caches: cacheStorage, attachmentCache } = deps;

  let response;
  try {
    response = await fetchFn(request);
  } catch {
    const cached = await cacheStorage.match(request, { cacheName: attachmentCache });
    return cached ?? Response.error();
  }

  if (isCacheableAttachmentResponse(request.method, request.headers.has("range"), response.status)) {
    cacheStorage
      .open(attachmentCache)
      .then((cache) => cache.put(request, response.clone()).then(() => enforceAttachmentCap(cache, deps)))
      .catch(() => {});
  }
  return response;
}

/** Sweeps run one at a time, so concurrent attachment loads cannot stack. */
let sweepQueue = Promise.resolve();

/**
 * Trims the attachment cache back under its budget. Returns the sweep promise so
 * callers can await it in tests; the worker does not.
 */
export function enforceAttachmentCap(cache, deps) {
  const capBytes = deps?.attachmentCapBytes ?? ATTACHMENT_CACHE_CAP_BYTES;
  const sweep = sweepQueue.then(() => sweepAttachmentCache(cache, capBytes));
  // The queue itself must never carry a rejection into the next sweep.
  sweepQueue = sweep.catch(() => {});
  return sweep;
}

async function sweepAttachmentCache(cache, capBytes) {
  const keys = await cache.keys();
  const entries = [];
  for (const key of keys) {
    const response = await cache.match(key);
    if (!response) continue;
    // Sizes come from the header rather than the body: materializing every
    // cached attachment on every store would hold the whole cache in memory.
    entries.push({ url: key.url, size: Number(response.headers.get("content-length")) || 0 });
  }
  const evictions = selectEvictions(entries, capBytes);
  await Promise.all(evictions.map((url) => cache.delete(url)));
}
