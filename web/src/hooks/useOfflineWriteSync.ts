import { create } from "@bufbuild/protobuf";
import { FieldMaskSchema } from "@bufbuild/protobuf/wkt";
import { Code } from "@connectrpc/connect";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { memoServiceClient } from "@/connect";
import { attachmentKeys } from "@/hooks/useAttachmentQueries";
import { memoKeys, patchMemoInCollectionQueries, removeMemoFromCollectionQueries } from "@/hooks/useMemoQueries";
import { userKeys } from "@/hooks/useUserQueries";
import { hasConnectCode } from "@/lib/error";
import { getStoredOfflineUserName } from "@/lib/offline-session";
import { isWriteBlocked } from "@/lib/offline-state";
import { offlineStore } from "@/lib/offline-store-instance";
import {
  isRecoverableWriteFailure,
  memoMatchesBase,
  type OfflineMemoCreate,
  type OfflineMemoUpdate,
  type OfflineWrite,
  readOfflineWrites,
  refreshOfflineWriteCount,
  writeOfflineWrites,
} from "@/lib/offline-writes";
import { getSSEStatus, subscribeSSEStatus } from "@/lib/sse-status";
import { type Memo, MemoSchema } from "@/types/proto/api/v1/memo_service_pb";

/**
 * Flushes the offline write queue to the server and applies the results to the
 * query cache. Kept beside the hook (not in lib/) because it owns RPC calls
 * and cache updates; lib/offline-writes.ts stays pure storage.
 */

export interface FlushSummary {
  /** Writes that reached the server, each with the memo the server returned. */
  synced: Array<{ write: OfflineWrite; memo: Memo }>;
  /** Writes still queued because connectivity never returned. */
  remaining: OfflineWrite[];
}

const EMPTY_SUMMARY: FlushSummary = { synced: [], remaining: [] };

let flushInFlight = false;

export async function flushOfflineWrites(): Promise<FlushSummary> {
  const store = offlineStore;
  const userName = getStoredOfflineUserName();
  if (!store || !userName) {
    return EMPTY_SUMMARY;
  }
  if (flushInFlight) return EMPTY_SUMMARY;
  if (isWriteBlocked()) {
    await refreshOfflineWriteCount();
    return EMPTY_SUMMARY;
  }

  flushInFlight = true;
  try {
    let writes = await readOfflineWrites(store, userName);
    const synced: FlushSummary["synced"] = [];
    while (writes.length > 0) {
      const write = writes[0];
      try {
        const memo = await flushWrite(write);
        writes = writes.slice(1);
        synced.push({ write, memo });
        // Persist progress entry by entry, so a mid-flush disconnect cannot
        // replay writes that already reached the server.
        await writeOfflineWrites(store, userName, writes);
      } catch (error) {
        if (isRecoverableWriteFailure(error)) break;
        // The server definitively rejected this write (invalid payload, revoked
        // access, …). Dropping it is data loss, but keeping it would wedge the
        // whole queue behind a failure that will never clear.
        console.error("Discarding an offline change the server rejected:", write, error);
        writes = writes.slice(1);
        await writeOfflineWrites(store, userName, writes);
      }
    }
    return { synced, remaining: writes };
  } finally {
    flushInFlight = false;
    void refreshOfflineWriteCount();
  }
}

async function flushWrite(write: OfflineWrite): Promise<Memo> {
  if (write.kind === "create") return flushCreate(write);
  return flushUpdate(write);
}

async function flushCreate(write: OfflineMemoCreate): Promise<Memo> {
  if (write.parentMemoName) {
    return memoServiceClient.createMemoComment({ name: write.parentMemoName, comment: write.memo });
  }
  return memoServiceClient.createMemo({ memo: write.memo });
}

async function flushUpdate(write: OfflineMemoUpdate): Promise<Memo> {
  let server: Memo | undefined;
  try {
    server = await memoServiceClient.getMemo({ name: write.memoName });
  } catch (error) {
    // A memo deleted elsewhere while this device was offline is a conflict,
    // not a failure: the offline edit is preserved as its own memo below.
    if (!hasConnectCode(error, Code.NotFound)) throw error;
  }

  if (server && !memoMatchesBase(server, write.base) && !write.updateMask.includes("content")) {
    // The memo changed on the server, but this edit touches no content — a
    // pin or archive-style tweak cannot collide with it, so apply it anyway.
    return applyUpdate(write);
  }
  if (server && memoMatchesBase(server, write.base)) {
    return applyUpdate(write);
  }

  // Conflict: the memo changed on the server (or is gone) since this edit was
  // based on it. Keep both versions as separate memos — the server keeps its
  // own, and the offline edit is saved as a new memo of its own.
  return memoServiceClient.createMemo({ memo: conflictMemoPayload(write) });
}

async function applyUpdate(write: OfflineMemoUpdate): Promise<Memo> {
  return memoServiceClient.updateMemo({
    memo: create(MemoSchema, write.patch as Record<string, unknown>),
    updateMask: create(FieldMaskSchema, { paths: write.updateMask }),
  });
}

function conflictMemoPayload(write: OfflineMemoUpdate): Memo {
  const { name: _name, ...merged } = { ...write.base, ...write.patch };
  return create(MemoSchema, merged as Record<string, unknown>);
}

function applyFlushToCache(queryClient: QueryClient, summary: FlushSummary): void {
  const parentCommentKeys = new Set<string>();
  for (const { write, memo } of summary.synced) {
    if (write.kind === "create") {
      // Seed the real memo, then retire the placeholder it replaces.
      queryClient.setQueryData(memoKeys.detail(memo.name), memo);
      queryClient.removeQueries({ queryKey: memoKeys.detail(write.placeholderName) });
      removeMemoFromCollectionQueries(queryClient, write.placeholderName);
      if (write.parentMemoName) parentCommentKeys.add(write.parentMemoName);
    } else {
      queryClient.setQueryData(memoKeys.detail(write.memoName), memo);
      patchMemoInCollectionQueries(queryClient, memo);
    }
  }
  if (summary.synced.length === 0) return;
  queryClient.invalidateQueries({ queryKey: memoKeys.lists() });
  queryClient.invalidateQueries({ queryKey: userKeys.stats() });
  queryClient.invalidateQueries({ queryKey: attachmentKeys.lists() });
  for (const parent of parentCommentKeys) {
    queryClient.invalidateQueries({ queryKey: memoKeys.comments(parent) });
  }
}

/**
 * Syncs the offline write queue whenever the server becomes reachable: on app
 * open (leftovers from a previous offline session), on the browser's "online"
 * event, and when the SSE connection proves the server is answering again.
 */
export function useOfflineWriteSync(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    const attempt = () => {
      flushOfflineWrites()
        .then((summary) => applyFlushToCache(queryClient, summary))
        .catch((error) => console.warn("Failed to sync offline changes:", error));
    };
    attempt();
    window.addEventListener("online", attempt);
    // navigator.onLine can lie (captive portals report online), so the SSE
    // connection succeeding is the trustworthy reconnect signal.
    const unsubscribe = subscribeSSEStatus(() => {
      if (getSSEStatus() === "connected") attempt();
    });
    return () => {
      window.removeEventListener("online", attempt);
      unsubscribe();
    };
  }, [queryClient]);
}
