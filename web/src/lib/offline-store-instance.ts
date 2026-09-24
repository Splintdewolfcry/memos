import { createIndexedDbStore, isOfflineStoreAvailable, type OfflineStore } from "@/lib/offline-store";

/**
 * Single shared IndexedDB handle for the offline query cache. Imported by both
 * main.tsx (restore before render) and AuthContext.tsx (clear on logout) so
 * there is exactly one database connection.
 */
export const offlineStore: OfflineStore | undefined = isOfflineStoreAvailable() ? createIndexedDbStore("memos-offline") : undefined;
