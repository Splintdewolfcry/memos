import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SSEConnectionStatus } from "@/hooks/useLiveMemoRefresh";

const mocks = vi.hoisted(() => ({
  isOffline: false,
  currentUser: undefined as { name: string } | undefined,
  sseStatus: "disconnected" as "connected" | "connecting" | "disconnected",
}));

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ isOffline: mocks.isOffline, currentUser: mocks.currentUser }),
}));

vi.mock("@/hooks/useLiveMemoRefresh", () => ({
  useSSEConnectionStatus: (): SSEConnectionStatus => mocks.sseStatus,
}));

vi.mock("@/utils/i18n", () => ({ useTranslate: () => (key: string) => key }));

import OfflineBanner from "@/components/OfflineBanner";

const realNavigator = globalThis.navigator;

/**
 * jsdom reports `navigator.onLine === true` and the banner reads it directly, so
 * swap the global for a proxy that overrides only that property. Everything else
 * (userAgent, locks, …) still reaches the real navigator.
 */
function stubNavigatorOnLine(onLine: boolean) {
  vi.stubGlobal(
    "navigator",
    new Proxy(realNavigator, {
      get: (target, property) => (property === "onLine" ? onLine : Reflect.get(target, property, target)),
    }),
  );
}

beforeEach(() => {
  mocks.isOffline = false;
  mocks.currentUser = undefined;
  mocks.sseStatus = "disconnected";
  stubNavigatorOnLine(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OfflineBanner", () => {
  it("stays hidden for a signed-out visitor whose live connection never starts", () => {
    mocks.currentUser = undefined;
    mocks.sseStatus = "disconnected";
    stubNavigatorOnLine(true);

    render(<OfflineBanner />);

    expect(screen.queryByText("offlineBanner.title")).not.toBeInTheDocument();
  });

  it("stays hidden for a signed-in user between live-connection retries while online", () => {
    mocks.currentUser = { name: "users/steven" };
    mocks.sseStatus = "disconnected";
    stubNavigatorOnLine(true);

    render(<OfflineBanner />);

    expect(screen.queryByText("offlineBanner.title")).not.toBeInTheDocument();
  });

  it("warns a signed-in user whose live connection dropped along with connectivity", () => {
    mocks.currentUser = { name: "users/steven" };
    mocks.sseStatus = "disconnected";
    stubNavigatorOnLine(false);

    render(<OfflineBanner />);

    expect(screen.getByText("offlineBanner.title")).toBeInTheDocument();
    expect(screen.getByText("offlineBanner.description")).toBeInTheDocument();
  });

  it("warns when the session was restored from the offline cache", () => {
    mocks.isOffline = true;
    mocks.currentUser = { name: "users/steven" };
    mocks.sseStatus = "connected";
    stubNavigatorOnLine(true);

    render(<OfflineBanner />);

    expect(screen.getByText("offlineBanner.title")).toBeInTheDocument();
  });

  it("stays hidden while the live connection still reports connected", () => {
    mocks.currentUser = { name: "users/steven" };
    mocks.sseStatus = "connected";
    stubNavigatorOnLine(false);

    render(<OfflineBanner />);

    expect(screen.queryByText("offlineBanner.title")).not.toBeInTheDocument();
  });
});
