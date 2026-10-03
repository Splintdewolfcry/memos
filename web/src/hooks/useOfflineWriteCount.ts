import { useSyncExternalStore } from "react";
import { getOfflineWriteCount, subscribeOfflineWriteCount } from "@/lib/offline-writes";

/**
 * Number of changes queued locally while offline. Re-renders whenever a save is
 * queued or a flush lands; useOfflineWriteSync keeps the count refreshed.
 */
export function useOfflineWriteCount(): number {
  return useSyncExternalStore(subscribeOfflineWriteCount, getOfflineWriteCount, getOfflineWriteCount);
}
