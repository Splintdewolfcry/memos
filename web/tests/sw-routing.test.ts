import { describe, expect, it, vi } from "vitest";
import {
  ATTACHMENT_CACHE_CAP_BYTES,
  enforceAttachmentCap,
  handleAsset,
  handleAttachment,
  handleNavigation,
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

const SHELL = "memos-shell-test";
const ATTACHMENTS = "memos-attachments-test";

interface FakeResponse {
  ok: boolean;
  status: number;
  headers: { get: (name: string) => string | null };
  clone: () => FakeResponse;
  blob: () => never;
}

/**
 * The handlers read only status/ok/headers/clone, so a plain object is enough.
 * `blob` throwing is the assertion: eviction must size entries from headers
 * instead of materializing every cached body.
 */
function fakeResponse(status: number, contentLength?: number): FakeResponse {
  const response: FakeResponse = {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => (name.toLowerCase() === "content-length" && contentLength !== undefined ? String(contentLength) : null),
    },
    clone: () => response,
    blob: () => {
      throw new Error("the eviction sweep must not read bodies");
    },
  };
  return response;
}

/** Hand-rolled Cache Storage fake: jsdom has none, and the handlers use only
 * open/match/put/keys/delete. */
function createFakeCaches(options: { sweepGate?: Promise<void> } = {}) {
  const stores = new Map<string, Map<string, FakeResponse>>();
  const deleted: string[] = [];
  let quotaFailures = 0;
  let sweeps = 0;
  let activeSweeps = 0;
  let maxActiveSweeps = 0;

  const urlOf = (request: Request | string) => (typeof request === "string" ? request : request.url);
  const storeFor = (name: string) => {
    let store = stores.get(name);
    if (!store) {
      store = new Map();
      stores.set(name, store);
    }
    return store;
  };

  const cacheStorage = {
    async open(name: string) {
      const entries = storeFor(name);
      return {
        async put(request: Request | string, response: FakeResponse) {
          if (quotaFailures > 0) {
            quotaFailures -= 1;
            // What a full device does: the write is refused, the response is fine.
            throw new Error("QuotaExceededError");
          }
          entries.set(urlOf(request), response);
        },
        async match(request: Request | string) {
          return entries.get(urlOf(request));
        },
        async keys() {
          sweeps += 1;
          activeSweeps += 1;
          maxActiveSweeps = Math.max(maxActiveSweeps, activeSweeps);
          if (options.sweepGate) await options.sweepGate;
          activeSweeps -= 1;
          return [...entries.keys()].map((url) => ({ url }));
        },
        async delete(request: Request | string) {
          const url = urlOf(request);
          deleted.push(url);
          return entries.delete(url);
        },
      };
    },
    async match(request: Request | string, matchOptions?: { cacheName?: string }) {
      const url = urlOf(request);
      if (matchOptions?.cacheName) return stores.get(matchOptions.cacheName)?.get(url);
      for (const entries of stores.values()) {
        const hit = entries.get(url);
        if (hit) return hit;
      }
      return undefined;
    },
  };

  return {
    cacheStorage,
    deleted,
    /** Refuse the next `count` puts, as a full device would. */
    failPuts(count: number) {
      quotaFailures = count;
    },
    async seed(cacheName: string, request: Request | string, response: FakeResponse) {
      const cache = await cacheStorage.open(cacheName);
      await cache.put(request, response);
    },
    stored(cacheName: string, request: Request | string) {
      return stores.get(cacheName)?.get(urlOf(request));
    },
    get sweeps() {
      return sweeps;
    },
    get maxActiveSweeps() {
      return maxActiveSweeps;
    },
  };
}

function depsFor(fake: ReturnType<typeof createFakeCaches>, fetchFn: (request: Request) => Promise<unknown>) {
  return { fetch: fetchFn, caches: fake.cacheStorage, shellCache: SHELL, attachmentCache: ATTACHMENTS };
}

const navigation = () => new Request("http://localhost/");
const offline = async () => {
  throw new Error("offline");
};

