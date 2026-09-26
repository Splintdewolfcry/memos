import { Code, ConnectError } from "@connectrpc/connect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoService } from "@/components/MemoEditor/services/memoService";
import { createInitialState } from "@/components/MemoEditor/state";
import { isWriteBlocked, setNavigatorOnline } from "@/lib/offline-state";

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

describe("isWriteBlocked", () => {
  beforeEach(() => {
    setNavigatorOnline(true);
  });

  it("allows writes while online", () => {
    expect(isWriteBlocked()).toBe(false);
  });

  it("blocks writes while the browser reports no connection", () => {
    setNavigatorOnline(false);
    expect(isWriteBlocked()).toBe(true);
  });
});

describe("composer writes", () => {
  beforeEach(() => {
    setNavigatorOnline(true);
    uploads.uploadFiles.mockResolvedValue([]);
    clients.createMemo.mockImplementation(async ({ memo }: { memo: { content: string } }) => ({ ...memo, name: "memos/created" }));
  });

  const draftWithPendingAttachment = () => {
    const state = createInitialState();
    state.content = "Roadmap";
    state.localFiles = [{ file: new File(["bytes"], "photo.png", { type: "image/png" }), previewUrl: "blob:photo" }];
    return state;
  };

  it("refuses an offline save before uploading attachments or calling the memo API", async () => {
    setNavigatorOnline(false);

    const error: unknown = await memoService
      .save(draftWithPendingAttachment(), { space: "spaces/product" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConnectError);
    expect(ConnectError.from(error).code).toBe(Code.Unavailable);
    // ConnectError renders `message` as "[code] text"; `rawMessage` is the text the guard threw.
    expect(ConnectError.from(error).rawMessage).toBe("You are offline. Reconnect to save this change.");
    expect(uploads.uploadFiles).not.toHaveBeenCalled();
    expect(clients.createMemo).not.toHaveBeenCalled();
    expect(clients.updateMemo).not.toHaveBeenCalled();
    expect(clients.createMemoComment).not.toHaveBeenCalled();
  });

  it("refuses an offline save of an existing memo before refetching it", async () => {
    setNavigatorOnline(false);

    await expect(memoService.save(draftWithPendingAttachment(), { memoName: "memos/existing" })).rejects.toBeInstanceOf(ConnectError);

    expect(uploads.uploadFiles).not.toHaveBeenCalled();
    expect(clients.getMemo).not.toHaveBeenCalled();
  });

  it("saves the draft once connectivity returns", async () => {
    const result = await memoService.save(draftWithPendingAttachment(), { space: "spaces/product" });

    expect(result).toEqual({ memoName: "memos/created", hasChanges: true });
    expect(uploads.uploadFiles).toHaveBeenCalledOnce();
    expect(clients.createMemo).toHaveBeenCalledOnce();
  });
});
