import { create } from "@bufbuild/protobuf";
import { FieldMaskSchema, timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { isEqual } from "lodash-es";
import { getEditorReferenceRelations } from "@/components/MemoMetadata/Relation/relationHelpers";
import { memoServiceClient } from "@/connect";
import {
  findMemoInCollectionQueries,
  type MemoPatch,
  memoKeys,
  patchMemoInCollectionQueries,
  prependMemoToCollectionQueries,
} from "@/hooks/useMemoQueries";
import { isWriteBlocked } from "@/lib/offline-state";
import { buildOfflinePlaceholderMemo, enqueueMemoCreate, enqueueMemoUpdate } from "@/lib/offline-writes";
import { queryClient } from "@/lib/query-client";
import type { Attachment } from "@/types/proto/api/v1/attachment_service_pb";
import { AttachmentSchema } from "@/types/proto/api/v1/attachment_service_pb";
import type { Memo } from "@/types/proto/api/v1/memo_service_pb";
import { MemoSchema } from "@/types/proto/api/v1/memo_service_pb";
import type { EditorState } from "../state";
import { uploadService } from "./uploadService";

/**
 * Converts attachments to reference format for API requests.
 * The backend only needs the attachment name to link it to a memo.
 */
function toAttachmentReferences(attachments: Attachment[]): Attachment[] {
  return attachments.map((a) => create(AttachmentSchema, { name: a.name }));
}

function buildUpdateMask(
  prevMemo: Memo,
  state: EditorState,
  allAttachments: typeof state.metadata.attachments,
): { mask: Set<string>; patch: Partial<Memo> } {
  const mask = new Set<string>();
  const patch: Partial<Memo> = {
    name: prevMemo.name,
    content: state.content,
  };

  if (!isEqual(state.content, prevMemo.content)) {
    mask.add("content");
    patch.content = state.content;
  }
  if (!isEqual(state.metadata.visibility, prevMemo.visibility)) {
    mask.add("visibility");
    patch.visibility = state.metadata.visibility;
  }
  if (!isEqual(allAttachments, prevMemo.attachments)) {
    mask.add("attachments");
    patch.attachments = toAttachmentReferences(allAttachments);
  }
  const previousReferenceRelations = getEditorReferenceRelations(prevMemo.relations, prevMemo.name);
  const nextReferenceRelations = getEditorReferenceRelations(state.metadata.relations, prevMemo.name);
  if (!isEqual(nextReferenceRelations, previousReferenceRelations)) {
    mask.add("relations");
    patch.relations = nextReferenceRelations;
  }
  if (!isEqual(state.metadata.location, prevMemo.location)) {
    mask.add("location");
    patch.location = state.metadata.location;
  }

  // Auto-update timestamp if content changed
  if (["content", "attachments", "relations", "location"].some((key) => mask.has(key))) {
    mask.add("update_time");
  }

  // Handle custom timestamps
  if (state.timestamps.createTime) {
    const prevCreateTime = prevMemo.createTime ? timestampDate(prevMemo.createTime) : undefined;
    if (!isEqual(state.timestamps.createTime, prevCreateTime)) {
      mask.add("create_time");
      patch.createTime = timestampFromDate(state.timestamps.createTime);
    }
  }
  if (state.timestamps.updateTime) {
    const prevUpdateTime = prevMemo.updateTime ? timestampDate(prevMemo.updateTime) : undefined;
    if (!isEqual(state.timestamps.updateTime, prevUpdateTime)) {
      mask.add("update_time");
      patch.updateTime = timestampFromDate(state.timestamps.updateTime);
    }
  }

  return { mask, patch };
}

export const memoService = {
  async save(
    state: EditorState,
    options: {
      memoName?: string;
      parentMemoName?: string;
      space?: string;
    },
  ): Promise<{ memoName: string; hasChanges: boolean; queuedOffline?: boolean }> {
    // No connectivity: queue the save locally instead of refusing it. The
    // offline queue syncs to the server once the connection returns.
    if (isWriteBlocked()) {
      return saveOffline(state, options);
    }

    // 1. Upload local files first
    const newAttachments = await uploadService.uploadFiles(state.localFiles);
    const allAttachments = [...state.metadata.attachments, ...newAttachments];

    // 2. Update existing memo
    if (options.memoName) {
      const prevMemo = await memoServiceClient.getMemo({ name: options.memoName });
      const { mask, patch } = buildUpdateMask(prevMemo, state, allAttachments);

      if (mask.size === 0) {
        return { memoName: prevMemo.name, hasChanges: false };
      }

      const memo = await memoServiceClient.updateMemo({
        memo: create(MemoSchema, patch as Record<string, unknown>),
        updateMask: create(FieldMaskSchema, { paths: Array.from(mask) }),
      });
      return { memoName: memo.name, hasChanges: true };
    }

    // 3. Create new memo or comment
    const memoData = create(MemoSchema, {
      content: state.content,
      visibility: state.metadata.visibility,
      attachments: toAttachmentReferences(allAttachments),
      relations: state.metadata.relations,
      location: state.metadata.location,
      createTime: state.timestamps.createTime ? timestampFromDate(state.timestamps.createTime) : undefined,
      updateTime: state.timestamps.updateTime ? timestampFromDate(state.timestamps.updateTime) : undefined,
      space: options.parentMemoName ? undefined : options.space,
    });

    const memo = options.parentMemoName
      ? await memoServiceClient.createMemoComment({
          name: options.parentMemoName,
          comment: memoData,
        })
      : await memoServiceClient.createMemo({ memo: memoData });

    return { memoName: memo.name, hasChanges: true };
  },

  /**
   * Build the INIT_MEMO payload from an already-loaded Memo entity (no network
   * request). Returns only the fields the reducer's INIT_MEMO case consumes —
   * UI state (mode, loading flags, …) is owned by the reducer, not by memos.
   */
  fromMemo(memo: Memo): Pick<EditorState, "content" | "metadata" | "timestamps"> {
    return {
      content: memo.content,
      metadata: {
        visibility: memo.visibility,
        attachments: memo.attachments,
        relations: memo.relations,
        location: memo.location,
      },
      timestamps: {
        createTime: memo.createTime ? timestampDate(memo.createTime) : undefined,
        updateTime: memo.updateTime ? timestampDate(memo.updateTime) : undefined,
      },
    };
  },
};

/**
 * Saves the editor state into the local offline queue instead of the server.
 * Text-only drafts and edits of memos cached on this device can be queued; a
 * draft with files still pending upload cannot (their bytes need the
 * network), so it is refused exactly like a live save would fail.
 */
async function saveOffline(
  state: EditorState,
  options: {
    memoName?: string;
    parentMemoName?: string;
    space?: string;
  },
): Promise<{ memoName: string; hasChanges: boolean; queuedOffline?: boolean }> {
  if (state.localFiles.length > 0) {
    throw new ConnectError("You are offline. Reconnect to save this change.", Code.Unavailable);
  }
  // No upload can happen offline, so only already-uploaded attachments remain.
  const allAttachments = state.metadata.attachments;

  if (options.memoName) {
    const prevMemo =
      queryClient.getQueryData<Memo>(memoKeys.detail(options.memoName)) ?? findMemoInCollectionQueries(queryClient, options.memoName);
    if (!prevMemo) {
      throw new ConnectError("You are offline and this memo is not cached on this device, so it cannot be edited.", Code.Unavailable);
    }
    const { mask, patch } = buildUpdateMask(prevMemo, state, allAttachments);
    if (mask.size === 0) {
      return { memoName: prevMemo.name, hasChanges: false, queuedOffline: true };
    }
    await enqueueMemoUpdate({ memoName: prevMemo.name, patch: { ...patch, name: prevMemo.name }, updateMask: [...mask], base: prevMemo });
    // Show the edit immediately: the cached copy is patched in place, exactly
    // like the optimistic patch of an online update.
    const memoPatch: MemoPatch = { ...patch, name: prevMemo.name };
    queryClient.setQueryData<Memo>(memoKeys.detail(prevMemo.name), (previous) => (previous ? { ...previous, ...memoPatch } : previous));
    patchMemoInCollectionQueries(queryClient, memoPatch);
    return { memoName: prevMemo.name, hasChanges: true, queuedOffline: true };
  }

  const memoData = create(MemoSchema, {
    content: state.content,
    visibility: state.metadata.visibility,
    attachments: toAttachmentReferences(allAttachments),
    relations: state.metadata.relations,
    location: state.metadata.location,
    createTime: state.timestamps.createTime ? timestampFromDate(state.timestamps.createTime) : undefined,
    updateTime: state.timestamps.updateTime ? timestampFromDate(state.timestamps.updateTime) : undefined,
    space: options.parentMemoName ? undefined : options.space,
  });

  const entry = await enqueueMemoCreate({ memo: memoData, parentMemoName: options.parentMemoName });
  const placeholder = buildOfflinePlaceholderMemo(entry);
  queryClient.setQueryData(memoKeys.detail(placeholder.name), placeholder);
  prependMemoToCollectionQueries(queryClient, placeholder);
  return { memoName: placeholder.name, hasChanges: true, queuedOffline: true };
}
