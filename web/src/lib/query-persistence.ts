import { type DehydratedState, dehydrate, hydrate, type QueryClient, type QueryKey } from "@tanstack/react-query";
import type { OfflineStore } from "@/lib/offline-store";

/**
 * Allowlist of query roots written to disk. Default-deny, so a new query type is
 * not silently persisted: it must be added here on purpose.
 *
 * Roots mirror the key factories: memoKeys, spaceKeys, attachmentKeys, userKeys
 * and instanceKeys each begin with one of these.
 */
export const PERSISTED_QUERY_ROOTS = ["memos", "spaces", "attachments", "users", "instance"] as const;

/** Hard ceiling on a restored cache. Bounds how long a memo whose access was
 * revoked on another device can linger offline. */
export const PERSISTED_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const KEY_PREFIX = "memos-query-cache:";

interface PersistedCache {
  savedAt: number;
  state: DehydratedState;
}

export function isPersistableQueryKey(key: QueryKey): boolean {
  const root = key[0];
  return typeof root === "string" && (PERSISTED_QUERY_ROOTS as readonly string[]).includes(root);
}

/** Per-user so a second account on the same browser cannot read the first's cache. */
export function persistedCacheKey(userName: string | undefined): string {
  return `${KEY_PREFIX}${userName ?? "anonymous"}`;
}

export async function saveQueryCache(client: QueryClient, store: OfflineStore, userName: string | undefined): Promise<void> {
  try {
    const state = dehydrate(client, {
      shouldDehydrateQuery: (query) => isPersistableQueryKey(query.queryKey) && query.state.status === "success",
      shouldDehydrateMutation: () => false,
    });
    const payload: PersistedCache = { savedAt: Date.now(), state };
    await store.set(persistedCacheKey(userName), payload);
  } catch (error) {
    // Quota exceeded, private browsing, or a value structured clone rejects.
    // Offline caching is an enhancement; it must never break the live app.
    console.warn("Failed to persist query cache:", error);
  }
}

/** Returns true when a cache was restored. Restored queries are invalidated so
 * an online client refetches immediately and the cache only ever serves as a
 * fallback. */
export async function restoreQueryCache(client: QueryClient, store: OfflineStore, userName: string | undefined): Promise<boolean> {
  try {
    const persisted = await store.get<PersistedCache>(persistedCacheKey(userName));
    if (!persisted) return false;
    if (Date.now() - persisted.savedAt > PERSISTED_CACHE_MAX_AGE_MS) {
      await store.remove(persistedCacheKey(userName));
      return false;
    }

    hydrate(client, persisted.state);
    for (const { queryKey } of persisted.state.queries) {
      client.invalidateQueries({ queryKey });
    }
    return true;
  } catch (error) {
    console.warn("Failed to restore query cache:", error);
    return false;
  }
}

export async function removeQueryCache(store: OfflineStore, userName: string | undefined): Promise<void> {
  try {
    await store.remove(persistedCacheKey(userName));
  } catch (error) {
    console.warn("Failed to remove query cache:", error);
  }
}

export async function removeAllQueryCaches(store: OfflineStore): Promise<void> {
  try {
    for (const key of await store.keys()) {
      if (key.startsWith(KEY_PREFIX)) await store.remove(key);
    }
  } catch (error) {
    console.warn("Failed to clear query caches:", error);
  }
}
