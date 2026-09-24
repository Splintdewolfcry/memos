/**
 * Pure routing and eviction decisions for the offline service worker.
 *
 * Kept separate from sw.template.js so vitest can import it directly: a service
 * worker script has no module exports at runtime, but the decisions inside it
 * are the part worth testing.
 *
 * The bypass list mirrors shouldSkipFrontendStatic in server/frontend/frontend.go
 * minus /file, which this worker does cache. Keep the two in step.
 */

/** Total attachment cache budget. Oldest entries are evicted past this. */
export const ATTACHMENT_CACHE_CAP_BYTES = 500 * 1024 * 1024;

const BYPASS_PREFIXES = ["/api", "/memos.api.v1"];

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
