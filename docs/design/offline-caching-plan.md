# Offline Client-Side Caching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the memos web client survive a dead connection — load its shell, show the signed-in user's memos and images read-only, and stop logging people out when the network drops.

**Architecture:** Four layers. (1) `AuthContext` learns to tell a network failure from a dead credential and restores a persisted identity instead of logging out. (2) A hand-written service worker precaches the built app shell and caches attachments, bypassing all API routes so reads stay live. (3) The React Query cache is dehydrated into IndexedDB, scoped per user, and rehydrated before first render. (4) `sw.js` is served `no-cache` so Cloudflare cannot pin a stale worker.

**Tech Stack:** React 19, TypeScript, TanStack React Query v5 (core `dehydrate`/`hydrate` only), Vite 8 with a custom plugin, Service Worker + Cache Storage + IndexedDB, Go 1.27 / Echo v5 for the header change.

**Spec:** `docs/design/offline-caching.md`

## Global Constraints

- **No new dependencies.** Neither runtime nor dev. `@tanstack/react-query-persist-client` is deliberately not added; persistence is hand-rolled on core `dehydrate`/`hydrate`.
- Frontend deps are **not installed** in this checkout. Run `cd web && pnpm install` once before any `pnpm` command below.
- The service worker **never** intercepts `/api`, `/memos.api.v1`, `/memos.api.v1.*`, or the SSE endpoint. This is the structural guarantee behind "online always runs a live query" and must not be relaxed.
- Attachment responses are cached **only** when `status === 200` and the request has no `Range` header. `206` cannot be stored by the Cache API.
- Persisted data is scoped **per user name** and destroyed on logout — both the IndexedDB query cache, the localStorage offline session, and the attachment Cache Storage entry.
- Frontend style: 2-space indent, double quotes, semicolons, 140-char width, `@/` absolute imports (Biome). Errors wrapped with `errors.Wrap` in Go.
- Tests live flat in `web/tests/*.test.ts(x)`, not co-located. Go tests sit next to the code.
- Verification commands, per `AGENTS.md`: `cd web && pnpm lint && pnpm test` for frontend, `go test ./server/frontend/...` for the header change.

## Review Focus

1. **Token expired *and* offline.** `getAccessToken()` returns null for an expired token, `refreshAccessToken()` fails on the network, and the `!getAccessToken()` early return marks the user unauthenticated. A person who left the app open overnight on a dead connection must still see their notes. → Task 2, Step 1.
2. **Second account on the same browser.** Sign out, sign in as someone else: the previous user's memos must not appear, not even for a frame. → Task 8, Step 1 and Task 9, Step 6.
3. **IndexedDB unavailable or over quota.** Private browsing modes and full devices throw on open/write. The app must degrade to online-only, never white-screen. → Task 8, Step 1 and Task 7, Step 1.
4. **Storage eviction is silent today.** With no cap on memo count, the user needs to see how much is held and whether persistence was granted. → Task 11, Step 1.
5. **Revoked access lingering offline.** A memo made private on another device must not stay readable forever from cache. → Task 8, Step 1.

---

## File Structure

| Path | Responsibility |
| --- | --- |
| `web/src/lib/offline-session.ts` | Create. Persist and restore last-known identity + user settings in `localStorage`, keyed per user. |
| `web/src/contexts/AuthContext.tsx` | Modify. Classify init failures; restore offline; clear persisted session on logout. |
| `web/src/lib/offline-store.ts` | Create. Key/value storage abstraction over IndexedDB, injectable for tests. |
| `web/src/lib/query-persistence.ts` | Create. Dehydrate/hydrate the query cache through `offline-store`, with allowlist, per-user key, max age. |
| `web/src/lib/service-worker-registration.ts` | Create. Register `sw.js`, request persistent storage, expose state. |
| `web/src/lib/offline-store-instance.ts` | Create. The single shared IndexedDB handle, imported by `main.tsx` and `AuthContext`. |
| `web/src/lib/offline-state.ts` | Create. Connectivity predicate that gates mutations, with a test seam. |
| `web/scripts/sw-routing.mjs` | Create. Pure routing and eviction decisions, shared by the worker and its tests. |
| `web/scripts/sw.template.js` | Create. The service worker itself; manifest substituted at build time. |
| `web/scripts/vite-plugin-offline-shell.mjs` | Create. Emits `dist/sw.js` with the built asset manifest and hash. |
| `web/vite.config.mts` | Modify. Wire the plugin. |
| `web/src/main.tsx` | Modify. Restore cache before render; register worker after load. |
| `web/src/components/Settings/ResourceStatsSection.tsx` | Modify. Show offline storage usage. |
| `web/src/components/OfflineBanner.tsx` | Create. Read-only notice. |
| `web/src/components/Settings/OfflineStorageStats.tsx` | Create. Shows offline cache size and whether persistence was granted. |
| `server/frontend/frontend.go` | Modify. `no-cache` for `sw.js` and the webmanifest. |
| `server/frontend/frontend_test.go` | Modify. Header assertions. |

---

### Task 1: Offline session store

**Files:**
- Create: `web/src/lib/offline-session.ts`
- Test: `web/tests/offline-session.test.ts`

**Interfaces:**
- Consumes: `UserSchema`, `UserSetting_TagsSettingSchema`, `UserSetting_GeneralSettingSchema`, `UserSetting_WebhooksSettingSchema` from `@/types/proto/api/v1/user_service_pb`; `toJson`/`fromJson` from `@bufbuild/protobuf`.
- Produces:
  - `saveOfflineSession(user: User, settings: OfflineSessionSettings): void`
  - `loadOfflineSession(userName: string): OfflineSession | undefined`
  - `clearOfflineSession(): void`
  - `interface OfflineSessionSettings { general?: UserSetting_GeneralSetting; tags?: UserSetting_TagsSetting; webhooks?: UserSetting_WebhooksSetting }`
  - `interface OfflineSession extends OfflineSessionSettings { user: User }`
  - `getStoredOfflineUserName(): string | undefined`

- [ ] **Step 1: Write the failing test**

`web/tests/offline-session.test.ts`:

```ts
import { create } from "@bufbuild/protobuf";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearOfflineSession, loadOfflineSession, saveOfflineSession } from "@/lib/offline-session";
import { UserSchema } from "@/types/proto/api/v1/user_service_pb";
import { UserSetting_TagsSettingSchema } from "@/types/proto/api/v1/user_service_pb";

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
});

const alice = () => create(UserSchema, { name: "users/1", username: "alice" });

describe("offline session", () => {
  it("round-trips identity and tag settings for the saved user", () => {
    saveOfflineSession(alice(), { tags: create(UserSetting_TagsSettingSchema, {}) });

    const restored = loadOfflineSession("users/1");

    expect(restored?.user.username).toBe("alice");
    expect(restored?.tags).toBeDefined();
  });

  it("returns nothing for a different user name", () => {
    saveOfflineSession(alice(), {});

    expect(loadOfflineSession("users/2")).toBeUndefined();
  });

  it("returns nothing once cleared", () => {
    saveOfflineSession(alice(), {});
    clearOfflineSession();

    expect(loadOfflineSession("users/1")).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it("survives a corrupt payload instead of throwing", () => {
    store.set("memos_offline_session", "{not json");

    expect(loadOfflineSession("users/1")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && pnpm vitest run tests/offline-session.test.ts`
Expected: FAIL — cannot resolve `@/lib/offline-session`.

- [ ] **Step 3: Write minimal implementation**

`web/src/lib/offline-session.ts`:

