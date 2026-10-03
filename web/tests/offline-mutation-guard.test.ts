import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoService } from "@/components/MemoEditor/services/memoService";
import { createInitialState } from "@/components/MemoEditor/state";
import { memoKeys } from "@/hooks/useMemoQueries";
import { isWriteBlocked, setNavigatorOnline } from "@/lib/offline-state";
import type { OfflineStore } from "@/lib/offline-store";
import { offlineStore } from "@/lib/offline-store-instance";
import { listOfflineWrites, resetOfflineWriteState } from "@/lib/offline-writes";
import { queryClient } from "@/lib/query-client";
import { ListMemosResponseSchema, MemoSchema } from "@/types/proto/api/v1/memo_service_pb";

const clients = vi.hoisted(() => ({
  createMemo: vi.fn(),
  createMemoComment: vi.fn(),
  getMemo: vi.fn(),
  updateMemo: vi.fn(),
}));

const uploads = vi.hoisted(() => ({
  uploadFiles: vi.fn(),
}));

vi.mock("@/connect", () => ({
  attachmentServiceClient: {
    createAttachment: vi.fn(),
    uploadAttachment: vi.fn(),
  },
  memoServiceClient: {
    createMemo: clients.createMemo,
    createMemoComment: clients.createMemoComment,
    getMemo: clients.getMemo,
    updateMemo: clients.updateMemo,
  },
}));

vi.mock("@/components/MemoEditor/services/uploadService", () => ({
  uploadService: uploads,
}));

vi.mock("@/lib/offline-store-instance", async () => {
  const { createMemoryStore } = await import("@/lib/offline-store");
  return { offlineStore: createMemoryStore() };
});

const store = offlineStore as OfflineStore;

/** Scopes the queue to a signed-in offline session, like saveOfflineSession does. */
function setStoredUserName(name: string) {
  localStorage.setItem("memos_offline_session", JSON.stringify({ version: 1, user: { name } }));
}

const draftWithPendingAttachment = () => {
  const state = createInitialState();
  state.content = "Roadmap";
  state.localFiles = [{ file: new File(["bytes"], "photo.png", { type: "image/png" }), previewUrl: "blob:photo" }];
  return state;
};

const textDraft = (content: string) => {
  const state = createInitialState();
  state.content = content;
  return state;
};

beforeEach(async () => {
  setNavigatorOnline(true);
  vi.clearAllMocks();
  queryClient.clear();
  await store.clear();
  resetOfflineWriteState();
  localStorage.clear();
  setStoredUserName("users/steven");
  uploads.uploadFiles.mockResolvedValue([]);
  clients.createMemo.mockImplementation(async ({ memo }: { memo: { content: string } }) => ({ ...memo, name: "memos/created" }));
});

describe("isWriteBlocked", () => {
  it("allows writes while online", () => {
    expect(isWriteBlocked()).toBe(false);
  });

  it("blocks writes while the browser reports no connection", () => {
    setNavigatorOnline(false);
    expect(isWriteBlocked()).toBe(true);
  });
});

