import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { hasConnectCode } from "@/lib/error";
import { getStoredOfflineUserName } from "@/lib/offline-session";
import { isWriteBlocked } from "@/lib/offline-state";
import type { OfflineStore } from "@/lib/offline-store";
import { offlineStore } from "@/lib/offline-store-instance";
import { State } from "@/types/proto/api/v1/common_pb";
import { type Memo, MemoSchema } from "@/types/proto/api/v1/memo_service_pb";

/**
 * Offline write queue. Saves made with no connectivity are stored here (the
 * same IndexedDB database that backs the offline query cache) and flushed to
 * the server by useOfflineWriteSync once connectivity returns. This module is
 * pure storage plus queue bookkeeping: RPC calls live in the sync hook, cache
 * updates live with the callers that can see the query client.
 */

/** Names of locally queued memos look like this until they are synced. */
export const OFFLINE_MEMO_NAME_PREFIX = "offline/";

export function isOfflineMemoName(name: string): boolean {
  return name.startsWith(OFFLINE_MEMO_NAME_PREFIX);
}

const QUEUE_VERSION = 1;
const KEY_PREFIX = "memos-offline-writes:";

export interface OfflineMemoCreate {
  id: string;
  kind: "create";
  /** The name the placeholder shown to the user carries. */
  placeholderName: string;
  /** Payload for createMemo / createMemoComment, without a server name. */
  memo: Memo;
  /** Set when the queued memo is a comment. */
  parentMemoName?: string;
  savedAt: number;
}

export interface OfflineMemoUpdate {
  id: string;
  kind: "update";
  memoName: string;
  /** The fields to write, exactly what an updateMemo call would send. */
  patch: Partial<Memo> & { name: string };
  updateMask: string[];
  /** The memo as this device last saw it on the server; the conflict baseline. */
  base: Memo;
  savedAt: number;
}

export type OfflineWrite = OfflineMemoCreate | OfflineMemoUpdate;

interface StoredQueue {
  version: number;
  writes: OfflineWrite[];
}

/** Per-user, so a second account on this browser can never sync the first's notes. */
function queueKey(userName: string): string {
  return `${KEY_PREFIX}${userName}`;
}

/** Reads the queue of the named account. Shape-checked; unreadable means empty. */
export async function readOfflineWrites(store: OfflineStore, userName: string): Promise<OfflineWrite[]> {
  const stored = await store.get<StoredQueue>(queueKey(userName));
  if (!stored || stored.version !== QUEUE_VERSION || !Array.isArray(stored.writes)) return [];
  return stored.writes;
}

/** Persists the queue; an emptied queue removes its entry entirely. */
export async function writeOfflineWrites(store: OfflineStore, userName: string, writes: OfflineWrite[]): Promise<void> {
  if (writes.length === 0) {
    await store.remove(queueKey(userName));
  } else {
    await store.set(queueKey(userName), { version: QUEUE_VERSION, writes } satisfies StoredQueue);
  }
}

/** The queued writes of the stored offline session, for display and flushing. */
export async function listOfflineWrites(): Promise<OfflineWrite[]> {
  const store = offlineStore;
  const userName = getStoredOfflineUserName();
  if (!store || !userName) return [];
  try {
    return await readOfflineWrites(store, userName);
  } catch (error) {
    console.warn("Failed to read the offline write queue:", error);
    return [];
  }
}

/** Drops every account's queued writes. Containment for sign-out, matching removeAllQueryCaches. */
export async function removeAllOfflineWrites(store: OfflineStore): Promise<void> {
  try {
    for (const key of await store.keys()) {
      if (key.startsWith(KEY_PREFIX)) await store.remove(key);
    }
  } catch (error) {
    console.warn("Failed to clear the offline write queue:", error);
  }
}

function newWriteId(): string {
  return crypto.randomUUID();
}

function queueUnavailableError(): ConnectError {
  // Private browsing (no IndexedDB) or no stored session to scope the queue to.
  return new ConnectError("Offline saving is unavailable on this device. Reconnect to save.", Code.Unavailable);
}

function requireQueue(): { store: OfflineStore; userName: string } {
  const store = offlineStore;
  const userName = getStoredOfflineUserName();
  if (!store || !userName) throw queueUnavailableError();
  return { store, userName };
}

/** Queues a memo (or comment) creation and returns the placeholder entry. */
export async function enqueueMemoCreate(request: { memo: Memo; parentMemoName?: string }): Promise<OfflineMemoCreate> {
  const { store, userName } = requireQueue();
  const id = newWriteId();
  const entry: OfflineMemoCreate = {
    id,
    kind: "create",
    placeholderName: `${OFFLINE_MEMO_NAME_PREFIX}${id}`,
    memo: request.memo,
    ...(request.parentMemoName ? { parentMemoName: request.parentMemoName } : {}),
    savedAt: Date.now(),
  };
  const writes = await readOfflineWrites(store, userName);
  writes.push(entry);
  await writeOfflineWrites(store, userName, writes);
  publishOfflineWriteCount(writes.length);
  return entry;
}