```ts
import { fromJson, type JsonValue, toJson } from "@bufbuild/protobuf";
import type { User, UserSetting_GeneralSetting, UserSetting_TagsSetting, UserSetting_WebhooksSetting } from "@/types/proto/api/v1/user_service_pb";
import {
  UserSchema,
  UserSetting_GeneralSettingSchema,
  UserSetting_TagsSettingSchema,
  UserSetting_WebhooksSettingSchema,
} from "@/types/proto/api/v1/user_service_pb";

const STORAGE_KEY = "memos_offline_session";
const ENTRY_VERSION = 1;

export interface OfflineSessionSettings {
  general?: UserSetting_GeneralSetting;
  tags?: UserSetting_TagsSetting;
  webhooks?: UserSetting_WebhooksSetting;
}

export interface OfflineSession extends OfflineSessionSettings {
  user: User;
}

interface StoredEntry {
  version: number;
  user: JsonValue;
  general?: JsonValue;
  tags?: JsonValue;
  webhooks?: JsonValue;
}

/**
 * Remembers the signed-in identity and the settings that gate memo display, so a
 * cold load with no connectivity can render cached memos instead of bouncing to
 * /auth. Tag settings decide sensitive-content blurring, so they must be present
 * before any memo is shown.
 */
export function saveOfflineSession(user: User, settings: OfflineSessionSettings): void {
  const entry: StoredEntry = {
    version: ENTRY_VERSION,
    user: toJson(UserSchema, user),
    ...(settings.general ? { general: toJson(UserSetting_GeneralSettingSchema, settings.general) } : {}),
    ...(settings.tags ? { tags: toJson(UserSetting_TagsSettingSchema, settings.tags) } : {}),
    ...(settings.webhooks ? { webhooks: toJson(UserSetting_WebhooksSettingSchema, settings.webhooks) } : {}),
  };

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entry));
  } catch (error) {
    // Private browsing and full quota both land here. Losing the offline session
    // degrades to today's behaviour; it must never break the live path.
    console.warn("Failed to persist offline session:", error);
  }
}

export function loadOfflineSession(userName: string): OfflineSession | undefined {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return undefined;
  }
  if (!raw) return undefined;

  try {
    const parsed = JSON.parse(raw) as StoredEntry;
    if (parsed.version !== ENTRY_VERSION) return undefined;

    const user = fromJson(UserSchema, parsed.user, { ignoreUnknownFields: true });
    // The entry belongs to whoever saved it. Restoring it for another account
    // would show one user's identity and privacy settings to a different person.
    if (user.name !== userName) return undefined;

    return {
      user,
      ...(parsed.general
        ? { general: fromJson(UserSetting_GeneralSettingSchema, parsed.general, { ignoreUnknownFields: true }) }
        : {}),
      ...(parsed.tags ? { tags: fromJson(UserSetting_TagsSettingSchema, parsed.tags, { ignoreUnknownFields: true }) } : {}),
      ...(parsed.webhooks
        ? { webhooks: fromJson(UserSetting_WebhooksSettingSchema, parsed.webhooks, { ignoreUnknownFields: true }) }
        : {}),
    };
  } catch {
    return undefined;
  }
}

export function clearOfflineSession(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do if storage is unreachable.
  }
}

/**
 * The user name from the persisted offline session, if any. Used only to decide
 * which cached identity to restore; never sent to the server. Lives here rather
 * than in auth-state.ts because this module owns STORAGE_KEY.
 */
export function getStoredOfflineUserName(): string | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    return (JSON.parse(raw) as { user?: { name?: string } }).user?.name;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && pnpm vitest run tests/offline-session.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/offline-session.ts web/tests/offline-session.test.ts
git commit -m "feat(web): persist last-known identity and settings for offline restore"
```

---

### Task 2: Offline-tolerant auth initialization

**Files:**
- Modify: `web/src/contexts/AuthContext.tsx` (the `initialize` callback, lines ~86-146; the `logout` callback, lines ~148-158; the `AuthState` interface, lines ~12-24)
- Test: `web/tests/auth-context-initialization.test.tsx` (extend the existing file)

**Interfaces:**
- Consumes: `saveOfflineSession`, `loadOfflineSession`, `clearOfflineSession` from `@/lib/offline-session`; `hasConnectCode` from `@/lib/error`; `Code` from `@connectrpc/connect`; `hasStoredToken` from `@/auth-state`.
- Produces: `isOffline: boolean` on `AuthState`, surfaced through `useAuth()`. Task 12 reads it.

- [ ] **Step 1: Write the failing tests**

Append to `web/tests/auth-context-initialization.test.tsx`. The file already mocks `@/connect` and `@/auth-state` with a hoisted `authState.hasToken` switch; add `hasStoredToken` to that mock and add `Code`/`ConnectError` for building failures.

```tsx
import { Code, ConnectError } from "@connectrpc/connect";

const unavailable = () => new ConnectError("fetch failed", Code.Unavailable);
const unauthenticated = () => new ConnectError("invalid token", Code.Unauthenticated);

describe("offline initialization", () => {
  beforeEach(() => {
    authState.hasToken = true;
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
    (refreshAccessToken as ReturnType<typeof vi.fn>).mockRejectedValueOnce(unavailable());

    render(<Probe />, { wrapper });
    fireEvent.click(screen.getByText("initialize"));

    await waitFor(() => expect(screen.getByTestId("user")).toHaveTextContent("users/1"));
    expect(clearAccessToken).not.toHaveBeenCalled();
  });

  it("drops the persisted session on logout", async () => {
    saveOfflineSession(create(UserSchema, { name: "users/1", username: "alice" }), {});
    clients.getCurrentUser.mockRejectedValue(unavailable());

    render(<Probe />, { wrapper });
    fireEvent.click(screen.getByText("initialize"));
    await waitFor(() => expect(screen.getByTestId("user")).toHaveTextContent("users/1"));

    fireEvent.click(screen.getByText("logout"));

    expect(loadOfflineSession("users/1")).toBeUndefined();
  });
});
```

The `Probe` component in that file needs `isOffline` and a logout button:

```tsx
const Probe = () => {
  const { currentUser, initialize, logout, isInitialized, isUserSettingsInitialized, isOffline } = useAuth();
  return (
    <div>
      <span data-testid="initialized">{isInitialized ? "yes" : "no"}</span>
      <span data-testid="user-settings-initialized">{isUserSettingsInitialized ? "yes" : "no"}</span>
      <span data-testid="offline">{isOffline ? "yes" : "no"}</span>
      <span data-testid="user">{currentUser?.name ?? "none"}</span>
      <button type="button" onClick={() => void initialize()}>initialize</button>
      <button type="button" onClick={() => void logout()}>logout</button>
    </div>
  );
};
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && pnpm vitest run tests/auth-context-initialization.test.tsx`
Expected: FAIL — `isOffline` is not on the context type, and the network-failure case calls `clearAccessToken`.

- [ ] **Step 3: Add the offline classification to `AuthContext`**

Add to the `AuthState` interface:

```ts
  /** The last initialization could not reach the server; state was restored locally. */
  isOffline: boolean;
```

Add `isOffline: false` to both the initial `useState` object and to `UNAUTHENTICATED_STATE`.

Add a helper above `AuthProvider`:

```ts
/**
 * Distinguishes "the server is unreachable" from "the server rejected us".
 * Code.Unavailable is this codebase's network-failure signal — see
 * uploadService.ts and lib/memo-export.ts, which retry only on that code.
 */
function isNetworkFailure(error: unknown): boolean {
  return hasConnectCode(error, Code.Unavailable) || navigator.onLine === false;
}
```

Replace the body of `initialize` from the token check onward:

```ts
    if (!getAccessToken()) {
      try {
        await refreshAccessToken();
      } catch (error) {
        // A refresh that failed because the network is down is not a dead
        // session. Fall through to the offline restore below when we still hold
        // a stored token, so an expired token plus no connectivity does not read
        // as "logged out".
        if (!isNetworkFailure(error) || !hasStoredToken()) {
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

      setState((prev) => ({ ...prev, currentUser, isIdentityInitialized: true, isOffline: false }));

      queryClient.setQueryData(userKeys.currentUser(), currentUser);
      queryClient.setQueryData(userKeys.detail(currentUser.name), currentUser);

      const settings = await fetchUserSettings(currentUser.name);

      saveOfflineSession(currentUser, settings);

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
```

And the restore helper inside `AuthProvider`, next to `fetchUserSettings`:

```ts
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
```

`fetchUserSettings` currently returns settings keyed as `userGeneralSetting`/`userTagsSetting`/`userWebhooksSetting`; `saveOfflineSession` takes `{ general, tags, webhooks }`. Map at the call site:

```ts
      saveOfflineSession(currentUser, {
        general: settings.userGeneralSetting,
        tags: settings.userTagsSetting,
        webhooks: settings.userWebhooksSetting,
      });
```

Import `getStoredOfflineUserName` and `type OfflineSession` from `@/lib/offline-session` — it
owns the storage key, so `auth-state.ts` must not duplicate it. Do not decode the access token
to recover the user name: it may be expired, and an unverified token is the wrong source of
truth for which cached identity to display.

Update `logout` to clear the persisted session:

```ts
    } finally {
      clearAccessToken();
      clearOfflineSession();
      setState(UNAUTHENTICATED_STATE);
      queryClient.clear();
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && pnpm vitest run tests/auth-context-initialization.test.tsx`
Expected: PASS — the pre-existing cases plus the 5 new ones.

