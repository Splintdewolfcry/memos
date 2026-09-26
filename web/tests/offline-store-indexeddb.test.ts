import { afterEach, describe, expect, it, vi } from "vitest";
import { createIndexedDbStore } from "@/lib/offline-store";

// jsdom ships no IndexedDB, so the store is exercised against a minimal stub
// that lets each test fire the transaction events it cares about by hand.

interface FakeRequest {
  result?: unknown;
  onsuccess?: () => void;
  onerror?: () => void;
}

interface FakeTransaction {
  error: unknown;
  oncomplete?: () => void;
  onabort?: () => void;
  onerror?: () => void;
  objectStore: () => Record<string, () => FakeRequest>;
}

function installFakeIndexedDb() {
  const close = vi.fn();
  const opRequest: FakeRequest = {};
  const transaction: FakeTransaction = {
    error: null,
    objectStore: () => ({
      put: () => opRequest,
      get: () => opRequest,
      delete: () => opRequest,
      getAllKeys: () => opRequest,
      clear: () => opRequest,
    }),
  };
  const database = { close, transaction: () => transaction };
  const openRequest: FakeRequest & { onupgradeneeded?: () => void } = { result: database };
  vi.stubGlobal("indexedDB", {
    open: () => {
      // Fire asynchronously so run() has attached its handlers first.
      queueMicrotask(() => openRequest.onsuccess?.());
      return openRequest;
    },
  });
  // Let the open microtask and the transaction setup that follows it run.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { close, transaction, opRequest, settle };
}

describe("createIndexedDbStore transaction handling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves and closes the connection when the transaction completes", async () => {
    const fake = installFakeIndexedDb();
    const store = createIndexedDbStore("test-db");

    const pending = store.set("key", { value: 1 });
    await fake.settle();
    fake.opRequest.onsuccess?.();
    fake.transaction.oncomplete?.();

    await expect(pending).resolves.toBeUndefined();
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it("rejects and closes the connection when the transaction aborts", async () => {
    const fake = installFakeIndexedDb();
    const store = createIndexedDbStore("test-db");
    const quotaError = new DOMException("QuotaExceededError", "QuotaExceededError");
    fake.transaction.error = quotaError;

    const pending = store.set("key", { value: 1 });
    await fake.settle();
    // An aborted transaction never fires oncomplete; the onabort handler must
    // both reject the write and close the connection, or it leaks.
    fake.transaction.onabort?.();

    await expect(pending).rejects.toBe(quotaError);
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it("rejects and closes the connection on a transaction error event", async () => {
    const fake = installFakeIndexedDb();
    const store = createIndexedDbStore("test-db");
    const writeError = new DOMException("WriteError", "UnknownError");
    fake.transaction.error = writeError;

    const pending = store.set("key", { value: 1 });
    await fake.settle();
    fake.transaction.onerror?.();

    await expect(pending).rejects.toBe(writeError);
    expect(fake.close).toHaveBeenCalledOnce();
  });
});
