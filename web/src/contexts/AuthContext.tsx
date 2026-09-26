import { Code } from "@connectrpc/connect";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { clearAccessToken, getAccessToken, hasStoredToken } from "@/auth-state";
import { authServiceClient, refreshAccessToken, userServiceClient } from "@/connect";
import { userKeys } from "@/hooks/useUserQueries";
import { hasConnectCode } from "@/lib/error";
import {
  clearOfflineSession,
  getStoredOfflineUserName,
  loadOfflineSession,
  type OfflineSession,
  saveOfflineSession,
} from "@/lib/offline-session";
import { offlineStore } from "@/lib/offline-store-instance";
import { removeAllQueryCaches } from "@/lib/query-persistence";
import { clearAttachmentCache } from "@/lib/service-worker-registration";
import type {
  User,
  UserSetting_GeneralSetting,
  UserSetting_TagsSetting,
  UserSetting_WebhooksSetting,
} from "@/types/proto/api/v1/user_service_pb";

interface AuthState {
  currentUser: User | undefined;
  userGeneralSetting: UserSetting_GeneralSetting | undefined;
  userWebhooksSetting: UserSetting_WebhooksSetting | undefined;
  userTagsSetting: UserSetting_TagsSetting | undefined;
  /** Authentication identity has settled, while user settings may still be loading. */
  isIdentityInitialized: boolean;
  /** User settings that affect memo presentation are safe to consume. */
  isUserSettingsInitialized: boolean;
  isInitialized: boolean;
  isLoading: boolean;
  /** The last initialization could not reach the server; state was restored locally. */
  isOffline: boolean;
}