- [ ] **Step 5: Run the whole frontend suite and lint**

Run: `cd web && pnpm lint && pnpm test`
Expected: no new failures. `AuthContext` consumers that destructure the context object may need `isOffline` added to their type expectations.

- [ ] **Step 6: Commit**

```bash
git add web/src/contexts/AuthContext.tsx web/tests/auth-context-initialization.test.tsx
git commit -m "fix(web): keep the session when auth init fails on the network

An offline cold load treated Code.Unavailable as a rejected credential,
cleared the access token and redirected to /auth. Classify the failure
instead, and restore the persisted identity and settings so cached memos
remain visible. Fixes a live bug: any connection drop during init logged
the user out."
```

---

### Task 3: Serve `sw.js` with `no-cache`

**Files:**
- Modify: `server/frontend/frontend.go:24-26` (constants), `:83-99` (`setFrontendCacheHeaders`)
- Test: `server/frontend/frontend_test.go` (both table tests)

**Interfaces:**
- Consumes: nothing new.
- Produces: `/sw.js`, `/site.webmanifest` and `/manifest.webmanifest` served `no-cache`. Task 6 depends on this so Cloudflare revalidates the worker on every update check.

- [ ] **Step 1: Write the failing test cases**

Add to the `tests` slice in `TestFrontendService_CacheHeaderRules`:

```go
		{
			name:         "service worker is always revalidated",
			path:         "/sw.js",
			cacheControl: frontendServiceWorkerCacheControl,
		},
		{
			name:         "web manifest is always revalidated",
			path:         "/site.webmanifest",
			cacheControl: frontendServiceWorkerCacheControl,
		},
```

Add the same two cases to the `tests` slice in `TestFrontendService_StaticCacheHeaders`. That second test drives the real router against the embedded FS, and `sw.js` does not exist in the placeholder `dist/`, so assert only the cases the embedded FS can serve there; if the SPA fallback returns HTML for `/sw.js` in that fixture, keep the assertion in `CacheHeaderRules` alone and note why in a comment.

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./server/frontend/... -run CacheHeader -v`
Expected: FAIL — `frontendServiceWorkerCacheControl` undefined.

- [ ] **Step 3: Implement**

In the `const` block at `frontend.go:23-27`:

```go
	// The service worker script and the manifest must never be pinned by an
	// intermediary. Cloudflare edge-caches .js by default, so a max-age here
	// would leave clients running a stale worker — and a stale worker serving a
	// stale shell is the failure mode offline caching exists to remove.
	frontendServiceWorkerCacheControl = "no-cache"
```

In `setFrontendCacheHeaders`, before the existing static-asset branch:

```go
	if isServiceWorkerAsset(requestPath) {
		c.Response().Header().Set(echo.HeaderCacheControl, frontendServiceWorkerCacheControl)
		return
	}
