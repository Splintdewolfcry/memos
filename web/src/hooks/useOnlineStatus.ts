import { useSyncExternalStore } from "react";

function subscribeToConnectivity(callback: () => void): () => void {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

/**
 * Browser-reported connectivity, re-rendering on the online/offline events.
 * navigator.onLine can lie (captive portals report online), so server
 * reachability is tracked separately by the SSE connection status.
 */
export function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribeToConnectivity, () => navigator.onLine);
}
