import { create } from "@bufbuild/protobuf";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OfflineStore } from "@/lib/offline-store";
import { offlineStore } from "@/lib/offline-store-instance";
import {
  buildOfflinePlaceholderMemo,
  enqueueMemoCreate,
  enqueueMemoUpdate,
  getOfflineWriteCount,
  listOfflineWrites,
  memoMatchesBase,
  OFFLINE_MEMO_NAME_PREFIX,
  refreshOfflineWriteCount,
  removeAllOfflineWrites,
  resetOfflineWriteState,
  subscribeOfflineWriteCount,
} from "@/lib/offline-writes";
import { type Memo, MemoSchema } from "@/types/proto/api/v1/memo_service_pb";

vi.mock("@/lib/offline-store-instance", async () => {
  const { createMemoryStore } = await import("@/lib/offline-store");
  return { offlineStore: createMemoryStore() };
});

const store = offlineStore as OfflineStore;

function setStoredUserName(name: string) {
  localStorage.setItem("memos_offline_session", JSON.stringify({ version: 1, user: { name } }));
}

const memo = (fields: Record<string, unknown>): Memo => create(MemoSchema, fields);

beforeEach(async () => {
  localStorage.clear();
  await store.clear();
  resetOfflineWriteState();
  setStoredUserName("users/steven");
});

describe("offline write queue storage", () => {
  it("enqueues a create and reports it as a pending write", async () => {
    const entry = await enqueueMemoCreate({ memo: memo({ content: "note" }) });

    expect(entry.placeholderName).toMatch(new RegExp(`^${OFFLINE_MEMO_NAME_PREFIX}`));
    const writes = await listOfflineWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ id: entry.id, kind: "create", placeholderName: entry.placeholderName });
    expect(getOfflineWriteCount()).toBe(1);
  });

  it("builds a placeholder that renders like a real memo", async () => {
    const entry = await enqueueMemoCreate({ memo: memo({ content: "note" }), parentMemoName: "memos/parent" });

    const placeholder = buildOfflinePlaceholderMemo(entry);
    expect(placeholder.name).toBe(entry.placeholderName);
    expect(placeholder.content).toBe("note");
    expect(placeholder.creator).toBe("users/steven");
    expect(placeholder.state).toBe(1); // State.NORMAL
    expect(placeholder.parent).toBe("memos/parent");
  });

  it("merges a second edit of the same memo into one update entry", async () => {
    const base = memo({ name: "memos/m", content: "original" });
    await enqueueMemoUpdate({ memoName: "memos/m", patch: { name: "memos/m", content: "first" }, updateMask: ["content"], base });
    await enqueueMemoUpdate({
      memoName: "memos/m",
      patch: { name: "memos/m", content: "second", pinned: true },
      updateMask: ["content", "pinned"],
      base,
    });

    const writes = await listOfflineWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      kind: "update",
      patch: { name: "memos/m", content: "second", pinned: true },
      updateMask: expect.arrayContaining(["content", "pinned"]),
      // The conflict baseline stays at the first observed server state.
      base: expect.objectContaining({ content: "original" }),
    });
  });

  it("folds an edit of a pending offline create into that create", async () => {
    const entry = await enqueueMemoCreate({ memo: memo({ content: "first draft" }) });

    await enqueueMemoUpdate({
      memoName: entry.placeholderName,
      patch: { name: entry.placeholderName, content: "second draft" },
      updateMask: ["content", "update_time"],
      base: buildOfflinePlaceholderMemo(entry),
    });

    const writes = await listOfflineWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ kind: "create", placeholderName: entry.placeholderName });
    expect(writes[0]).toMatchObject({ memo: expect.objectContaining({ content: "second draft" }) });
  });

  it("keeps the queue scoped to the signed-in account", async () => {
    await enqueueMemoCreate({ memo: memo({ content: "note" }) });

    setStoredUserName("users/other");
    expect(await listOfflineWrites()).toEqual([]);
    expect(getOfflineWriteCount()).toBe(1); // count follows the last publisher

    await refreshOfflineWriteCount();
    expect(getOfflineWriteCount()).toBe(0);
  });

  it("notifies count subscribers when writes are queued", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeOfflineWriteCount(listener);
    expect(getOfflineWriteCount()).toBe(0);

    await enqueueMemoCreate({ memo: memo({ content: "note" }) });
    expect(listener).toHaveBeenCalled();
    expect(getOfflineWriteCount()).toBe(1);

    unsubscribe();
    await enqueueMemoCreate({ memo: memo({ content: "note 2" }) });
    expect(listener).toHaveBeenCalledOnce();
  });

  it("removes every account's queued writes", async () => {
    await enqueueMemoCreate({ memo: memo({ content: "note" }) });
    setStoredUserName("users/other");
    await enqueueMemoCreate({ memo: memo({ content: "note" }) });

    await removeAllOfflineWrites(store);
    setStoredUserName("users/steven");
    expect(await listOfflineWrites()).toEqual([]);
    setStoredUserName("users/other");
    expect(await listOfflineWrites()).toEqual([]);
  });
});

describe("memoMatchesBase", () => {
  it("treats identical content and visibility as unchanged", () => {
    const base = memo({ content: "same", visibility: 1 });
    expect(memoMatchesBase(memo({ content: "same", visibility: 1 }), base)).toBe(true);
    expect(memoMatchesBase(memo({ content: "changed on the server", visibility: 1 }), base)).toBe(false);
    expect(memoMatchesBase(memo({ content: "same", visibility: 2 }), base)).toBe(false);
  });
});
