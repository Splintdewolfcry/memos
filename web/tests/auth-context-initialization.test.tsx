import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveOfflineSession } from "@/lib/offline-session";
import { UserSchema } from "@/types/proto/api/v1/user_service_pb";

const authState = vi.hoisted(() => ({ hasToken: false, hasStored: false }));
const clients = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  listUserSettings: vi.fn(),
}));

vi.mock("@/auth-state", () => ({
  clearAccessToken: vi.fn(),
  getAccessToken: () => (authState.hasToken ? "token" : undefined),
  hasStoredToken: () => authState.hasStored || authState.hasToken,
}));

vi.mock("@/connect", () => ({
  authServiceClient: {
    getCurrentUser: clients.getCurrentUser,
    signOut: vi.fn(),
  },
  refreshAccessToken: vi.fn(async () => undefined),
  userServiceClient: {
    listUserSettings: clients.listUserSettings,
  },
}));

import { clearAccessToken } from "@/auth-state";
import { refreshAccessToken } from "@/connect";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";

const unavailable = () => new ConnectError("fetch failed", Code.Unavailable);
const unauthenticated = () => new ConnectError("invalid token", Code.Unauthenticated);
const unknownError = () => new ConnectError("fetch failed", Code.Unknown);

const Probe = () => {
  const { currentUser, initialize, logout, isInitialized, isUserSettingsInitialized, isOffline } = useAuth();
  return (
    <div>
      <span data-testid="initialized">{isInitialized ? "yes" : "no"}</span>
      <span data-testid="user-settings-initialized">{isUserSettingsInitialized ? "yes" : "no"}</span>
      <span data-testid="offline">{isOffline ? "yes" : "no"}</span>
      <span data-testid="user">{currentUser?.name ?? "none"}</span>
      <button type="button" onClick={() => void initialize()}>
        initialize
      </button>
      <button type="button" onClick={() => void logout()}>
        logout
      </button>
    </div>
  );
};

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <AuthProvider>{children}</AuthProvider>
  </QueryClientProvider>
);

describe("AuthProvider initialization", () => {
  beforeEach(() => {
    authState.hasToken = false;
    authState.hasStored = false;
    clients.getCurrentUser.mockReset();
    clients.listUserSettings.mockReset();
  });

  it("resets full readiness while post-sign-in settings are pending", async () => {
    let resolveSettings!: (value: { settings: [] }) => void;
    clients.getCurrentUser.mockResolvedValue({ user: { name: "users/alice", username: "alice" } });
    clients.listUserSettings.mockImplementation(() => new Promise<{ settings: [] }>((resolve) => (resolveSettings = resolve)));

    render(<Probe />, { wrapper });

    // Settle the initial unauthenticated pass; this reproduces the state from
    // which PasswordSignInForm and AuthCallback invoke initialize again.
    fireEvent.click(screen.getByRole("button", { name: "initialize" }));
    await waitFor(() => expect(screen.getByTestId("initialized")).toHaveTextContent("yes"));

    authState.hasToken = true;
    fireEvent.click(screen.getByRole("button", { name: "initialize" }));
    await waitFor(() => expect(screen.getByTestId("user")).toHaveTextContent("users/alice"));
    expect(screen.getByTestId("initialized")).toHaveTextContent("no");
    expect(screen.getByTestId("user-settings-initialized")).toHaveTextContent("no");

    resolveSettings({ settings: [] });
    await waitFor(() => expect(screen.getByTestId("user-settings-initialized")).toHaveTextContent("yes"));
    expect(screen.getByTestId("initialized")).toHaveTextContent("yes");
  });
});