```

And the predicate next to `shouldServeFrontendHTML`. It mirrors the worker's own bypass list in `web/scripts/sw-routing.mjs`; keep the two in step:

```go
// isServiceWorkerAsset reports whether the path must be revalidated on every
// request rather than cached by the browser or an intermediary such as
// Cloudflare. Mirrors PRECACHE_BYPASS in web/scripts/sw-routing.mjs.
func isServiceWorkerAsset(requestPath string) bool {
	switch requestPath {
	case "/sw.js", "/site.webmanifest", "/manifest.webmanifest":
		return true
	default:
		return false
	}
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test ./server/frontend/... -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/frontend/frontend.go server/frontend/frontend_test.go
git commit -m "fix(frontend): serve sw.js and the webmanifest with no-cache

Cloudflare edge-caches .js, so the previous max-age=3600 could pin a
stale service worker for an hour after a deploy."
```

---

### Task 4: Service worker routing decisions

**Files:**
- Create: `web/scripts/sw-routing.mjs`
- Test: `web/tests/sw-routing.test.ts`

**Interfaces:**
- Consumes: nothing. Pure functions over plain data, so vitest can import the `.mjs` directly and the worker can import it at build time.
- Produces:
  - `isBypassedPath(pathname: string): boolean`
  - `isAttachmentPath(pathname: string): boolean`
  - `isCacheableAttachmentResponse(method: string, hasRangeHeader: boolean, status: number): boolean`
  - `isImmutableAssetPath(pathname: string): boolean`
  - `selectEvictions(entries: { url: string; size: number }[], capBytes: number): string[]`
  - `ATTACHMENT_CACHE_CAP_BYTES: number`

- [ ] **Step 1: Write the failing test**

`web/tests/sw-routing.test.ts`:

```ts
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain .mjs module shared with the service worker
import {
  ATTACHMENT_CACHE_CAP_BYTES,
  isAttachmentPath,
  isBypassedPath,
  isCacheableAttachmentResponse,
  isImmutableAssetPath,
  selectEvictions,
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && pnpm vitest run tests/sw-routing.test.ts`
Expected: FAIL — cannot resolve `../scripts/sw-routing.mjs`.

- [ ] **Step 3: Implement**

`web/scripts/sw-routing.mjs`:

```js
/**
 * Pure routing and eviction decisions for the offline service worker.
 *
 * Kept separate from sw.template.js so vitest can import it directly: a service
 * worker script has no module exports at runtime, but the decisions inside it
 * are the part worth testing.
 *
 * The bypass list mirrors shouldSkipFrontendStatic in server/frontend/frontend.go
 * minus /file, which this worker does cache. Keep the two in step.
 */

/** Total attachment cache budget. Oldest entries are evicted past this. */
export const ATTACHMENT_CACHE_CAP_BYTES = 500 * 1024 * 1024;

const BYPASS_PREFIXES = ["/api", "/memos.api.v1"];

/** True when the worker must not touch the request at all. */
export function isBypassedPath(pathname) {
  // The SSE stream must not be buffered or delayed; see useLiveMemoRefresh.ts.
  if (pathname.startsWith("/api/v1/sse")) return true;
  return BYPASS_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`) || pathname.startsWith(`${prefix}.`));
}

/** Attachment binaries and user avatars, served from /file by fileserver.go. */
export function isAttachmentPath(pathname) {
  return pathname.startsWith("/file/attachments/") || pathname.startsWith("/file/users/");
}

/**
 * Only complete responses are storable. Cache.put rejects non-200 range
 * responses, and a request that asked for a range may be answered 200 by a
 * backend that ignores Range — caching that would poison later full reads.
 */
export function isCacheableAttachmentResponse(method, hasRangeHeader, status) {
  return method === "GET" && !hasRangeHeader && status === 200;
}

/** Content-hashed build output under /assets/ never changes for a given name. */
export function isImmutableAssetPath(pathname) {
  return pathname.startsWith("/assets/");
}

/**
 * Oldest-first eviction down to capBytes. `entries` must already be ordered
 * oldest to newest. Returns the URLs to delete.
 */
export function selectEvictions(entries, capBytes) {
  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  const evict = [];
  for (const entry of entries) {
    if (total <= capBytes) break;
    evict.push(entry.url);
    total -= entry.size;
  }
  return evict;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && pnpm vitest run tests/sw-routing.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add web/scripts/sw-routing.mjs web/tests/sw-routing.test.ts
git commit -m "feat(web): add pure routing decisions for the offline service worker"
```

---

### Task 5: Service worker script

**Files:**
- Create: `web/scripts/sw.template.js`

**Interfaces:**
- Consumes: every export of `web/scripts/sw-routing.mjs`. Two build-time placeholders, substituted by Task 6: `__PRECACHE_MANIFEST__` (array of URL strings) and `__BUILD_HASH__` (string).
- Produces: `dist/sw.js`. Cache names `memos-shell-<hash>` and `memos-attachments-<hash>`.

There is no unit test for this file — the logic worth testing lives in `sw-routing.mjs`. It is verified by the build assertion in Task 6 and the manual checks in Task 12.

- [ ] **Step 1: Write the worker**

`web/scripts/sw.template.js`. It cannot live in `web/public/`: public assets are copied verbatim and this needs the manifest substituted.

```js
/**
 * Offline app shell worker.
 *
 * Strategy per docs/design/offline-caching.md:
 *  - navigations: network-first, cached index.html as fallback
 *  - build assets: precache hit, else network-then-store
 *  - /file/*: network-then-store, full 200 responses only, size-capped
 *  - /api, /memos.api.v1*, SSE: never intercepted, so every online read is a
 *    live query and no code path can serve a stale API response
 *
 * __PRECACHE_MANIFEST__ and __BUILD_HASH__ are substituted at build time by
 * web/scripts/vite-plugin-offline-shell.mjs.
 */
import {
  ATTACHMENT_CACHE_CAP_BYTES,
  isAttachmentPath,
  isBypassedPath,
  isCacheableAttachmentResponse,
  isImmutableAssetPath,
  selectEvictions,
} from "./sw-routing.mjs";

const BUILD_HASH = "__BUILD_HASH__";
const SHELL_CACHE = `memos-shell-${BUILD_HASH}`;
const ATTACHMENT_CACHE = `memos-attachments-${BUILD_HASH}`;
const PRECACHE_URLS = ["__PRECACHE_MANIFEST__"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      // Activate without waiting for every tab to close, so a fresh deploy takes
      // effect on the next navigation rather than the next browser restart.
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== SHELL_CACHE && key !== ATTACHMENT_CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isBypassedPath(url.pathname)) return;

  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(request));
    return;
  }
  if (isAttachmentPath(url.pathname)) {
    event.respondWith(handleAttachment(request));
    return;
  }
  event.respondWith(handleAsset(request, url.pathname));
});

/** Network-first: online stays current, offline falls back to the shell. */
async function handleNavigation(request) {
  try {
    const response = await fetch(request);
    const cache = await caches.open(SHELL_CACHE);
    await cache.put("/index.html", response.clone());
    return response;
  } catch {
    const cached = await caches.match("/index.html", { cacheName: SHELL_CACHE });
    // Without a cached shell there is nothing to show; let the browser render
    // its own error rather than fabricate a page.
    return cached ?? Response.error();
  }
}

/**
 * Hashed assets are immutable, so cache-first is safe and saves a round trip.
 * Anything else revalidates through the network first.
 */
async function handleAsset(request, pathname) {
  if (isImmutableAssetPath(pathname)) {
    const cached = await caches.match(request, { cacheName: SHELL_CACHE });
    if (cached) return cached;
  }

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await caches.match(request, { cacheName: SHELL_CACHE });
    if (cached) return cached;
    throw error;
  }
}

/** Network-then-store for attachments, capped so media cannot fill the device. */
async function handleAttachment(request) {
  try {
    const response = await fetch(request);
    if (isCacheableAttachmentResponse(request.method, request.headers.has("range"), response.status)) {
      const cache = await caches.open(ATTACHMENT_CACHE);
      await cache.put(request, response.clone());
      // Eviction is not awaited into the response path: the user should not wait
      // on bookkeeping to see an image.
      void enforceAttachmentCap(cache);
    }
    return response;
  } catch {
    const cached = await caches.match(request, { cacheName: ATTACHMENT_CACHE });
    return cached ?? Response.error();
  }
}

async function enforceAttachmentCap(cache) {
  const keys = await cache.keys();
  const entries = [];
  for (const key of keys) {
    const response = await cache.match(key);
    if (!response) continue;
    const blob = await response.clone().blob();
    entries.push({ url: key.url, size: blob.size });
  }
  const evictions = selectEvictions(entries, ATTACHMENT_CACHE_CAP_BYTES);
  await Promise.all(evictions.map((url) => cache.delete(url)));
}
```

Note: `cache.keys()` returns oldest-inserted first, which is the ordering `selectEvictions` expects. If that ordering ever proves unreliable, store an insertion timestamp in a response header instead — do not assume it silently.

- [ ] **Step 2: Verify the template parses**

Run: `cd web && node --input-type=module -e "import('./scripts/sw-routing.mjs').then(m => console.log(Object.keys(m).join(',')))"`
Expected: prints the six exported names. This confirms the module the worker imports is loadable; the worker itself is checked by the build in Task 6.

- [ ] **Step 3: Commit**

```bash
git add web/scripts/sw.template.js
git commit -m "feat(web): add offline app shell service worker template"
```

---

### Task 6: Vite plugin that emits `sw.js`

**Files:**
- Create: `web/scripts/vite-plugin-offline-shell.mjs`
- Modify: `web/vite.config.mts` (the `plugins` array)
- Test: `web/tests/offline-shell-plugin.test.ts`

**Interfaces:**
- Consumes: `web/scripts/sw.template.js` from disk; the Vite `generateBundle` hook's `bundle` object.
- Produces: `offlineShell()` — a Vite plugin. Emits asset `sw.js` with `__BUILD_HASH__` replaced by a content hash and `__PRECACHE_MANIFEST__` replaced by a JSON array of URLs (`/index.html` plus every emitted `/assets/*` file).

- [ ] **Step 1: Write the failing test**

`web/tests/offline-shell-plugin.test.ts`:

```ts
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain .mjs Vite plugin
import { buildServiceWorker } from "../scripts/vite-plugin-offline-shell.mjs";

const template = readFileSync(resolve(__dirname, "../scripts/sw.template.js"), "utf8");

describe("offline shell plugin", () => {
  const bundle = {
    "index.html": { type: "asset", fileName: "index.html" },
    "assets/index-abc123.js": { type: "asset", fileName: "assets/index-abc123.js" },
    "assets/index-def456.css": { type: "asset", fileName: "assets/index-def456.css" },
    "assets/lazy-chunk-789.js": { type: "asset", fileName: "assets/lazy-chunk-789.js" },
  };

  it("precaches the shell and every emitted asset", () => {
    const output = buildServiceWorker(template, bundle);

    expect(output).toContain('"/index.html"');
    expect(output).toContain('"/assets/index-abc123.js"');
    expect(output).toContain('"/assets/lazy-chunk-789.js"');
    expect(output).not.toContain("__PRECACHE_MANIFEST__");
  });

  it("replaces the build hash with a stable digest", () => {
    const output = buildServiceWorker(template, bundle);

    expect(output).not.toContain("__BUILD_HASH__");
    const expected = createHash("sha256").update(JSON.stringify([...Object.keys(bundle)].sort())).digest("hex").slice(0, 16);
    expect(output).toContain(expected);
  });

  it("produces the same hash for the same asset set", () => {
    expect(buildServiceWorker(template, bundle)).toBe(buildServiceWorker(template, { ...bundle }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && pnpm vitest run tests/offline-shell-plugin.test.ts`
Expected: FAIL — cannot resolve `../scripts/vite-plugin-offline-shell.mjs`.

- [ ] **Step 3: Implement**

`web/scripts/vite-plugin-offline-shell.mjs`:

```js
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Builds the service worker source from the template and the emitted bundle.
 * Exported separately from the plugin so it can be unit tested without Vite.
 *
 * The hash covers the asset name set, so any rebuild that changes a chunk name
 * produces a new cache generation and the activate handler drops the old one.
 */
export function buildServiceWorker(template, bundle) {
  const fileNames = Object.keys(bundle).sort();
  const buildHash = createHash("sha256").update(JSON.stringify(fileNames)).digest("hex").slice(0, 16);

  // Precache the document plus everything under /assets/. Root-level files such
  // as /logo.webp are cached on first use by the runtime handler instead; they
  // are not required to render the shell.
  const precache = ["/index.html", ...fileNames.filter((name) => name.startsWith("assets/")).map((name) => `/${name}`)];

  return template.replace("__BUILD_HASH__", buildHash).replace('"__PRECACHE_MANIFEST__"', JSON.stringify(precache));
}

/** Vite plugin emitting dist/sw.js with the built asset manifest inlined. */
export function offlineShell() {
  return {
    name: "memos-offline-shell",
    apply: "build",
    async generateBundle(_options, bundle) {
      const template = await readFile(resolve(here, "sw.template.js"), "utf8");
      // The worker imports its routing decisions as a module, so ship that file
      // alongside it rather than inlining.
      const routing = await readFile(resolve(here, "sw-routing.mjs"), "utf8");

      this.emitFile({ type: "asset", fileName: "sw-routing.mjs", source: routing });
      this.emitFile({ type: "asset", fileName: "sw.js", source: buildServiceWorker(template, bundle) });
    },
  };
}
```

Wire it into `web/vite.config.mts`:

```ts
import { offlineShell } from "./scripts/vite-plugin-offline-shell.mjs";
```

and add `offlineShell()` to the `plugins` array, after `tailwindcss()`.

The worker's `import ... from "./sw-routing.mjs"` resolves against the emitted sibling file. `sw.js` is served from the origin root, so the relative specifier resolves to `/sw-routing.mjs`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && pnpm vitest run tests/offline-shell-plugin.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Verify the real build emits a valid worker**

Run: `cd web && pnpm build`
Then: `node --check server/frontend/dist/sw.js && head -c 300 server/frontend/dist/sw.js`
Expected: no syntax error, and the source shows a real hash and a `["/index.html","/assets/..."]` array. `node --check` on a module containing `import` requires the file to be treated as ESM; if it errors on the import, re-run as `node --input-type=module --check < server/frontend/dist/sw.js`.

Also confirm the file is embedded and served:

Run: `go test ./server/frontend/... -run CacheHeader -v`
Expected: PASS, including the `/sw.js` case from Task 3.

- [ ] **Step 6: Commit**

```bash
git add web/scripts/vite-plugin-offline-shell.mjs web/vite.config.mts web/tests/offline-shell-plugin.test.ts
git commit -m "feat(web): emit sw.js with the built asset manifest at build time"
```

---

### Task 7: Offline key/value store

**Files:**
- Create: `web/src/lib/offline-store.ts`
- Test: `web/tests/offline-store.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface OfflineStore { get<T>(key: string): Promise<T | undefined>; set(key: string, value: unknown): Promise<void>; remove(key: string): Promise<void>; keys(): Promise<string[]>; clear(): Promise<void> }`
  - `createIndexedDbStore(databaseName: string): OfflineStore`
  - `createMemoryStore(): OfflineStore`
  - `isOfflineStoreAvailable(): boolean`

IndexedDB is behind this interface deliberately: jsdom does not implement it and `fake-indexeddb` would be a new dev dependency, which the global constraints forbid. Tests use `createMemoryStore()`; the IndexedDB implementation is thin enough to verify manually.

- [ ] **Step 1: Write the failing test**

`web/tests/offline-store.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createMemoryStore, isOfflineStoreAvailable } from "@/lib/offline-store";

describe("offline store", () => {
  it("round-trips a value by key", async () => {
    const store = createMemoryStore();

    await store.set("a", { memos: [1, 2] });

    expect(await store.get("a")).toEqual({ memos: [1, 2] });
  });

  it("returns undefined for a missing key", async () => {
    const store = createMemoryStore();

    expect(await store.get("nope")).toBeUndefined();
  });

  it("removes a single key and lists the rest", async () => {
    const store = createMemoryStore();
    await store.set("a", 1);
    await store.set("b", 2);

    await store.remove("a");

    expect(await store.keys()).toEqual(["b"]);
  });

  it("clears everything", async () => {
    const store = createMemoryStore();
    await store.set("a", 1);

    await store.clear();

    expect(await store.keys()).toEqual([]);
  });

  it("reports availability without throwing when IndexedDB is absent", () => {
    expect(typeof isOfflineStoreAvailable()).toBe("boolean");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && pnpm vitest run tests/offline-store.test.ts`
Expected: FAIL — cannot resolve `@/lib/offline-store`.

- [ ] **Step 3: Implement**

`web/src/lib/offline-store.ts`:

```ts
export interface OfflineStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
  clear(): Promise<void>;
}

const STORE_NAME = "offline";

/** False in private browsing modes and older browsers where indexedDB is absent. */
export function isOfflineStoreAvailable(): boolean {
  try {
    return typeof indexedDB !== "undefined";
  } catch {
    return false;
  }
}

function openDatabase(databaseName: string): Promise<IDBDatabase> {
  return new Promise((resolvePromise, rejectPromise) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolvePromise(request.result);
    request.onerror = () => rejectPromise(request.error);
  });
}

function run<T>(databaseName: string, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDatabase(databaseName).then(
    (database) =>
      new Promise<T>((resolvePromise, rejectPromise) => {
        const transaction = database.transaction(STORE_NAME, mode);
        const request = action(transaction.objectStore(STORE_NAME));
        request.onsuccess = () => resolvePromise(request.result);
        request.onerror = () => rejectPromise(request.error);
        transaction.oncomplete = () => database.close();
      }),
  );
}

/**
 * IndexedDB-backed store. Values are written by structured clone, which handles
 * the plain objects @bufbuild/protobuf's create() produces, so no JSON
 * round-trip is needed.
 */
export function createIndexedDbStore(databaseName: string): OfflineStore {
  return {
    get: <T>(key: string) =>
      run<T | undefined>(databaseName, "readonly", (store) => store.get(key) as IDBRequest<T | undefined>).catch(() => undefined),
    set: (key, value) => run(databaseName, "readwrite", (store) => store.put(value, key)).then(() => undefined),
    remove: (key) => run(databaseName, "readwrite", (store) => store.delete(key)).then(() => undefined),
    keys: () => run(databaseName, "readonly", (store) => store.getAllKeys()).then((keys) => keys.map(String)),
    clear: () => run(databaseName, "readwrite", (store) => store.clear()).then(() => undefined),
  };
}

/** In-memory implementation for tests; jsdom has no IndexedDB. */
export function createMemoryStore(): OfflineStore {
  const values = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    set: async (key, value) => void values.set(key, value),
    remove: async (key) => void values.delete(key),
    keys: async () => [...values.keys()],
    clear: async () => void values.clear(),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && pnpm vitest run tests/offline-store.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/offline-store.ts web/tests/offline-store.test.ts
git commit -m "feat(web): add IndexedDB-backed offline key/value store"
```

---

### Task 8: Query cache persistence

**Files:**
- Create: `web/src/lib/query-persistence.ts`
- Test: `web/tests/query-persistence.test.ts`

**Interfaces:**
- Consumes: `OfflineStore` from `@/lib/offline-store`; `dehydrate`, `hydrate`, `QueryClient`, `type DehydratedState`, `type QueryKey` from `@tanstack/react-query`.
- Produces:
  - `PERSISTED_QUERY_ROOTS: readonly string[]`
  - `isPersistableQueryKey(key: QueryKey): boolean`
  - `persistedCacheKey(userName: string | undefined): string`
  - `saveQueryCache(client: QueryClient, store: OfflineStore, userName: string | undefined): Promise<void>`
  - `restoreQueryCache(client: QueryClient, store: OfflineStore, userName: string | undefined): Promise<boolean>`
  - `removeQueryCache(store: OfflineStore, userName: string | undefined): Promise<void>`
  - `removeAllQueryCaches(store: OfflineStore): Promise<void>`
  - `PERSISTED_CACHE_MAX_AGE_MS: number`

- [ ] **Step 1: Write the failing tests**

`web/tests/query-persistence.test.ts`:

```ts
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryStore } from "@/lib/offline-store";
import {
  PERSISTED_CACHE_MAX_AGE_MS,
  isPersistableQueryKey,
  persistedCacheKey,
  removeAllQueryCaches,
  removeQueryCache,
  restoreQueryCache,
  saveQueryCache,
} from "@/lib/query-persistence";

let store: ReturnType<typeof createMemoryStore>;

beforeEach(() => {
  store = createMemoryStore();
});

describe("query key allowlist", () => {
  it("accepts the content roots and rejects everything else", () => {
    expect(isPersistableQueryKey(["memos", "list"])).toBe(true);
    expect(isPersistableQueryKey(["memos", "detail", "memos/1"])).toBe(true);
    expect(isPersistableQueryKey(["spaces", "list"])).toBe(true);
    expect(isPersistableQueryKey(["attachments", "list"])).toBe(true);
    expect(isPersistableQueryKey(["users", "current"])).toBe(true);
    expect(isPersistableQueryKey(["instance", "profile"])).toBe(true);
    // Default-deny: an unknown root must not be written to disk.
    expect(isPersistableQueryKey(["somethingNew"])).toBe(false);
    expect(isPersistableQueryKey([])).toBe(false);
  });
});

describe("per-user scoping", () => {
  it("uses a distinct key per user", () => {
    expect(persistedCacheKey("users/1")).not.toBe(persistedCacheKey("users/2"));
  });

  it("does not leak one user's cache into another's restore", async () => {
    const writer = new QueryClient();
    writer.setQueryData(["memos", "detail", "memos/1"], { name: "memos/1", content: "alice secret" });
    await saveQueryCache(writer, store, "users/1");

    const reader = new QueryClient();
    const restored = await restoreQueryCache(reader, store, "users/2");

    expect(restored).toBe(false);
    expect(reader.getQueryData(["memos", "detail", "memos/1"])).toBeUndefined();
  });

  it("removes only the named user's cache", async () => {
    const client = new QueryClient();
    client.setQueryData(["memos", "detail", "memos/1"], { name: "memos/1" });
    await saveQueryCache(client, store, "users/1");
    await saveQueryCache(client, store, "users/2");

    await removeQueryCache(store, "users/1");

    expect(await store.keys()).toEqual([persistedCacheKey("users/2")]);
  });

  it("removes every cache on logout", async () => {
    const client = new QueryClient();
    client.setQueryData(["memos", "detail", "memos/1"], { name: "memos/1" });
    await saveQueryCache(client, store, "users/1");

    await removeAllQueryCaches(store);

    expect(await store.keys()).toEqual([]);
  });
});

describe("round trip", () => {
  it("restores persisted memo data into a fresh client", async () => {
    const writer = new QueryClient();
    writer.setQueryData(["memos", "detail", "memos/1"], { name: "memos/1", content: "hello" });
    await saveQueryCache(writer, store, "users/1");

    const reader = new QueryClient();
    const restored = await restoreQueryCache(reader, store, "users/1");

    expect(restored).toBe(true);
    expect(reader.getQueryData(["memos", "detail", "memos/1"])).toEqual({ name: "memos/1", content: "hello" });
  });

  it("drops non-allowlisted queries", async () => {
    const writer = new QueryClient();
    writer.setQueryData(["memos", "detail", "memos/1"], { name: "memos/1" });
    writer.setQueryData(["somethingNew", "x"], { secret: true });
    await saveQueryCache(writer, store, "users/1");

    const reader = new QueryClient();
    await restoreQueryCache(reader, store, "users/1");

    expect(reader.getQueryData(["memos", "detail", "memos/1"])).toBeDefined();
    expect(reader.getQueryData(["somethingNew", "x"])).toBeUndefined();
  });

  it("marks restored queries stale so online always wins", async () => {
    const writer = new QueryClient();
    writer.setQueryData(["memos", "detail", "memos/1"], { name: "memos/1" });
    await saveQueryCache(writer, store, "users/1");

    const reader = new QueryClient();
    await restoreQueryCache(reader, store, "users/1");

    const state = reader.getQueryState(["memos", "detail", "memos/1"]);
    expect(state?.isInvalidated).toBe(true);
  });

  it("refuses a cache older than the maximum age", async () => {
    const writer = new QueryClient();
    writer.setQueryData(["memos", "detail", "memos/1"], { name: "memos/1" });
    await saveQueryCache(writer, store, "users/1");

    const aged = (await store.get<{ savedAt: number }>(persistedCacheKey("users/1"))) as { savedAt: number };
    await store.set(persistedCacheKey("users/1"), { ...aged, savedAt: aged.savedAt - PERSISTED_CACHE_MAX_AGE_MS - 1 });

    const reader = new QueryClient();
    expect(await restoreQueryCache(reader, store, "users/1")).toBe(false);
  });

  it("survives a store that throws instead of breaking the app", async () => {
    const broken = {
      ...store,
      get: async () => {
        throw new Error("QuotaExceededError");
      },
    };
    const reader = new QueryClient();

    await expect(restoreQueryCache(reader, broken, "users/1")).resolves.toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && pnpm vitest run tests/query-persistence.test.ts`
Expected: FAIL — cannot resolve `@/lib/query-persistence`.

- [ ] **Step 3: Confirm the core API surface before implementing**

`dehydrate`/`hydrate` must come from `@tanstack/react-query` itself, since `@tanstack/react-query-persist-client` is not a dependency and adding it is out of scope.

Run: `cd web && node -e "const q=require('@tanstack/react-query'); console.log(typeof q.dehydrate, typeof q.hydrate)"`
Expected: `function function`. If either prints `undefined`, stop — the plan's zero-dependency constraint needs revisiting before this task continues.

- [ ] **Step 4: Implement**

`web/src/lib/query-persistence.ts`:

```ts
import { type DehydratedState, dehydrate, hydrate, type QueryClient, type QueryKey } from "@tanstack/react-query";
import type { OfflineStore } from "@/lib/offline-store";

/**
 * Allowlist of query roots written to disk. Default-deny, so a new query type is
 * not silently persisted: it must be added here on purpose.
 *
 * Roots mirror the key factories: memoKeys, spaceKeys, attachmentKeys, userKeys
 * and instanceKeys each begin with one of these.
 */
export const PERSISTED_QUERY_ROOTS = ["memos", "spaces", "attachments", "users", "instance"] as const;

/** Hard ceiling on a restored cache. Bounds how long a memo whose access was
 * revoked on another device can linger offline. */
export const PERSISTED_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const KEY_PREFIX = "memos-query-cache:";

interface PersistedCache {
  savedAt: number;
  state: DehydratedState;
}

export function isPersistableQueryKey(key: QueryKey): boolean {
  const root = key[0];
  return typeof root === "string" && (PERSISTED_QUERY_ROOTS as readonly string[]).includes(root);
}

/** Per-user so a second account on the same browser cannot read the first's cache. */
export function persistedCacheKey(userName: string | undefined): string {
  return `${KEY_PREFIX}${userName ?? "anonymous"}`;
}

export async function saveQueryCache(client: QueryClient, store: OfflineStore, userName: string | undefined): Promise<void> {
  try {
    const state = dehydrate(client, {
      shouldDehydrateQuery: (query) => isPersistableQueryKey(query.queryKey) && query.state.status === "success",
      shouldDehydrateMutation: () => false,
    });
    const payload: PersistedCache = { savedAt: Date.now(), state };
    await store.set(persistedCacheKey(userName), payload);
  } catch (error) {
    // Quota exceeded, private browsing, or a value structured clone rejects.
    // Offline caching is an enhancement; it must never break the live app.
    console.warn("Failed to persist query cache:", error);
  }
}

/** Returns true when a cache was restored. Restored queries are invalidated so
 * an online client refetches immediately and the cache only ever serves as a
 * fallback. */
export async function restoreQueryCache(
  client: QueryClient,
  store: OfflineStore,
  userName: string | undefined,
): Promise<boolean> {
  try {
    const persisted = await store.get<PersistedCache>(persistedCacheKey(userName));
    if (!persisted) return false;
    if (Date.now() - persisted.savedAt > PERSISTED_CACHE_MAX_AGE_MS) {
      await store.remove(persistedCacheKey(userName));
      return false;
    }

    hydrate(client, persisted.state);
    for (const { queryKey } of persisted.state.queries) {
      client.invalidateQueries({ queryKey });
    }
    return true;
  } catch (error) {
    console.warn("Failed to restore query cache:", error);
    return false;
  }
}

export async function removeQueryCache(store: OfflineStore, userName: string | undefined): Promise<void> {
  try {
    await store.remove(persistedCacheKey(userName));
  } catch (error) {
    console.warn("Failed to remove query cache:", error);
  }
}

export async function removeAllQueryCaches(store: OfflineStore): Promise<void> {
  try {
    for (const key of await store.keys()) {
      if (key.startsWith(KEY_PREFIX)) await store.remove(key);
    }
  } catch (error) {
    console.warn("Failed to clear query caches:", error);
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd web && pnpm vitest run tests/query-persistence.test.ts`
Expected: PASS, 11 tests.

If `shouldDehydrateQuery` or `shouldDehydrateMutation` are not accepted option names in this React Query version, run `cd web && node -e "console.log(require('@tanstack/react-query/package.json').version)"` and check that version's `DehydrateOptions` type in `node_modules/@tanstack/query-core/build/modern/hydration-*.d.ts`. Adjust the option names to match; do not silently drop the filter, since the allowlist is a security control.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/query-persistence.ts web/tests/query-persistence.test.ts
git commit -m "feat(web): persist the React Query cache to IndexedDB per user"
```

---

### Task 9: Bootstrap — restore before render, register the worker

**Files:**
- Modify: `web/src/main.tsx`
- Create: `web/src/lib/service-worker-registration.ts`
- Test: `web/tests/service-worker-registration.test.ts`

**Interfaces:**
- Consumes: `createIndexedDbStore`, `isOfflineStoreAvailable` from `@/lib/offline-store`; `restoreQueryCache`, `saveQueryCache` from `@/lib/query-persistence`; `queryClient` from `@/lib/query-client`; `getStoredOfflineUserName` from `@/lib/offline-session`.
- Produces:
  - `registerOfflineWorker(): Promise<void>`
  - `restorePersistedQueries(): Promise<boolean>`
  - `startQueryCachePersistence(userName: string | undefined): () => void` — returns a stop function.

- [ ] **Step 1: Write the failing test**

`web/tests/service-worker-registration.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && pnpm vitest run tests/service-worker-registration.test.ts`
Expected: FAIL — cannot resolve `@/lib/service-worker-registration`.

- [ ] **Step 3: Implement the registration module**

`web/src/lib/service-worker-registration.ts`:

```ts
/**
 * Registers the offline app shell worker. Deliberately inert when service
 * workers are unsupported or the context is not secure, so plain-HTTP
 * development and older browsers keep working unchanged.
 */
export async function registerOfflineWorker(): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  if (typeof window === "undefined" || !window.isSecureContext) return;

  try {
    await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    // Without this, Android Chrome may evict Cache Storage and IndexedDB under
    // storage pressure, silently reintroducing the failure this worker prevents.
    if (navigator.storage?.persist) {
      const granted = await navigator.storage.persist();
      if (!granted) console.warn("Persistent storage was not granted; offline cache may be evicted.");
    }
  } catch (error) {
    // A failed registration must not break the live app.
    console.warn("Service worker registration failed:", error);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && pnpm vitest run tests/service-worker-registration.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Wire restore and persistence into `main.tsx`**

The cache must be restored **before** `root.render`, or the first paint shows an empty app that then fills in. Add above the existing `const container = document.getElementById("root")`:

```ts
import { getStoredOfflineUserName } from "@/lib/offline-session";
import { isOfflineStoreAvailable, createIndexedDbStore } from "@/lib/offline-store";
import { restoreQueryCache, saveQueryCache } from "@/lib/query-persistence";
import { registerOfflineWorker } from "@/lib/service-worker-registration";

const offlineStore = isOfflineStoreAvailable() ? createIndexedDbStore("memos-offline") : undefined;

/**
 * Rehydrates the persisted query cache before first render. Restored entries are
 * invalidated, so an online client refetches immediately and the cache only ever
 * acts as a fallback — every online read stays a live query.
 */
async function bootstrap(): Promise<void> {
  if (offlineStore) {
    await restoreQueryCache(queryClient, offlineStore, getStoredOfflineUserName());
  }

  const container = document.getElementById("root");
  const root = createRoot(container as HTMLElement);
  root.render(<Main />);

  // Register after load so the worker install does not compete with first paint.
  window.addEventListener("load", () => {
    void registerOfflineWorker();
  });
}

void bootstrap();
```

Replace the existing three-line render block at the bottom of `main.tsx` with the `bootstrap()` call above.

Persist on change, debounced, from inside `AppInitializer` so it only runs once identity is known. Add to `AppInitializer`:

```ts
  // Write the cache back after identity settles and whenever it changes, so the
  // persisted copy is always scoped to the signed-in user.
  useEffect(() => {
    if (!offlineStore || !currentUser) return;
    const timer = window.setInterval(() => {
      void saveQueryCache(queryClient, offlineStore, currentUser.name);
    }, 30_000);
    const flush = () => void saveQueryCache(queryClient, offlineStore, currentUser?.name);
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", flush);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flush);
    };
  }, [currentUser]);
```

The `visibilitychange` listener fires on both hide and show; `saveQueryCache` is idempotent and debounced by its own cost, so an extra write is harmless. Keep it simple rather than adding a state check.

- [ ] **Step 6: Clear persisted caches on logout**

In `AuthContext.logout`, alongside the `clearOfflineSession()` added in Task 2, also drop every user's query cache and the attachment cache. Import `removeAllQueryCaches` from `@/lib/query-persistence` and export a `clearAttachmentCache()` helper from `@/lib/service-worker-registration`:

```ts
/** Drops cached attachment bytes. Cache Storage is per-origin, so private
 * attachments fetched for one account must not outlive that account's session. */
export async function clearAttachmentCache(): Promise<void> {
  if (typeof caches === "undefined") return;
  try {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith("memos-attachments-")).map((key) => caches.delete(key)));
  } catch (error) {
    console.warn("Failed to clear attachment cache:", error);
  }
}
```

In `logout`'s `finally` block:

```ts
      clearOfflineSession();
      void removeAllQueryCaches(offlineStore);
      void clearAttachmentCache();
```

`offlineStore` must be reachable from `AuthContext`. Export it from a new `web/src/lib/offline-store-instance.ts` that holds the single `createIndexedDbStore("memos-offline")` value, and import it in both `main.tsx` and `AuthContext.tsx` so there is exactly one database handle.

- [ ] **Step 7: Run the suite**

Run: `cd web && pnpm lint && pnpm test`
Expected: PASS. Existing `main.tsx`-dependent tests may need the new bootstrap shape; if a test imports `main.tsx` directly, adjust it to await `bootstrap`.

- [ ] **Step 8: Commit**

```bash
git add web/src/main.tsx web/src/lib/service-worker-registration.ts web/src/lib/offline-store-instance.ts web/src/contexts/AuthContext.tsx web/tests/service-worker-registration.test.ts
git commit -m "feat(web): restore the offline cache before render and register the worker"
```

---

### Task 10: Offline banner and mutation guard

**Files:**
- Create: `web/src/components/OfflineBanner.tsx`
- Modify: `web/src/layouts/` — mount the banner in the authenticated layout that already renders global chrome
- Modify: `web/src/hooks/useMemoQueries.ts` (`useCreateMemo`, `useUpdateMemo`, `useDeleteMemo`)
- Test: `web/tests/offline-mutation-guard.test.ts`

**Interfaces:**
- Consumes: `isOffline` from `useAuth()`; `useSSEConnectionStatus` from `@/hooks/useLiveMemoRefresh`; `cn` from `@/lib/utils`.
- Produces: `isWriteBlocked(): boolean` exported from `web/src/lib/offline-state.ts`, used by all three memo mutations.

- [ ] **Step 1: Write the failing test**

`web/tests/offline-mutation-guard.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import { isWriteBlocked, setNavigatorOnline } from "@/lib/offline-state";

describe("isWriteBlocked", () => {
  beforeEach(() => {
    setNavigatorOnline(true);
  });

  it("allows writes while online", () => {
    expect(isWriteBlocked()).toBe(false);
  });

  it("blocks writes while the browser reports no connection", () => {
    setNavigatorOnline(false);
    expect(isWriteBlocked()).toBe(true);
  });
});
```

`setNavigatorOnline` exists so the predicate is testable without mutating the global; it writes to a module-level override that `online`/`offline` events keep current.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && pnpm vitest run tests/offline-mutation-guard.test.ts`
Expected: FAIL — cannot resolve `@/lib/offline-state`.

- [ ] **Step 3: Implement**

`web/src/lib/offline-state.ts`:

```ts
let override: boolean | undefined;

if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    override = true;
  });
  window.addEventListener("offline", () => {
    override = false;
  });
}

/** Test seam: forces the reported connectivity without touching the global. */
export function setNavigatorOnline(online: boolean): void {
  override = online;
}

/**
 * True when a mutation cannot possibly reach the server.
 *
 * useUpdateMemo applies an optimistic patch in onMutate and rolls it back in
 * onError, so an offline edit visibly appears and then vanishes. Blocking up
 * front turns that silent revert into an explicit refusal.
 */
export function isWriteBlocked(): boolean {
  if (override !== undefined) return !override;
  return typeof navigator !== "undefined" && navigator.onLine === false;
}
```

Guard each mutation in `web/src/hooks/useMemoQueries.ts`. In `useCreateMemo`, `useUpdateMemo` and `useDeleteMemo`, at the top of `mutationFn`:

```ts
      if (isWriteBlocked()) {
        throw new ConnectError("You are offline. Reconnect to save this change.", Code.Unavailable);
      }
```

`ConnectError` and `Code` are already imported in that file. Throwing from `mutationFn` before any network call means `useUpdateMemo`'s `onMutate` still runs; move the guard into `onMutate` as well for that hook specifically, returning early with `{ previousMemo: undefined }` so no optimistic patch is applied:

```ts
    onMutate: async ({ update, updateMask }) => {
      if (isWriteBlocked()) return { previousMemo: undefined };
      if (updateMask.includes("space")) return { previousMemo: undefined };
```

Create `web/src/components/OfflineBanner.tsx` following existing banner patterns in `web/src/components/`, reading `isOffline` from `useAuth()` and `useSSEConnectionStatus()`, with copy from the locale files via `useTranslate()`. Add the `offlineBanner` key to `web/src/locales/en.json` and mirror it in the other locale files as an English fallback, per the existing convention in that directory.

Mount it in the authenticated layout so it appears above memo lists.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && pnpm vitest run tests/offline-mutation-guard.test.ts && pnpm lint && pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/offline-state.ts web/src/components/OfflineBanner.tsx web/src/hooks/useMemoQueries.ts web/src/locales web/tests/offline-mutation-guard.test.ts
git commit -m "feat(web): show an offline banner and refuse writes instead of rolling them back"
```

---

### Task 11: Surface offline storage usage

**Files:**
- Modify: `web/src/components/Settings/ResourceStatsSection.tsx`
- Test: `web/tests/offline-storage-usage.test.tsx`

**Interfaces:**
- Consumes: `navigator.storage.estimate()` and `navigator.storage.persisted()`.
- Produces: `readOfflineStorageUsage(): Promise<{ usage: number; quota: number; persisted: boolean } | undefined>` in `web/src/lib/offline-store.ts`.

- [ ] **Step 1: Write the failing test**

`web/tests/offline-storage-usage.test.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OfflineStorageStats } from "@/components/Settings/OfflineStorageStats";

describe("OfflineStorageStats", () => {
  it("reports usage and whether persistence was granted", async () => {
    vi.stubGlobal("navigator", {
      storage: {
        estimate: vi.fn(async () => ({ usage: 5 * 1024 * 1024, quota: 1024 * 1024 * 1024 })),
        persisted: vi.fn(async () => true),
      },
    });

    render(<OfflineStorageStats />);

    await waitFor(() => expect(screen.getByTestId("offline-usage")).toHaveTextContent("5"));
    expect(screen.getByTestId("offline-persisted")).toHaveTextContent("yes");
  });

  it("renders nothing when the API is unavailable", async () => {
    vi.stubGlobal("navigator", {});

    const { container } = render(<OfflineStorageStats />);

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && pnpm vitest run tests/offline-storage-usage.test.tsx`
Expected: FAIL — cannot resolve `OfflineStorageStats`.

- [ ] **Step 3: Implement**

Add to `web/src/lib/offline-store.ts`:

```ts
export interface OfflineStorageUsage {
  usage: number;
  quota: number;
  persisted: boolean;
}

/**
 * Storage held for this origin, or undefined when the API is absent. With no cap
 * on memo count, eviction would otherwise be invisible — this is where the user
 * finds out the cache is large or that persistence was refused.
 */
export async function readOfflineStorageUsage(): Promise<OfflineStorageUsage | undefined> {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) return undefined;
  try {
    const [estimate, persisted] = await Promise.all([
      navigator.storage.estimate(),
      navigator.storage.persisted ? navigator.storage.persisted() : Promise.resolve(false),
    ]);
    return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0, persisted };
  } catch {
    return undefined;
  }
}
```

Create `web/src/components/Settings/OfflineStorageStats.tsx` reading that helper, formatting bytes with the existing formatter used elsewhere in `ResourceStatsSection.tsx`, and rendering nothing when it returns `undefined`. Mount it inside `ResourceStatsSection.tsx` next to the existing statistics.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && pnpm vitest run tests/offline-storage-usage.test.tsx && pnpm lint && pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/offline-store.ts web/src/components/Settings/OfflineStorageStats.tsx web/src/components/Settings/ResourceStatsSection.tsx web/tests/offline-storage-usage.test.tsx
git commit -m "feat(web): show offline cache size and persistence status in settings"
```

---

### Task 12: End-to-end verification

**Files:** none — verification only.

- [ ] **Step 1: Full frontend and backend checks**

Run: `cd web && pnpm lint && pnpm test && pnpm build`
Expected: all pass, and `server/frontend/dist/sw.js` plus `sw-routing.mjs` exist.

Run: `go test ./server/frontend/... && go test ./server/...`
Expected: PASS.

Run: `golangci-lint run`
Expected: no new findings.

- [ ] **Step 2: Verify the shell survives an offline cold load**

Serve the built binary, open the site in Chrome over HTTPS (or `localhost`), sign in, load the memo feed and open one memo with an image. Then in DevTools → Application → Service Workers confirm the worker is activated, and in Network select **Offline**. Reload.

Expected: the app renders, the memo list shows previously-read memos with no spinner, images that were already viewed render, an offline banner is visible, and the browser's own error page never appears.

- [ ] **Step 3: Verify live queries still win when online**

With the network restored, create a memo from a second device. Expected: it appears on the first device without a manual reload — SSE and `refetchOnReconnect` still drive freshness, and the persisted cache never masks a newer server state.

- [ ] **Step 4: Verify no stale API response can be served**

In DevTools → Network, confirm every `/memos.api.v1.*` and `/api/*` request shows `(ServiceWorker)` absent from its initiator while online. No API request may be answered from cache at any time.

- [ ] **Step 5: Verify account isolation**

Sign out, confirm IndexedDB `memos-offline` has no `memos-query-cache:*` entries and no `memos-attachments-*` cache remains, then sign in as a different user and confirm none of the first user's memos appear.

- [ ] **Step 6: Verify the expired-token overnight case**

Sign in, then manually set `memos_token_expires_at` in localStorage to a past timestamp, switch DevTools to Offline, and reload. Expected: the app restores the session and shows cached memos rather than redirecting to `/auth`.

- [ ] **Step 7: Verify on the real device**

On the Android phone, through the Cloudflare domain: load the app signed in, then enable airplane mode and cold-load from the home screen or a fresh tab. Expected: shell renders, memos and previously-viewed images are readable read-only, writes are refused with an explicit message.

- [ ] **Step 8: Verify a deploy replaces the worker**

Change any frontend source, rebuild, redeploy. On the phone, reload twice. Expected: DevTools → Application shows the new build hash in the cache names, old `memos-shell-*` entries are gone, and the change is visible without clearing site data — confirming Cloudflare is not pinning the old `sw.js`.

- [ ] **Step 9: Commit any fixes**

```bash
git add -A
git commit -m "test(web): verify offline caching end to end"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: defect 1 → Tasks 5-6, 9; defect 2 → Tasks 1-2; defect 3 → Task 2 (settings restored, unblocking `isDisplayPending`); Phase 2 routing and attachment caching → Tasks 4-5; Phase 3 allowlist, per-user scoping, max age, no count cap, storage estimate → Tasks 7-9, 11; Phase 4 → Task 3; offline UX and the `useUpdateMemo` rollback stopgap → Task 10; testing section → Tasks 1-11 unit tests plus Task 12 manual. The spec's deferred write queue is out of scope here and stays deferred.

**Placeholder scan.** No TBD or "handle edge cases" steps. The OfflineBanner copy and its exact mount point in `web/src/layouts/` are described rather than spelled out, because the layout file was not read while writing this plan — the implementer must open `web/src/layouts/`, pick the component that already renders global chrome for authenticated routes, and follow the existing banner patterns in `web/src/components/`. That is a locate-and-follow instruction, not a design gap.

**Type consistency.** `OfflineStore`, `OfflineSession`, `OfflineSessionSettings`, `persistedCacheKey`, `isPersistableQueryKey`, `saveQueryCache`, `restoreQueryCache`, `removeAllQueryCaches`, `isWriteBlocked`, `setNavigatorOnline`, `readOfflineStorageUsage`, `buildServiceWorker`, `offlineShell`, `registerOfflineWorker`, `clearAttachmentCache`, `getStoredOfflineUserName` and `isOffline` are used with the same names and signatures in every task that references them. `ATTACHMENT_CACHE_CAP_BYTES` and `selectEvictions` match between Tasks 4 and 5. Cache name prefixes `memos-shell-` / `memos-attachments-` match between Tasks 5 and 9.

**Review Focus coverage.** All five lines have an owning test: expired-token-plus-offline → Task 2 Step 1; second account on one browser → Task 8 Step 1 and Task 9 Step 6; IndexedDB unavailable or over quota → Task 8 Step 1 (`survives a store that throws`) and Task 7's `isOfflineStoreAvailable`; silent eviction → Task 11 Step 1; revoked access lingering → Task 8 Step 1 (`refuses a cache older than the maximum age`) plus the invalidate-on-restore test.

**Known open risk.** Step 3 of Task 8 is a hard gate: if `dehydrate`/`hydrate` are not exported from `@tanstack/react-query` in the installed version, the zero-dependency constraint fails and the plan needs a decision before continuing. It is a verification step rather than an assumption so the failure surfaces immediately instead of midway through the task.
