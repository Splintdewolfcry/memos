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
