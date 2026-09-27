import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useOnlineStatus } from "@/hooks/useOnlineStatus";

// jsdom's navigator.onLine stays true unless stubbed; the hook's snapshot must
// follow the online/offline events it subscribes to.
const realNavigator = globalThis.navigator;
let onLine = true;

beforeEach(() => {
  onLine = true;
  vi.stubGlobal(
    "navigator",
    new Proxy(realNavigator, {
      get: (target, property) => (property === "onLine" ? onLine : Reflect.get(target, property, target)),
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useOnlineStatus", () => {
  it("flips when the browser fires online/offline events", () => {
    const { result } = renderHook(() => useOnlineStatus());
    expect(result.current).toBe(true);

    onLine = false;
    act(() => window.dispatchEvent(new Event("offline")));
    expect(result.current).toBe(false);

    onLine = true;
    act(() => window.dispatchEvent(new Event("online")));
    expect(result.current).toBe(true);
  });
});