/** The handlers write to cache without awaiting; drain those chains. */
async function flush(rounds = 4) {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("worker navigation handler", () => {
  it("stores an OK response as the offline shell", async () => {
    const fake = createFakeCaches();
    const fetched = fakeResponse(200);

    const response = await handleNavigation(navigation(), depsFor(fake, async () => fetched));
    await flush();

    expect(response).toBe(fetched);
    expect(fake.stored(SHELL, "/index.html")).toBe(fetched);
  });

  it("never caches a non-OK response over the precached shell", async () => {
    // A 502 during a deploy restart, or a CDN challenge page, must not become the
    // document every later offline cold load renders.
    const fake = createFakeCaches();
    const fetched = fakeResponse(502);

    const response = await handleNavigation(navigation(), depsFor(fake, async () => fetched));
    await flush();

    expect(response).toBe(fetched);
    expect(fake.stored(SHELL, "/index.html")).toBeUndefined();
  });

  it("falls back to the cached shell when the network fails", async () => {
    const fake = createFakeCaches();
    const shell = fakeResponse(200);
    await fake.seed(SHELL, "/index.html", shell);

    const response = await handleNavigation(navigation(), depsFor(fake, offline));

    expect(response).toBe(shell);
  });

  it("returns a network error only when the network and the cache both miss", async () => {
    const fake = createFakeCaches();

    const response = await handleNavigation(navigation(), depsFor(fake, offline));

    expect(response.type).toBe("error");
  });

  it("still returns the fetched response when storing it is refused", async () => {
    const fake = createFakeCaches();
    fake.failPuts(1);
    const fetched = fakeResponse(200);

    const response = await handleNavigation(navigation(), depsFor(fake, async () => fetched));

    expect(response).toBe(fetched);
  });
});

describe("worker asset handler", () => {
  it("serves an immutable asset from the shell cache without fetching", async () => {
    const fake = createFakeCaches();
    const request = new Request("http://localhost/assets/index-abc123.js");
    const cached = fakeResponse(200);
    await fake.seed(SHELL, request, cached);
    const fetchFn = vi.fn(async () => fakeResponse(200));

    const response = await handleAsset(request, "/assets/index-abc123.js", depsFor(fake, fetchFn));

    expect(response).toBe(cached);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rethrows the network error when an uncached asset cannot be fetched", async () => {
    const fake = createFakeCaches();

    await expect(handleAsset(new Request("http://localhost/logo.webp"), "/logo.webp", depsFor(fake, offline))).rejects.toThrow("offline");
  });

  it("still returns the fetched asset when storing it is refused", async () => {
    const fake = createFakeCaches();
    fake.failPuts(1);
    const fetched = fakeResponse(200);

    const response = await handleAsset(new Request("http://localhost/logo.webp"), "/logo.webp", depsFor(fake, async () => fetched));

    expect(response).toBe(fetched);
  });
});

describe("worker attachment handler", () => {
  it("stores a full 200 response and returns it", async () => {
    const fake = createFakeCaches();
    const request = new Request("http://localhost/file/attachments/abc");
    const fetched = fakeResponse(200, 2048);

    const response = await handleAttachment(request, depsFor(fake, async () => fetched));
    await flush();

    expect(response).toBe(fetched);
    expect(fake.stored(ATTACHMENTS, request)).toBe(fetched);
  });

  it("returns the fetched response when the put is refused, and does not evict", async () => {
    const fake = createFakeCaches();
    await fake.seed(ATTACHMENTS, new Request("http://localhost/file/attachments/old"), fakeResponse(200, 10));
    fake.failPuts(1);
    const fetched = fakeResponse(200, 1024);

    const response = await handleAttachment(new Request("http://localhost/file/attachments/new"), depsFor(fake, async () => fetched));
    await flush();

    expect(response).toBe(fetched);
    // Eviction follows a put that succeeded; after a refusal the cache is
    // untouched rather than trimmed on a write that never landed.
    expect(fake.sweeps).toBe(0);
    expect(fake.deleted).toEqual([]);
  });

  it("serves a cached attachment when the network fails", async () => {
    const fake = createFakeCaches();
    const request = new Request("http://localhost/file/attachments/abc");
    const cached = fakeResponse(200, 2048);
    await fake.seed(ATTACHMENTS, request, cached);

    const response = await handleAttachment(request, depsFor(fake, offline));

    expect(response).toBe(cached);
  });

  it("returns a network error only when the network and the cache both miss", async () => {
    const fake = createFakeCaches();

    const response = await handleAttachment(new Request("http://localhost/file/attachments/abc"), depsFor(fake, offline));

    expect(response.type).toBe("error");
  });

  it("evicts the oldest entry by content-length without reading bodies", async () => {
    const fake = createFakeCaches();
    const oldest = new Request("http://localhost/file/attachments/oldest");
    const newest = new Request("http://localhost/file/attachments/newest");
    await fake.seed(ATTACHMENTS, oldest, fakeResponse(200, 600));
    await fake.seed(ATTACHMENTS, newest, fakeResponse(200, 600));
    const cache = await fake.cacheStorage.open(ATTACHMENTS);

    await enforceAttachmentCap(cache, { attachmentCapBytes: 1000 });

    expect(fake.deleted).toEqual([oldest.url]);
    expect(fake.stored(ATTACHMENTS, newest)).toBeDefined();
  });

  it("runs one eviction sweep at a time", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = createFakeCaches({ sweepGate: gate });
    const fetchFn = async () => fakeResponse(200, 10);

    await Promise.all([
      handleAttachment(new Request("http://localhost/file/attachments/a"), depsFor(fake, fetchFn)),
      handleAttachment(new Request("http://localhost/file/attachments/b"), depsFor(fake, fetchFn)),
    ]);
    await flush();

    // The second load queued behind the first instead of starting its own sweep.
    expect(fake.sweeps).toBe(1);

    release();
    await flush();

    expect(fake.sweeps).toBe(2);
    expect(fake.maxActiveSweeps).toBe(1);
  });
});
