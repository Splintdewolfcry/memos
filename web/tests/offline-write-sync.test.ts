import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushOfflineWrites } from "@/hooks/useOfflineWriteSync";
import { setNavigatorOnline } from "@/lib/offline-state";
import type { OfflineStore } from "@/lib/offline-store";
import { offlineStore } from "@/lib/offline-store-instance";
import { enqueueMemoCreate, enqueueMemoUpdate, listOfflineWrites, resetOfflineWriteState } from "@/lib/offline-writes";
import { type Memo, MemoSchema } from "@/types/proto/api/v1/memo_service_pb";

const clients = vi.hoisted(() => ({
  createMemo: vi.fn(),
  createMemoComment: vi.fn(),
  getMemo: vi.fn(),
  updateMemo: vi.fn(),
}));

vi.mock("@/connect", () => ({
  memoServiceClient: {
    createMemo: clients.createMemo,
    createMemoComment: clients.createMemoComment,
    getMemo: clients.getMemo,
    updateMemo: clients.updateMemo,
  },
}));

vi.mock("@/lib/offline-store-instance", async () => {
  const { createMemoryStore } = await import("@/lib/offline-store");
  return { offlineStore: createMemoryStore() };
});
const queueStore = offlineStore as OfflineStore;

vi.mock("@/lib/query-client", () => ({
  queryClient: { clear: vi.fn(), setQueryData: vi.fn(), invalidateQueries: vi.fn(), removeQueries: vi.fn() },
}));
function setStoredUserName(name: string) {
  localStorage.setItem("memos_offline_session", JSON.stringify({ version: 1, user: { name } }));
}

const memo = (fields: Record<string, unknown>): Memo => create(MemoSchema, fields);

beforeEach(async () => {
  setNavigatorOnline(true);
  vi.clearAllMocks();
  localStorage.clear();
  await queueStore.clear();
  resetOfflineWriteState();
  setStoredUserName("users/steven");
});