/**
 * Queues an edit of a memo this device has already seen. A second edit of the
 * same memo joins the first entry so one flush applies every change, while
 * `base` keeps the original server baseline for conflict detection. Editing a
 * pending offline create folds the change into that create instead, so exactly
 * one memo is created, already in its newest form.
 */
export async function enqueueMemoUpdate(request: {
  memoName: string;
  patch: Partial<Memo> & { name: string };
  updateMask: string[];
  base: Memo;
}): Promise<void> {
  const { store, userName } = requireQueue();
  const writes = await readOfflineWrites(store, userName);

  if (isOfflineMemoName(request.memoName)) {
    const pendingCreate = writes.find(
      (write): write is OfflineMemoCreate => write.kind === "create" && write.placeholderName === request.memoName,
    );
    if (!pendingCreate) throw queueUnavailableError();
    pendingCreate.memo = mergeCreatePatch(pendingCreate.memo, request.patch, request.updateMask);
    pendingCreate.savedAt = Date.now();
    await writeOfflineWrites(store, userName, writes);
    publishOfflineWriteCount(writes.length);
    return;
  }

  const pending = writes.find((write): write is OfflineMemoUpdate => write.kind === "update" && write.memoName === request.memoName);
  if (pending) {
    pending.patch = { ...pending.patch, ...request.patch };
    pending.updateMask = [...new Set([...pending.updateMask, ...request.updateMask])];
    pending.savedAt = Date.now();
  } else {
    writes.push({ id: newWriteId(), kind: "update", ...request, savedAt: Date.now() });
  }
  await writeOfflineWrites(store, userName, writes);
  publishOfflineWriteCount(writes.length);
}

/** Fields an update mask can name, mapped to the create payload they modify. */
const PATCHABLE_FIELDS: Record<string, keyof Memo> = {
  content: "content",
  visibility: "visibility",
  attachments: "attachments",
  relations: "relations",
  location: "location",
  pinned: "pinned",
  create_time: "createTime",
  update_time: "updateTime",
};

function mergeCreatePatch(memo: Memo, patch: Partial<Memo>, updateMask: string[]): Memo {
  const next: Record<string, unknown> = { ...memo };
  for (const field of updateMask) {
    const key = PATCHABLE_FIELDS[field];
    // update_time often rides along in the mask without a value; the server
    // stamps it on create, so a missing field is simply left alone.
    if (key && patch[key] !== undefined) next[key] = patch[key];
  }
  return create(MemoSchema, next);
}

/**
 * The memo object shown while the write is queued. It carries the offline
 * placeholder name and the signed-in creator so it renders like any other
 * memo; flushing replaces it with the real server memo.
 */
export function buildOfflinePlaceholderMemo(entry: OfflineMemoCreate): Memo {
  return create(MemoSchema, {
    ...entry.memo,
    name: entry.placeholderName,
    state: State.NORMAL,
    creator: getStoredOfflineUserName() ?? "",
    ...(entry.parentMemoName ? { parent: entry.parentMemoName } : {}),
  });
}

/**
 * Conflict baseline: the fields another device could have changed between the
 * offline edit and its flush. Everything else either merges naturally through
 * the update mask or is metadata this device did not touch.
 */
export function memoMatchesBase(server: Memo, base: Memo): boolean {
  return server.content === base.content && server.visibility === base.visibility;
}

/**
 * True when a flush failure means "try again later" rather than "never".
 * Unauthenticated counts as recoverable: the auth interceptor refreshes tokens,
 * and a session that comes back is expected to be allowed to write again.
 */
export function isRecoverableWriteFailure(error: unknown): boolean {
  return (
    hasConnectCode(error, Code.Unavailable, Code.Unknown, Code.DeadlineExceeded, Code.Canceled, Code.Unauthenticated) || isWriteBlocked()
  );
}

// ---------------------------------------------------------------------------
// Pending-count store, so the offline banner can announce queued changes.
// ---------------------------------------------------------------------------

let pendingCount = 0;
const countListeners = new Set<() => void>();

function publishOfflineWriteCount(count: number): void {
  if (count === pendingCount) return;
  pendingCount = count;
  for (const listener of countListeners) listener();
}

export function getOfflineWriteCount(): number {
  return pendingCount;
}

export function subscribeOfflineWriteCount(listener: () => void): () => void {
  countListeners.add(listener);
  return () => countListeners.delete(listener);
}

/** Re-reads the queue so the published count matches what is on disk. */
export async function refreshOfflineWriteCount(): Promise<void> {
  const store = offlineStore;
  const userName = getStoredOfflineUserName();
  if (!store || !userName) {
    publishOfflineWriteCount(0);
    return;
  }
  try {
    publishOfflineWriteCount((await readOfflineWrites(store, userName)).length);
  } catch (error) {
    console.warn("Failed to read the offline write queue:", error);
  }
}

/** Test seam: resets module-level count state between tests. */
export function resetOfflineWriteState(): void {
  pendingCount = 0;
  countListeners.clear();
}