describe("composer writes while offline", () => {
  it("refuses a save with pending attachments before uploading anything", async () => {
    setNavigatorOnline(false);

    const error: unknown = await memoService
      .save(draftWithPendingAttachment(), { space: "spaces/product" })
      .catch((caught: unknown) => caught);

    // Attachment bytes cannot be queued, only uploaded, so the draft is refused
    // exactly like before queueing existed.
    expect(error).toBeInstanceOf(ConnectError);
    expect(ConnectError.from(error).code).toBe(Code.Unavailable);
    expect(uploads.uploadFiles).not.toHaveBeenCalled();
    expect(clients.createMemo).not.toHaveBeenCalled();
    expect(clients.updateMemo).not.toHaveBeenCalled();
    expect(clients.createMemoComment).not.toHaveBeenCalled();
    expect(await listOfflineWrites()).toEqual([]);
  });

  it("queues a new memo locally and shows it in the cached lists", async () => {
    setNavigatorOnline(false);
    queryClient.setQueryData(memoKeys.list({}), create(ListMemosResponseSchema, { memos: [] }));

    const result = await memoService.save(textDraft("Offline note"), { space: "spaces/product" });

    expect(result.queuedOffline).toBe(true);
    expect(result.memoName).toMatch(/^offline\//);
    // Nothing reached the server.
    expect(clients.createMemo).not.toHaveBeenCalled();
    expect(uploads.uploadFiles).not.toHaveBeenCalled();

    // The queue holds the pending create.
    const writes = await listOfflineWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ kind: "create", placeholderName: result.memoName });

    // The placeholder is visible immediately, in lists and as a detail.
    const lists = queryClient.getQueryData<{ memos: { name: string; content: string }[] }>(memoKeys.list({}));
    expect(lists?.memos[0]).toMatchObject({ name: result.memoName, content: "Offline note" });
    expect(queryClient.getQueryData<{ content: string }>(memoKeys.detail(result.memoName))).toMatchObject({ content: "Offline note" });
  });

  it("queues a comment against its parent memo", async () => {
    setNavigatorOnline(false);

    const result = await memoService.save(textDraft("A comment"), { parentMemoName: "memos/parent" });

    const writes = await listOfflineWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ kind: "create", parentMemoName: "memos/parent" });
    expect(clients.createMemoComment).not.toHaveBeenCalled();
    expect(result.memoName).toMatch(/^offline\//);
  });

  it("queues an edit of a cached memo and patches the cache in place", async () => {
    setNavigatorOnline(false);
    const memo = create(MemoSchema, { name: "memos/existing", content: "original" });
    queryClient.setQueryData(memoKeys.detail(memo.name), memo);
    queryClient.setQueryData(memoKeys.list({}), create(ListMemosResponseSchema, { memos: [memo] }));

    const result = await memoService.save(textDraft("edited"), { memoName: memo.name });

    expect(result).toEqual({ memoName: "memos/existing", hasChanges: true, queuedOffline: true });
    expect(clients.getMemo).not.toHaveBeenCalled();
    expect(clients.updateMemo).not.toHaveBeenCalled();

    const writes = await listOfflineWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      kind: "update",
      memoName: "memos/existing",
      updateMask: expect.arrayContaining(["content"]),
      // The base is the memo as this device last saw it, for conflict detection.
      base: expect.objectContaining({ content: "original" }),
    });

    // The edit is visible immediately.
    expect(queryClient.getQueryData<{ content: string }>(memoKeys.detail(memo.name))).toMatchObject({ content: "edited" });
    const lists = queryClient.getQueryData<{ memos: { name: string; content: string }[] }>(memoKeys.list({}));
    expect(lists?.memos[0]).toMatchObject({ name: "memos/existing", content: "edited" });
  });

  it("refuses an offline edit of a memo that is not cached on this device", async () => {
    setNavigatorOnline(false);

    const error: unknown = await memoService.save(textDraft("edited"), { memoName: "memos/uncached" }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConnectError);
    expect(ConnectError.from(error).code).toBe(Code.Unavailable);
    expect(await listOfflineWrites()).toEqual([]);
  });

  it("folds a second offline edit of a pending create into the same queue entry", async () => {
    setNavigatorOnline(false);
    queryClient.setQueryData(memoKeys.list({}), create(ListMemosResponseSchema, { memos: [] }));

    const first = await memoService.save(textDraft("first draft"), { space: "spaces/product" });
    const second = await memoService.save(textDraft("second draft"), { memoName: first.memoName });

    expect(second.queuedOffline).toBe(true);
    // One memo is created, already in its newest form — no separate update.
    const writes = await listOfflineWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ kind: "create", placeholderName: first.memoName });
    expect(writes[0]).toMatchObject({ memo: expect.objectContaining({ content: "second draft" }) });

    const lists = queryClient.getQueryData<{ memos: { content: string }[] }>(memoKeys.list({}));
    expect(lists?.memos[0]).toMatchObject({ content: "second draft" });
  });
});

describe("composer writes while online", () => {
  it("saves the draft through the API", async () => {
    const result = await memoService.save(draftWithPendingAttachment(), { space: "spaces/product" });

    expect(result).toEqual({ memoName: "memos/created", hasChanges: true });
    expect(uploads.uploadFiles).toHaveBeenCalledOnce();
    expect(clients.createMemo).toHaveBeenCalledOnce();
    expect(await listOfflineWrites()).toEqual([]);
  });
});
