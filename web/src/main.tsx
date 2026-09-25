import "@github/relative-time-element";
import { QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import React, { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "react-hot-toast";
import { RouterProvider } from "react-router-dom";
import "./i18n";
import "./index.css";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { TooltipProvider } from "@/components/ui/tooltip";
import { refreshAccessToken } from "@/connect";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { InstanceProvider, useInstance } from "@/contexts/InstanceContext";
import { ViewProvider } from "@/contexts/ViewContext";
import { useLiveMemoRefresh } from "@/hooks/useLiveMemoRefresh";
import { useTokenRefreshOnFocus } from "@/hooks/useTokenRefreshOnFocus";
import { queryClient } from "@/lib/query-client";
import { restorePersistedQueries, scheduleWorkerRegistration, startQueryCachePersistence } from "@/lib/service-worker-registration";
import router from "./router";
import { applyLocaleEarly } from "./utils/i18n";
import { applyThemeEarly } from "./utils/theme";

// Apply theme and locale early to prevent flash
applyThemeEarly();
applyLocaleEarly();

// Inner component that initializes contexts
function AppInitializer({ children }: { children: React.ReactNode }) {
  const { isIdentityInitialized, initialize: initAuth, currentUser } = useAuth();
  const { isProfileInitialized, initialize: initInstance } = useInstance();
  const initStartedRef = useRef(false);

  // Initialize on mount - run in parallel for better performance
  useEffect(() => {
    if (initStartedRef.current) return;
    initStartedRef.current = true;

    const init = async () => {
      await Promise.all([initInstance(), initAuth()]);
    };
    init();
  }, [initAuth, initInstance]);

  // Proactively refresh token on window focus to prevent 401 errors
  // Only enabled when user is authenticated
  // Related: https://github.com/usememos/memos/issues/5589
  useTokenRefreshOnFocus(refreshAccessToken, !!currentUser);

  // Live refresh: listen for memo changes via SSE and invalidate caches.
  useLiveMemoRefresh();

  // Write the cache back after identity settles and whenever it changes, so the
  // persisted copy is always scoped to the signed-in user.
  useEffect(() => startQueryCachePersistence(currentUser?.name), [currentUser?.name]);

  // Route loading and feed requests only need the verified identity and the
  // instance profile. Display-sensitive settings continue in the background;
  // PagedMemoList keeps memo content hidden until privacy settings have settled.
  if (!isIdentityInitialized || !isProfileInitialized) {
    return null;
  }

  return <>{children}</>;
}

function Main() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <InstanceProvider>
          <AuthProvider>
            <TooltipProvider>
              <ViewProvider>
                <AppInitializer>
                  <RouterProvider router={router} />
                  <Toaster position="top-right" />
                </AppInitializer>
              </ViewProvider>
            </TooltipProvider>
          </AuthProvider>
        </InstanceProvider>
        <ReactQueryDevtools initialIsOpen={false} />
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

/**
 * Rehydrates the persisted query cache before first render. Restored entries are
 * invalidated, so an online client refetches immediately and the cache only ever
 * acts as a fallback — every online read stays a live query.
 */
async function bootstrap(): Promise<void> {
  await restorePersistedQueries();

  const container = document.getElementById("root");
  const root = createRoot(container as HTMLElement);
  root.render(<Main />);

  // Register after load so the worker install does not compete with first paint.
  // If load already fired (e.g. slow IndexedDB restore), register immediately.
  scheduleWorkerRegistration();
}

void bootstrap();