describe("flushOfflineWrites", () => {
  it("creates queued memos on the server and empties the queue", async () => {
    const entry = await enqueueMemoCreate({ memo: memo({ content: "Offline note" }) });
    clients.createMemo.mockImplementation(async ({ memo: payload }: { memo: Memo }) => ({ ...payload, name: "memos/synced" }));

    const summary = await flushOfflineWrites();

    expect(clients.createMemo).toHaveBeenCalledOnce();
    expect(clients.createMemo.mock.calls[0][0]).toMatchObject({ memo: expect.objectContaining({ content: "Offline note" }) });
    expect(summary.synced).toEqual([
      { write: expect.objectContaining({ id: entry.id }), memo: expect.objectContaining({ name: "memos/synced" }) },
    ]);
    expect(summary.remaining).toEqual([]);
    expect(await listOfflineWrites()).toEqual([]);
  });

  it("creates queued comments against their parent memo", async () => {
    await enqueueMemoCreate({ memo: memo({ content: "A comment" }), parentMemoName: "memos/parent" });
    clients.createMemoComment.mockResolvedValue(memo({ name: "memos/comment" }));

    await flushOfflineWrites();

    expect(clients.createMemoComment).toHaveBeenCalledWith(expect.objectContaining({ name: "memos/parent" }));
    expect(clients.createMemo).not.toHaveBeenCalled();
  });

  it("applies a queued update when the server memo still matches the baseline", async () => {
    const base = memo({ name: "memos/m", content: "original" });
    await enqueueMemoUpdate({ memoName: "memos/m", patch: { name: "memos/m", content: "edited" }, updateMask: ["content"], base });
    clients.getMemo.mockResolvedValue(memo({ name: "memos/m", content: "original" }));
    clients.updateMemo.mockImplementation(async ({ memo: patch }: { memo: Memo }) => memo({ ...patch, name: "memos/m" }));

    const summary = await flushOfflineWrites();

    expect(clients.updateMemo).toHaveBeenCalledOnce();
    expect(clients.updateMemo.mock.calls[0][0]).toMatchObject({
      memo: expect.objectContaining({ content: "edited" }),
      updateMask: expect.objectContaining({ paths: ["content"] }),
    });
    expect(clients.createMemo).not.toHaveBeenCalled();
    expect(summary.synced).toHaveLength(1);
    expect(await listOfflineWrites()).toEqual([]);
  });

  it("keeps both versions when the memo changed on the server", async () => {
    const base = memo({ name: "memos/m", content: "original" });
    await enqueueMemoUpdate({ memoName: "memos/m", patch: { name: "memos/m", content: "offline edit" }, updateMask: ["content"], base });
    // Another device edited the memo while this one was offline.
    clients.getMemo.mockResolvedValue(memo({ name: "memos/m", content: "server edit" }));
    clients.createMemo.mockResolvedValue(memo({ name: "memos/duplicate", content: "offline edit" }));

    const summary = await flushOfflineWrites();

    // The server keeps its version; the offline edit is saved as a separate memo.
    expect(clients.updateMemo).not.toHaveBeenCalled();
    expect(clients.createMemo).toHaveBeenCalledOnce();
    expect(clients.createMemo.mock.calls[0][0]).toMatchObject({ memo: expect.objectContaining({ content: "offline edit" }) });
    expect(summary.synced).toHaveLength(1);
    expect(await listOfflineWrites()).toEqual([]);
  });

  it("keeps the offline edit as a new memo when the memo was deleted on the server", async () => {
    const base = memo({ name: "memos/m", content: "original" });
    await enqueueMemoUpdate({ memoName: "memos/m", patch: { name: "memos/m", content: "offline edit" }, updateMask: ["content"], base });
    clients.getMemo.mockRejectedValue(new ConnectError("the memo is gone", Code.NotFound));
    clients.createMemo.mockResolvedValue(memo({ name: "memos/recovered", content: "offline edit" }));

    const summary = await flushOfflineWrites();

    expect(clients.createMemo).toHaveBeenCalledOnce();
    expect(clients.updateMemo).not.toHaveBeenCalled();
    expect(summary.synced).toHaveLength(1);
  });

  it("applies a metadata-only edit even when the server content changed", async () => {
    const base = memo({ name: "memos/m", content: "original" });
    await enqueueMemoUpdate({ memoName: "memos/m", patch: { name: "memos/m", pinned: true }, updateMask: ["pinned"], base });
    clients.getMemo.mockResolvedValue(memo({ name: "memos/m", content: "server edit" }));
    clients.updateMemo.mockResolvedValue(memo({ name: "memos/m", pinned: true }));

    await flushOfflineWrites();

    expect(clients.updateMemo).toHaveBeenCalledOnce();
    expect(clients.createMemo).not.toHaveBeenCalled();
  });

  it("keeps the queue when connectivity fails mid-flush", async () => {
    await enqueueMemoCreate({ memo: memo({ content: "first" }) });
    clients.createMemo.mockRejectedValue(new ConnectError("no network", Code.Unavailable));

    const summary = await flushOfflineWrites();

    expect(summary).toEqual({ synced: [], remaining: [expect.objectContaining({ kind: "create" })] });
    expect(await listOfflineWrites()).toHaveLength(1);
  });

  it("discards a write the server definitively rejects", async () => {
    const base = memo({ name: "memos/m", content: "original" });
    await enqueueMemoUpdate({ memoName: "memos/m", patch: { name: "memos/m", content: "edited" }, updateMask: ["content"], base });
    clients.getMemo.mockResolvedValue(memo({ name: "memos/m", content: "original" }));
    clients.updateMemo.mockRejectedValue(new ConnectError("bad field mask", Code.InvalidArgument));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const summary = await flushOfflineWrites();

    expect(summary.synced).toEqual([]);
    expect(summary.remaining).toEqual([]);
    expect(await listOfflineWrites()).toEqual([]);
    errorSpy.mockRestore();
  });

  it("does nothing while the browser reports no connection", async () => {
    setNavigatorOnline(false);
    await enqueueMemoCreate({ memo: memo({ content: "note" }) });

    const summary = await flushOfflineWrites();

    expect(summary).toEqual({ synced: [], remaining: [] });
    expect(clients.createMemo).not.toHaveBeenCalled();
    // The queue is untouched, waiting for connectivity.
    expect(await listOfflineWrites()).toHaveLength(1);
  });

  it("flushes in order, persisting progress after each write", async () => {
    const first = await enqueueMemoCreate({ memo: memo({ content: "first" }) });
    await enqueueMemoCreate({ memo: memo({ content: "second" }) });
    clients.createMemo.mockImplementation(async ({ memo: payload }: { memo: Memo }) => ({ ...payload, name: `memos/${payload.content}` }));

    const summary = await flushOfflineWrites();

    expect(clients.createMemo.mock.calls.map((call) => call[0].memo?.content)).toEqual(["first", "second"]);
    expect(summary.synced.map((item) => item.write.id)).toEqual([first.id, expect.any(String)]);
    expect(await listOfflineWrites()).toEqual([]);
  });
});
