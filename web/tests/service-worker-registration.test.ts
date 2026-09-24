import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerOfflineWorker } from "@/lib/service-worker-registration";

const register = vi.fn();

beforeEach(() => {
  register.mockReset();
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
