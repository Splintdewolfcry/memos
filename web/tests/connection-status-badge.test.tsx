import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isOffline: false,
  online: true,
}));

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ isOffline: mocks.isOffline }),
}));

vi.mock("@/hooks/useOnlineStatus", () => ({
  useOnlineStatus: (): boolean => mocks.online,
}));

vi.mock("@/utils/i18n", () => ({ useTranslate: () => (key: string) => key }));

import ConnectionStatusBadge from "@/components/ConnectionStatusBadge";

beforeEach(() => {
  mocks.isOffline = false;
  mocks.online = true;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ConnectionStatusBadge", () => {
  it("states Online while the browser is online and the session is live", () => {
    render(<ConnectionStatusBadge />);

    expect(screen.getByText("connectionStatus.online")).toBeInTheDocument();
    expect(screen.queryByText("connectionStatus.cached")).not.toBeInTheDocument();
  });

  it("states Cached copy while the browser reports no connectivity", () => {
    mocks.online = false;

    render(<ConnectionStatusBadge />);

    expect(screen.getByText("connectionStatus.cached")).toBeInTheDocument();
  });

  it("states Cached copy while the session was restored from the offline cache", () => {
    mocks.isOffline = true;
    mocks.online = true;

    render(<ConnectionStatusBadge />);

    expect(screen.getByText("connectionStatus.cached")).toBeInTheDocument();
  });
});