describe("offline initialization", () => {
  beforeEach(() => {
    authState.hasToken = true;
    authState.hasStored = false;
    clients.getCurrentUser.mockReset();
    clients.listUserSettings.mockReset();
    localStorage.clear();
  });

  it("keeps the access token when getCurrentUser fails on the network", async () => {
    clients.getCurrentUser.mockRejectedValue(unavailable());

    render(<Probe />, { wrapper });
    fireEvent.click(screen.getByText("initialize"));
    await waitFor(() => expect(screen.getByTestId("initialized")).toHaveTextContent("yes"));

    expect(clearAccessToken).not.toHaveBeenCalled();
  });

  it("restores the persisted identity and unblocks memo display offline", async () => {
    saveOfflineSession(create(UserSchema, { name: "users/1", username: "alice" }), {});
    clients.getCurrentUser.mockRejectedValue(unavailable());

    render(<Probe />, { wrapper });
    fireEvent.click(screen.getByText("initialize"));

    await waitFor(() => expect(screen.getByTestId("user")).toHaveTextContent("users/1"));
    expect(screen.getByTestId("user-settings-initialized")).toHaveTextContent("yes");
    expect(screen.getByTestId("offline")).toHaveTextContent("yes");
  });

  it("still logs out when the server rejects the credential", async () => {
    saveOfflineSession(create(UserSchema, { name: "users/1", username: "alice" }), {});
    clients.getCurrentUser.mockRejectedValue(unauthenticated());

    render(<Probe />, { wrapper });
    fireEvent.click(screen.getByText("initialize"));

    await waitFor(() => expect(clearAccessToken).toHaveBeenCalled());
    expect(screen.getByTestId("user")).toHaveTextContent("none");
  });

  it("restores when the stored token is expired and refresh cannot reach the network", async () => {
    // The reported failure: overnight on a dead connection. getAccessToken() is
    // null because the token expired, so the early-return path must not win.
    authState.hasToken = false;
    authState.hasStored = true;
    saveOfflineSession(create(UserSchema, { name: "users/1", username: "alice" }), {});
    clients.getCurrentUser.mockRejectedValue(unavailable());
    (refreshAccessToken as ReturnType<typeof vi.fn>).mockRejectedValueOnce(unavailable());

    render(<Probe />, { wrapper });
    fireEvent.click(screen.getByText("initialize"));

    await waitFor(() => expect(screen.getByTestId("user")).toHaveTextContent("users/1"));
    expect(clearAccessToken).not.toHaveBeenCalled();
  });

  it("preserves the session and restores offline when refresh fails with Code.Unknown", async () => {
    // Connect 2.x wraps browser fetch-level failures as Code.Unknown, not
    // Code.Unavailable. This is the realistic dead-connection error.
    authState.hasToken = false;
    authState.hasStored = true;
    saveOfflineSession(create(UserSchema, { name: "users/1", username: "alice" }), {});
    clients.getCurrentUser.mockRejectedValue(unknownError());
    (refreshAccessToken as ReturnType<typeof vi.fn>).mockRejectedValueOnce(unknownError());

    render(<Probe />, { wrapper });
    fireEvent.click(screen.getByText("initialize"));

    await waitFor(() => expect(screen.getByTestId("user")).toHaveTextContent("users/1"));
    expect(screen.getByTestId("offline")).toHaveTextContent("yes");
    expect(clearAccessToken).not.toHaveBeenCalled();
  });

  it("clears token and offline session when refresh fails with Code.Unauthenticated", async () => {
    authState.hasToken = false;
    authState.hasStored = true;
    saveOfflineSession(create(UserSchema, { name: "users/1", username: "alice" }), {});
    (refreshAccessToken as ReturnType<typeof vi.fn>).mockRejectedValueOnce(unauthenticated());

    render(<Probe />, { wrapper });
    fireEvent.click(screen.getByText("initialize"));

    await waitFor(() => expect(clearAccessToken).toHaveBeenCalled());
    expect(screen.getByTestId("user")).toHaveTextContent("none");
    const { loadOfflineSession } = await import("@/lib/offline-session");
    expect(loadOfflineSession("users/1")).toBeUndefined();
  });

  it("drops a stale offline entry when getCurrentUser succeeds for a different user", async () => {
    // User A saved an entry and closed the tab. User B signs in; B's
    // getCurrentUser succeeds. The stale entry for A must be cleared so B
    // cannot see A's identity or tag settings if B's settings fetch later fails.
    saveOfflineSession(create(UserSchema, { name: "users/A", username: "alice" }), {});
    clients.getCurrentUser.mockResolvedValue({ user: create(UserSchema, { name: "users/B", username: "bob" }) });
    clients.listUserSettings.mockResolvedValue({ settings: [] });

    render(<Probe />, { wrapper });
    fireEvent.click(screen.getByText("initialize"));

    await waitFor(() => expect(screen.getByTestId("user")).toHaveTextContent("users/B"));
    const { loadOfflineSession } = await import("@/lib/offline-session");
    expect(loadOfflineSession("users/A")).toBeUndefined();
  });

  it("drops the persisted session on logout", async () => {
    saveOfflineSession(create(UserSchema, { name: "users/1", username: "alice" }), {});
    clients.getCurrentUser.mockRejectedValue(unavailable());

    render(<Probe />, { wrapper });
    fireEvent.click(screen.getByText("initialize"));
    await waitFor(() => expect(screen.getByTestId("user")).toHaveTextContent("users/1"));

    fireEvent.click(screen.getByText("logout"));

    const { loadOfflineSession } = await import("@/lib/offline-session");
    expect(loadOfflineSession("users/1")).toBeUndefined();
  });
});
