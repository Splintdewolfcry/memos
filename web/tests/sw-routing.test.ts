import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_CACHE_CAP_BYTES,
  isAttachmentPath,
  isBypassedPath,
  isCacheableAttachmentResponse,
  isImmutableAssetPath,
  selectEvictions,
  // @ts-expect-error -- plain .mjs module shared with the service worker
} from "../scripts/sw-routing.mjs";

describe("service worker routing", () => {
  it("never intercepts API, RPC or streaming routes", () => {
    for (const path of ["/api/v1/memos", "/api/v1/sse", "/memos.api.v1.MemoService/ListMemos", "/memos.api.v1"]) {
      expect(isBypassedPath(path), path).toBe(true);
    }
  });

  it("does not bypass attachments, which this worker caches", () => {
    expect(isBypassedPath("/file/attachments/abc")).toBe(false);
    expect(isAttachmentPath("/file/attachments/abc")).toBe(true);
    expect(isAttachmentPath("/file/users/1/avatar")).toBe(true);
    expect(isAttachmentPath("/assets/index-abc123.js")).toBe(false);
  });

  it("stores only full attachment responses", () => {
    expect(isCacheableAttachmentResponse("GET", false, 200)).toBe(true);
    // 206 cannot be stored by the Cache API at all.
    expect(isCacheableAttachmentResponse("GET", false, 206)).toBe(false);
    // A ranged request must pass through even if the server answered 200.
    expect(isCacheableAttachmentResponse("GET", true, 200)).toBe(false);
    expect(isCacheableAttachmentResponse("POST", false, 200)).toBe(false);
  });

  it("treats hashed build output as immutable", () => {
    expect(isImmutableAssetPath("/assets/index-abc123.js")).toBe(true);
    expect(isImmutableAssetPath("/logo.webp")).toBe(false);
  });

  it("evicts oldest first until under the cap", () => {
    const cap = ATTACHMENT_CACHE_CAP_BYTES;
    const entries = [
      { url: "/file/attachments/old", size: cap },
      { url: "/file/attachments/new", size: 1024 },
    ];

    expect(selectEvictions(entries, cap)).toEqual(["/file/attachments/old"]);
  });

  it("evicts nothing when under the cap", () => {
    expect(selectEvictions([{ url: "/file/attachments/a", size: 1024 }], ATTACHMENT_CACHE_CAP_BYTES)).toEqual([]);
  });
});