interface AuthContextValue extends AuthState {
  initialize: () => Promise<void>;
  logout: () => Promise<void>;
  refetchSettings: () => Promise<void>;
  setCurrentUser: (user: User | undefined) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Settled auth state for a request with no valid session (init finished, not loading). */
const UNAUTHENTICATED_STATE: AuthState = {
  currentUser: undefined,
  userGeneralSetting: undefined,
  userWebhooksSetting: undefined,
  userTagsSetting: undefined,
  isIdentityInitialized: true,
  isUserSettingsInitialized: true,
  isInitialized: true,
  isLoading: false,
  isOffline: false,
};

/**
 * Distinguishes "the server is unreachable" from "the server rejected us".
 * Connect 2.x wraps browser fetch-level failures (DNS, TCP reset, CORS block)
 * as Code.Unknown via ConnectError.from(reason), so Unknown must count as
 * network failure alongside Unavailable (HTTP 429/502/503/504) and
 * DeadlineExceeded (request timed out before any response).
 */
function isNetworkFailure(error: unknown): boolean {
  return hasConnectCode(error, Code.Unavailable, Code.Unknown, Code.DeadlineExceeded) || navigator.onLine === false;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<AuthState>({
    currentUser: undefined,
    userGeneralSetting: undefined,
    userWebhooksSetting: undefined,
    userTagsSetting: undefined,
    isIdentityInitialized: false,
    isUserSettingsInitialized: false,
    isInitialized: false,
    isLoading: true,
    isOffline: false,
  });

  const fetchUserSettings = useCallback(async (userName: string) => {
    const { settings } = await userServiceClient.listUserSettings({ parent: userName });
    const generalSetting = settings.find((s) => s.value.case === "generalSetting");
    const webhooksSetting = settings.find((s) => s.value.case === "webhooksSetting");
    const tagsSetting = settings.find((s) => s.value.case === "tagsSetting");
    const userSettings = {
      userGeneralSetting: generalSetting?.value.case === "generalSetting" ? generalSetting.value.value : undefined,
      userWebhooksSetting: webhooksSetting?.value.case === "webhooksSetting" ? webhooksSetting.value.value : undefined,
      userTagsSetting: tagsSetting?.value.case === "tagsSetting" ? tagsSetting.value.value : undefined,
    };

    // Tag settings control sensitive-content blurring. Publish them as soon as
    // this request settles; memo views are managed separately by React Query.
    setState((prev) =>
      prev.currentUser?.name === userName
        ? {
            ...prev,
            ...userSettings,
            isUserSettingsInitialized: true,
          }
        : prev,
    );

    return userSettings;
  }, []);

  /**
   * Rebuilds state from the persisted session. The identity here gates display
   * and scopes the cache; it never authorizes a request. Offline, every request
   * fails anyway and all data comes from the persisted query cache.
   */
  const restoreOfflineSession = useCallback((): OfflineSession | undefined => {
    const storedUserName = getStoredOfflineUserName();
    if (!storedUserName) return undefined;
    return loadOfflineSession(storedUserName);
  }, []);

  const initialize = useCallback(async () => {
    // `initialize` also runs after sign-in, when the previous unauthenticated
    // state is already marked initialized. Reset the full-readiness flag so
    // consumers cannot render with the new identity and stale/default settings.
    setState((prev) => ({ ...prev, isUserSettingsInitialized: false, isInitialized: false, isLoading: true }));

    // Try to get or refresh the access token.
    // This handles PWA isolated storage scenarios (e.g., iOS Safari) where localStorage
    // may be empty but a valid HTTP-only refresh token cookie still exists.
    // getAccessToken() returns a cached token or loads from localStorage if valid.
    if (!getAccessToken()) {
      try {
        await refreshAccessToken();
      } catch (error) {
        // A refresh that failed because the network is down is not a dead
        // session. Only a definitive auth rejection (Unauthenticated or
        // PermissionDenied) or the absence of any stored token warrants
        // clearing the session. Anything else falls through to the offline
        // restore path below, so an expired token plus a dead connection
        // does not read as "logged out".
        if (hasConnectCode(error, Code.Unauthenticated, Code.PermissionDenied) || !hasStoredToken()) {
          clearAccessToken();
          clearOfflineSession();
          setState(UNAUTHENTICATED_STATE);
          return;
        }
      }
    }

    if (!getAccessToken() && !hasStoredToken()) {
      setState(UNAUTHENTICATED_STATE);
      return;
    }

    try {
      const { user: currentUser } = await authServiceClient.getCurrentUser({});

      if (!currentUser) {
        clearAccessToken();
        clearOfflineSession();
        setState(UNAUTHENTICATED_STATE);
        return;
      }

      // Drop a stale offline entry from a different user so the restore path
      // cannot resurrect another account's identity or tag settings. A boot
      // restore may also have hydrated the previous account's memos into the
      // shared query client, and an earlier branch in this function may already
      // have cleared the stored name — so drop the whole client and remove every
      // persisted cache instead of the one keyed by a name that may be gone.
      if (getStoredOfflineUserName() !== currentUser.name) {
        queryClient.clear();
        if (offlineStore) {
          void removeAllQueryCaches(offlineStore);
        }
        clearOfflineSession();
      }

      setState((prev) => ({ ...prev, currentUser, isIdentityInitialized: true, isOffline: false }));

      queryClient.setQueryData(userKeys.currentUser(), currentUser);
      queryClient.setQueryData(userKeys.detail(currentUser.name), currentUser);

      const settings = await fetchUserSettings(currentUser.name);

      saveOfflineSession(currentUser, {
        general: settings.userGeneralSetting,
        tags: settings.userTagsSetting,
        webhooks: settings.userWebhooksSetting,
      });

      setState({
        currentUser,
        ...settings,
        isIdentityInitialized: true,
        isUserSettingsInitialized: true,
        isInitialized: true,
        isOffline: false,
        isLoading: false,
      });
    } catch (error) {
      console.error("Failed to initialize auth:", error);

      if (isNetworkFailure(error)) {
        // Restore rather than log out. Every flag must be set: main.tsx gates on
        // isIdentityInitialized, RequireFullInitializationRoute gates on
        // isInitialized, and PagedMemoList withholds memo content until
        // isUserSettingsInitialized — a partial restore still shows a blank page.
        const restored = restoreOfflineSession();
        if (restored) {
          queryClient.setQueryData(userKeys.currentUser(), restored.user);
          queryClient.setQueryData(userKeys.detail(restored.user.name), restored.user);
          setState({
            currentUser: restored.user,
            userGeneralSetting: restored.general,
            userTagsSetting: restored.tags,
            userWebhooksSetting: restored.webhooks,
            isIdentityInitialized: true,
            isUserSettingsInitialized: true,
            isInitialized: true,
            isOffline: true,
            isLoading: false,
          });
          return;
        }
        // Nothing to restore: keep the token so a reload can recover, but do not
        // present an unverified identity.
        setState((prev) => ({ ...prev, ...UNAUTHENTICATED_STATE }));
        return;
      }

      if (hasConnectCode(error, Code.Unauthenticated, Code.PermissionDenied)) {
        clearAccessToken();
        clearOfflineSession();
        setState(UNAUTHENTICATED_STATE);
        return;
      }

      // Unclassified failure. Not evidence of a dead session, so the token stays;
      // but we have no verified identity to render, so fall back to /auth.
      setState((prev) => ({ ...prev, ...UNAUTHENTICATED_STATE }));
    }
  }, [fetchUserSettings, queryClient, restoreOfflineSession]);

  const logout = useCallback(async () => {
    try {
      await authServiceClient.signOut({});
    } catch (error) {
      console.error("[AuthContext] Failed to sign out:", error);
    } finally {
      clearAccessToken();
      clearOfflineSession();
      // Awaited, not fire-and-forget: handleSignOut navigates with
      // window.location.replace as soon as logout() resolves, and unloading the
      // document aborts pending IndexedDB transactions and Cache Storage calls.
      // This destruction is the containment control for cached private
      // attachments and query data, so it has to finish first.
      if (offlineStore) {
        await removeAllQueryCaches(offlineStore);
      }
      await clearAttachmentCache();
      setState(UNAUTHENTICATED_STATE);
      queryClient.clear();
    }
  }, [queryClient]);

  const refetchSettings = useCallback(async () => {
    const currentUserName = state.currentUser?.name;
    if (!currentUserName) {
      return;
    }

    const settings = await fetchUserSettings(currentUserName);
    setState((prev) => {
      if (prev.currentUser?.name !== currentUserName) {
        return prev;
      }
      return { ...prev, ...settings };
    });
  }, [fetchUserSettings, state.currentUser?.name]);

  // Sync the updated user to AuthContext and React Query cache after profile changes
  const setCurrentUser = useCallback(
    (user: User | undefined) => {
      const previousUser = queryClient.getQueryData<User>(userKeys.currentUser());
      setState((prev) => ({ ...prev, currentUser: user }));
      if (user) {
        queryClient.setQueryData(userKeys.currentUser(), user);
        queryClient.setQueryData(userKeys.detail(user.name), user);
      } else {
        queryClient.removeQueries({ queryKey: userKeys.currentUser(), exact: true });
        if (previousUser?.name) {
          queryClient.removeQueries({ queryKey: userKeys.detail(previousUser.name), exact: true });
        }
      }
    },
    [queryClient],
  );

  // Memoize context value to prevent unnecessary re-renders of consumers
  const value = useMemo(
    () => ({
      ...state,
      initialize,
      logout,
      refetchSettings,
      setCurrentUser,
    }),
    [state, initialize, logout, refetchSettings, setCurrentUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
}

// Convenience hook for just the current user
export function useCurrentUserFromAuth() {
  const { currentUser } = useAuth();
  return currentUser;
}
