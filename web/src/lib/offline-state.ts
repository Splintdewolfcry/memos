let override: boolean | undefined;

if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    override = true;
  });
  window.addEventListener("offline", () => {
    override = false;
  });
}

/** Test seam: forces the reported connectivity without touching the global. */
export function setNavigatorOnline(online: boolean): void {
  override = online;
}

/**
 * True when a mutation cannot possibly reach the server.
 *
 * Editor saves no longer refuse while offline — they queue in
 * lib/offline-writes.ts and sync when connectivity returns — but quick
 * mutations (pin toggles, task checkboxes, moves) still block up front, and
 * the flush engine refuses to run while the browser reports no connection.
 */
export function isWriteBlocked(): boolean {
  if (override !== undefined) return !override;
  return typeof navigator !== "undefined" && navigator.onLine === false;
}
