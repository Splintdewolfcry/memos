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
 * useUpdateMemo applies an optimistic patch in onMutate and rolls it back in
 * onError, so an offline edit visibly appears and then vanishes. Blocking up
 * front turns that silent revert into an explicit refusal.
 */
export function isWriteBlocked(): boolean {
  if (override !== undefined) return !override;
  return typeof navigator !== "undefined" && navigator.onLine === false;
}
