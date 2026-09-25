import { hasStoredToken } from "@/auth-state";
import { getStoredOfflineUserName } from "@/lib/offline-session";
import { offlineStore } from "@/lib/offline-store-instance";
import { queryClient } from "@/lib/query-client";
import { restoreQueryCache, saveQueryCache } from "@/lib/query-persistence";

/**
 * Registers the offline app shell worker. Deliberately inert when service
 * workers are unsupported or the context is not secure, so plain-HTTP
 * development and older browsers keep working unchanged.
 */
export async function registerOfflineWorker(): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  if (typeof window === "undefined" || !window.isSecureContext) return;

  try {
    await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    // Without this, Android Chrome may evict Cache Storage and IndexedDB under
    // storage pressure, silently reintroducing the failure this worker prevents.
    if (navigator.storage?.persist) {
      const granted = await navigator.storage.persist();
      if (!granted) console.warn("Persistent storage was not granted; offline cache may be evicted.");
    }
  } catch (error) {
    // A failed registration must not break the live app.
    console.warn("Service worker registration failed:", error);
  }
}

/**
 * Rehydrates the persisted query cache before first render. Returns false when
 * the store is unavailable or no stored token exists (gated so a previous
 * account's cache cannot hydrate into the next account's queryClient).
 */
export async function restorePersistedQueries(): Promise<boolean> {
  if (!offlineStore) return false;
  if (!hasStoredToken()) return false;
  return restoreQueryCache(queryClient, offlineStore, getStoredOfflineUserName());
}

/**
 * Writes the query cache back on a 30s interval, plus pagehide and
 * visibilitychange flushes. Returns a stop function that clears the interval
 * and removes both event listeners.
 */
export function startQueryCachePersistence(userName: string | undefined): () => void {
  if (!offlineStore || !userName) return () => {};
  const store = offlineStore;
  const timer = window.setInterval(() => {
    void saveQueryCache(queryClient, store, userName);
  }, 30_000);
  const flush = () => void saveQueryCache(queryClient, store, userName);
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", flush);
  return () => {
    window.clearInterval(timer);
    window.removeEventListener("pagehide", flush);
    document.removeEventListener("visibilitychange", flush);
  };
}

/**
 * Schedules worker registration: immediately if the document is already fully
 * loaded, otherwise on the load event. This avoids a race where a slow restore
 * causes load to fire before the listener is attached.
 */
export function scheduleWorkerRegistration(): void {
  const registerWorker = () => void registerOfflineWorker();
  if (document.readyState === "complete") registerWorker();
  else window.addEventListener("load", registerWorker);
}

/** Drops cached attachment bytes. Cache Storage is per-origin, so private
 * attachments fetched for one account must not outlive that account's session. */
export async function clearAttachmentCache(): Promise<void> {
  if (typeof caches === "undefined") return;
  try {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith("memos-attachments-")).map((key) => caches.delete(key)));
  } catch (error) {
    console.warn("Failed to clear attachment cache:", error);
  }
}
