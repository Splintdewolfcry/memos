import { describe, expect, it } from "vitest";
import { createMemoryStore, isOfflineStoreAvailable } from "@/lib/offline-store";

describe("offline store", () => {
  it("round-trips a value by key", async () => {
    const store = createMemoryStore();

    await store.set("a", { memos: [1, 2] });

    expect(await store.get("a")).toEqual({ memos: [1, 2] });
  });

  it("returns undefined for a missing key", async () => {
    const store = createMemoryStore();

    expect(await store.get("nope")).toBeUndefined();
  });

  it("removes a single key and lists the rest", async () => {
    const store = createMemoryStore();
    await store.set("a", 1);
    await store.set("b", 2);

    await store.remove("a");

    expect(await store.keys()).toEqual(["b"]);
  });

  it("clears everything", async () => {
    const store = createMemoryStore();
    await store.set("a", 1);

    await store.clear();

    expect(await store.keys()).toEqual([]);
  });

  it("reports availability without throwing when IndexedDB is absent", () => {
    expect(typeof isOfflineStoreAvailable()).toBe("boolean");
  });
});
