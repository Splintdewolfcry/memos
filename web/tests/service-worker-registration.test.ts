import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerOfflineWorker,
  restorePersistedQueries,
  scheduleWorkerRegistration,
  startQueryCachePersistence,
} from "@/lib/service-worker-registration";

const register = vi.fn();

vi.mock("@/lib/offline-store-instance", () => ({
  offlineStore: {
    get: vi.fn(),
    set: vi.fn(),
    remove: vi.fn(),
    keys: vi.fn(),
    clear: vi.fn(),
  },
}));

const hasStoredTokenMock = vi.fn();
vi.mock("@/auth-state", () => ({
  hasStoredToken: () => hasStoredTokenMock(),
}));

vi.mock("@/lib/offline-session", () => ({
  getStoredOfflineUserName: () => "users/test",
}));

const restoreQueryCacheMock = vi.fn();
vi.mock("@/lib/query-persistence", () => ({
  restoreQueryCache: (...args: unknown[]) => restoreQueryCacheMock(...args),
  saveQueryCache: vi.fn(),
}));

vi.mock("@/lib/query-client", () => ({
  queryClient: {},
}));

beforeEach(() => {
  register.mockReset();
  hasStoredTokenMock.mockReset();
  restoreQueryCacheMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("registerOfflineWorker", () => {
  it("registers sw.js in a secure context", async () => {
    vi.stubGlobal("navigator", { serviceWorker: { register }, storage: { persist: vi.fn(async () => true) } });
    vi.stubGlobal("window", { ...window, isSecureContext: true, addEventListener: vi.fn() });

    await registerOfflineWorker();

    expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/" });
  });

  it("does nothing when service workers are unsupported", async () => {
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("window", { ...window, isSecureContext: true });

    await expect(registerOfflineWorker()).resolves.toBeUndefined();
    expect(register).not.toHaveBeenCalled();
  });

  it("does nothing over plain HTTP", async () => {
    vi.stubGlobal("navigator", { serviceWorker: { register } });
    vi.stubGlobal("window", { ...window, isSecureContext: false });

    await registerOfflineWorker();

    expect(register).not.toHaveBeenCalled();
  });

  it("requests persistent storage so Android does not evict silently", async () => {
    const persist = vi.fn(async () => true);
    vi.stubGlobal("navigator", { serviceWorker: { register }, storage: { persist, estimate: vi.fn() } });
    vi.stubGlobal("window", { ...window, isSecureContext: true, addEventListener: vi.fn() });

    await registerOfflineWorker();

    expect(persist).toHaveBeenCalled();
  });

  it("swallows a failed registration instead of breaking boot", async () => {
    register.mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { serviceWorker: { register }, storage: { persist: vi.fn(async () => true) } });
    vi.stubGlobal("window", { ...window, isSecureContext: true, addEventListener: vi.fn() });

    await expect(registerOfflineWorker()).resolves.toBeUndefined();
  });
});

describe("restorePersistedQueries", () => {
  it("returns false when store is unavailable", async () => {
    // Override the mock to simulate unavailable store
    vi.resetModules();
    vi.doMock("@/lib/offline-store-instance", () => ({ offlineStore: undefined }));
    const { restorePersistedQueries: restore } = await import("@/lib/service-worker-registration");

    const result = await restore();

    expect(result).toBe(false);
    expect(restoreQueryCacheMock).not.toHaveBeenCalled();
  });

  it("returns false when no stored token exists", async () => {
    hasStoredTokenMock.mockReturnValue(false);

    const result = await restorePersistedQueries();

    expect(result).toBe(false);
    expect(restoreQueryCacheMock).not.toHaveBeenCalled();
  });

  it("returns the restoreQueryCache boolean when available and token exists", async () => {
    hasStoredTokenMock.mockReturnValue(true);
    restoreQueryCacheMock.mockResolvedValue(true);

    const result = await restorePersistedQueries();

    expect(result).toBe(true);
    expect(restoreQueryCacheMock).toHaveBeenCalled();
  });
});

describe("startQueryCachePersistence", () => {
  it("stop function clears the interval and removes both event listeners", () => {
    vi.useFakeTimers();
    const addEventListenerSpy = vi.spyOn(window, "addEventListener");
    const removeEventListenerSpy = vi.spyOn(window, "removeEventListener");
    const docAddEventListenerSpy = vi.spyOn(document, "addEventListener");
    const docRemoveEventListenerSpy = vi.spyOn(document, "removeEventListener");
    const clearIntervalSpy = vi.spyOn(window, "clearInterval");

    const stop = startQueryCachePersistence("users/test");

    // Verify listeners were added
    expect(addEventListenerSpy).toHaveBeenCalledWith("pagehide", expect.any(Function));
    expect(docAddEventListenerSpy).toHaveBeenCalledWith("visibilitychange", expect.any(Function));

    stop();

    // Verify cleanup
    expect(clearIntervalSpy).toHaveBeenCalled();
    expect(removeEventListenerSpy).toHaveBeenCalledWith("pagehide", expect.any(Function));
    expect(docRemoveEventListenerSpy).toHaveBeenCalledWith("visibilitychange", expect.any(Function));

    vi.useRealTimers();
    addEventListenerSpy.mockRestore();
    removeEventListenerSpy.mockRestore();
    docAddEventListenerSpy.mockRestore();
    docRemoveEventListenerSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });
});

describe("scheduleWorkerRegistration", () => {
  it("registers immediately when readyState is complete", async () => {
    vi.stubGlobal("navigator", { serviceWorker: { register }, storage: { persist: vi.fn(async () => true) } });
    vi.stubGlobal("window", { ...window, isSecureContext: true, addEventListener: vi.fn() });
    Object.defineProperty(document, "readyState", { value: "complete", writable: true });

    scheduleWorkerRegistration();

    // Give the async register time to complete
    await vi.waitFor(() => expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/" }));
  });

  it("registers only after load event when readyState is not complete", async () => {
    vi.stubGlobal("navigator", { serviceWorker: { register }, storage: { persist: vi.fn(async () => true) } });
    const addEventListener = vi.fn();
    vi.stubGlobal("window", { ...window, isSecureContext: true, addEventListener });
    Object.defineProperty(document, "readyState", { value: "loading", writable: true });

    scheduleWorkerRegistration();

    // Should not register immediately
    expect(register).not.toHaveBeenCalled();
    // Should add a load listener
    expect(addEventListener).toHaveBeenCalledWith("load", expect.any(Function));

    // Simulate load event
    const loadCallback = addEventListener.mock.calls[0][1];
    loadCallback();

    await vi.waitFor(() => expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/" }));
  });
});
