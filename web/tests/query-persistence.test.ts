import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryStore } from "@/lib/offline-store";
import {
  isPersistableQueryKey,
  PERSISTED_CACHE_MAX_AGE_MS,
  persistedCacheKey,
  removeAllQueryCaches,
  removeQueryCache,
  restoreQueryCache,
  saveQueryCache,
} from "@/lib/query-persistence";

let store: ReturnType<typeof createMemoryStore>;

beforeEach(() => {
  store = createMemoryStore();
});

describe("query key allowlist", () => {
  it("accepts the content roots and rejects everything else", () => {
    expect(isPersistableQueryKey(["memos", "list"])).toBe(true);
    expect(isPersistableQueryKey(["memos", "detail", "memos/1"])).toBe(true);
    expect(isPersistableQueryKey(["spaces", "list"])).toBe(true);
    expect(isPersistableQueryKey(["attachments", "list"])).toBe(true);
    expect(isPersistableQueryKey(["users", "current"])).toBe(true);
    expect(isPersistableQueryKey(["instance", "profile"])).toBe(true);
    // Default-deny: an unknown root must not be written to disk.
    expect(isPersistableQueryKey(["somethingNew"])).toBe(false);
    expect(isPersistableQueryKey([])).toBe(false);
  });
});

describe("per-user scoping", () => {
  it("uses a distinct key per user", () => {
    expect(persistedCacheKey("users/1")).not.toBe(persistedCacheKey("users/2"));
  });

  it("does not leak one user's cache into another's restore", async () => {
    const writer = new QueryClient();
    writer.setQueryData(["memos", "detail", "memos/1"], { name: "memos/1", content: "alice secret" });
    await saveQueryCache(writer, store, "users/1");

    const reader = new QueryClient();
    const restored = await restoreQueryCache(reader, store, "users/2");

    expect(restored).toBe(false);
    expect(reader.getQueryData(["memos", "detail", "memos/1"])).toBeUndefined();
  });

  it("removes only the named user's cache", async () => {
    const client = new QueryClient();
    client.setQueryData(["memos", "detail", "memos/1"], { name: "memos/1" });
    await saveQueryCache(client, store, "users/1");
    await saveQueryCache(client, store, "users/2");

    await removeQueryCache(store, "users/1");

    expect(await store.keys()).toEqual([persistedCacheKey("users/2")]);
  });

  it("removes every cache on logout", async () => {
    const client = new QueryClient();
    client.setQueryData(["memos", "detail", "memos/1"], { name: "memos/1" });
    await saveQueryCache(client, store, "users/1");

    await removeAllQueryCaches(store);

    expect(await store.keys()).toEqual([]);
  });
});

describe("round trip", () => {
  it("restores persisted memo data into a fresh client", async () => {
    const writer = new QueryClient();
    writer.setQueryData(["memos", "detail", "memos/1"], { name: "memos/1", content: "hello" });
    await saveQueryCache(writer, store, "users/1");

    const reader = new QueryClient();
    const restored = await restoreQueryCache(reader, store, "users/1");

    expect(restored).toBe(true);
    expect(reader.getQueryData(["memos", "detail", "memos/1"])).toEqual({ name: "memos/1", content: "hello" });
  });

  it("drops non-allowlisted queries", async () => {
    const writer = new QueryClient();
    writer.setQueryData(["memos", "detail", "memos/1"], { name: "memos/1" });
    writer.setQueryData(["somethingNew", "x"], { secret: true });
    await saveQueryCache(writer, store, "users/1");

    const reader = new QueryClient();
    await restoreQueryCache(reader, store, "users/1");

    expect(reader.getQueryData(["memos", "detail", "memos/1"])).toBeDefined();
    expect(reader.getQueryData(["somethingNew", "x"])).toBeUndefined();
  });

  it("marks restored queries stale so online always wins", async () => {
    const writer = new QueryClient();
    writer.setQueryData(["memos", "detail", "memos/1"], { name: "memos/1" });
    await saveQueryCache(writer, store, "users/1");

    const reader = new QueryClient();
    await restoreQueryCache(reader, store, "users/1");

    const state = reader.getQueryState(["memos", "detail", "memos/1"]);
    expect(state?.isInvalidated).toBe(true);
  });

  it("refuses a cache older than the maximum age", async () => {
    const writer = new QueryClient();
    writer.setQueryData(["memos", "detail", "memos/1"], { name: "memos/1" });
    await saveQueryCache(writer, store, "users/1");

    const aged = (await store.get<{ savedAt: number }>(persistedCacheKey("users/1"))) as { savedAt: number };
    await store.set(persistedCacheKey("users/1"), { ...aged, savedAt: aged.savedAt - PERSISTED_CACHE_MAX_AGE_MS - 1 });

    const reader = new QueryClient();
    expect(await restoreQueryCache(reader, store, "users/1")).toBe(false);
  });

  it("survives a store that throws instead of breaking the app", async () => {
    const broken = {
      ...store,
      get: async () => {
        throw new Error("QuotaExceededError");
      },
    };
    const reader = new QueryClient();

    await expect(restoreQueryCache(reader, broken, "users/1")).resolves.toBe(false);
  });

  it("retains cached data after a failed refetch", async () => {
    const writer = new QueryClient();
    writer.setQueryData(["memos", "detail", "memos/1"], { name: "memos/1", content: "offline memo" });
    await saveQueryCache(writer, store, "users/1");

    const reader = new QueryClient();
    await restoreQueryCache(reader, store, "users/1");

    // Simulate offline refetch failure: status becomes "error" but data is retained.
    await reader
      .fetchQuery({
        queryKey: ["memos", "detail", "memos/1"],
        queryFn: () => {
          throw new Error("Network error");
        },
      })
      .catch(() => {});
    expect(reader.getQueryData(["memos", "detail", "memos/1"])).toEqual({ name: "memos/1", content: "offline memo" });

    await saveQueryCache(reader, store, "users/1");

    const third = new QueryClient();
    const restored = await restoreQueryCache(third, store, "users/1");
    expect(restored).toBe(true);
    expect(third.getQueryData(["memos", "detail", "memos/1"])).toEqual({ name: "memos/1", content: "offline memo" });
  });

  it("does not overwrite a good cache with an empty dehydration", async () => {
    const writer = new QueryClient();
    writer.setQueryData(["memos", "detail", "memos/1"], { name: "memos/1" });
    await saveQueryCache(writer, store, "users/1");

    const empty = new QueryClient();
    await saveQueryCache(empty, store, "users/1");

    const reader = new QueryClient();
    const restored = await restoreQueryCache(reader, store, "users/1");
    expect(restored).toBe(true);
    expect(reader.getQueryData(["memos", "detail", "memos/1"])).toEqual({ name: "memos/1" });
  });

  it("returns false when the persisted entry has no queries", async () => {
    await store.set(persistedCacheKey("users/1"), {
      savedAt: Date.now(),
      state: { mutations: [], queries: [] },
    });

    const reader = new QueryClient();
    expect(await restoreQueryCache(reader, store, "users/1")).toBe(false);
  });
});
