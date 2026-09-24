# Offline Client-Side Caching

Date: 2026-09-24
Status: proposed

## Problem

An unstable connection makes the web client fail completely. A cold load on a device that
visited minutes earlier renders the browser's own "disconnected" error page, with no part of
the app and no previously-read memos available.

Three independent defects stack to produce this. Fixing only the caching layer would not fix
the reported symptom.

### 1. Nothing is cached, so the shell cannot load

No service worker is registered anywhere in `web/src` or `web/index.html`. `site.webmanifest`
exists but is inert. `server/frontend/frontend.go:24` serves `index.html` as
`no-cache, no-store, must-revalidate`, so the browser HTTP cache holds nothing to fall back
to. Offline, there is no document to render.

### 2. An offline load logs the user out

`web/src/contexts/AuthContext.tsx:141-145`:

```ts
} catch (error) {
  console.error("Failed to initialize auth:", error);
  clearAccessToken();
  setState(UNAUTHENTICATED_STATE);
}
```

`getCurrentUser({})` fails offline with `Code.Unavailable` — this repo's established
network-failure signal (`web/src/components/MemoEditor/services/uploadService.ts:49` and
`web/src/lib/memo-export.ts:32` both retry specifically on that code). This catch never
inspects the code, so a network blip is treated identically to a rejected credential: the
access token is removed from `localStorage`, state becomes unauthenticated, and
`RequireAuthRoute` (`web/src/router/guards.tsx:52`) navigates to `/auth`.

This is a live bug independent of offline caching: any connection drop during app init logs
the user out today. The rest of the codebase draws this distinction correctly —
`shouldHandleUnauthenticatedRetry` in `web/src/connect.ts` acts only on `Code.Unauthenticated`,
and `useTokenRefreshOnFocus` deliberately does not clear the token when a refresh fails.
`AuthContext.initialize()` is the outlier.

The same early-return path is affected: when `getAccessToken()` returns null because the
stored token is expired, `refreshAccessToken()` fails offline and is swallowed, then
`if (!getAccessToken())` sets `UNAUTHENTICATED_STATE`. An expired token plus no connectivity
is indistinguishable from a logged-out user.

### 3. Memo display is gated on a network-only flag

`web/src/components/PagedMemoList/PagedMemoList.tsx:167`:

```ts
const isDisplayPending = isLoading || !isUserSettingsInitialized;
```

`isUserSettingsInitialized` becomes true only inside `fetchUserSettings()`, which calls
`listUserSettings` over the network (`AuthContext.tsx:59-84`). Offline it never settles, so
memo content stays withheld behind the loader. The same gate appears in
`CalendarView.tsx:85`, `MapView/useMapMemos.ts:25`, and `MemoPanelList.tsx:87`.

A service worker and a fully populated offline cache would therefore still present a
permanent spinner. Restoring user settings is a prerequisite, not an enhancement.

`InstanceContext.initialize()` is already correct: its `.catch` sets
`isProfileInitialized: true` and degrades without blocking.

## Goal

On a device that has visited recently, a cold load with no connectivity renders the app shell
and the signed-in user's memos, read-only, with a visible offline indicator.

Online behaviour is unchanged. Every read remains a live query: the cache is a fallback for
when the network fails, never a substitute for fresh data. The design enforces this
structurally — the service worker never intercepts API routes, so no code path can serve a
stale API response.

## Non-goals (v1)

- Offline write queue, deferred sync, and conflict resolution. Multiple devices edit the same
  memos, so this needs real conflict handling rather than last-write-wins. Deferred to a
  separate design.
- Attachment binary caching. v1 ships without it; see Open decisions for whether to revisit.
- Background Sync API and push. Poor Safari support, and unnecessary without writes.

## Existing behaviour to preserve

- Unsent editor text already survives reloads: `MemoEditor/services/cacheService.ts` writes
  drafts to `localStorage`, debounced, flushed on `pagehide` and `visibilitychange`.
- `refetchOnReconnect: true` is already set in `web/src/lib/query-client.ts`, so recovery on
  reconnect needs no new work.
- `useSSEConnectionStatus` (`web/src/hooks/useLiveMemoRefresh.ts:56`) already publishes
  connection state and is consumed by `UserMenu.tsx:55`. The offline indicator reuses this
  pattern rather than adding a new mechanism.

## Design

The phases are independently shippable and should land in order. Phase 1 alone fixes a live
bug — a connection drop during init logs the user out today — and is worth merging on its own
even if the rest is deferred. Phases 2 and 3 are only useful together: a cached shell with no
persisted data shows an empty app, and persisted data with no cached shell cannot be reached
offline. Phase 4 is a small backend change that makes the rest survivable across deploys.

### Phase 1 — Offline-tolerant session bootstrap

New module `web/src/lib/offline-session.ts` persists the last-known identity and user
settings to `localStorage`, scoped by user name. `AuthContext` writes it whenever identity or
settings settle, and reads it in the offline path.

`AuthContext.initialize()` classifies failures instead of treating all errors alike:

- `Code.Unauthenticated` or `Code.PermissionDenied` — current behaviour: `clearAccessToken()`,
  `UNAUTHENTICATED_STATE`.
- `Code.Unavailable`, or `navigator.onLine === false` — retain the stored token, restore
  persisted identity and settings, set `isIdentityInitialized`, `isUserSettingsInitialized`
  and `isInitialized` all true, and set a new `isOffline` flag on `AuthState`.
- Any other error — do **not** call `clearAccessToken()`, but still set `UNAUTHENTICATED_STATE`,
  so rendering falls back to `/auth` rather than presenting an unverified identity. Retaining
  the token lets a later `initialize()` recover without a fresh sign-in, since an unclassified
  failure is not evidence of a dead session. Nothing re-runs `initialize()` on reconnect today,
  so recovery requires a reload; noted here so that is not later mistaken for a regression.

All three flags must be set. `RequireFullInitializationRoute` (`guards.tsx:16`) gates on
`isInitialized`, and `AppInitializer` in `web/src/main.tsx` gates on `isIdentityInitialized`,
so a partial restore still yields a blank page.

The expired-token path needs the same treatment: when refresh fails on network grounds and a
stored token exists, proceed to offline restore rather than the `!getAccessToken()`
early return.

A restored identity is used only for display gating and cache scoping. It never authorizes a
request — offline, every request fails regardless and all data comes from cache. Once
connectivity returns, normal initialization runs again and replaces the restored state.

### Phase 2 — Service worker app shell

No new dependencies. Two new files, following the existing `web/scripts/` convention:

- `web/scripts/sw.template.js` — the hand-written worker. It cannot live in `web/public/`,
  because public assets are copied verbatim and this one needs the built asset manifest
  substituted into it.
- `web/scripts/vite-plugin-offline-shell.mjs` — a small Vite plugin, wired into
  `web/vite.config.mts`, that reads the emitted bundle, injects the asset URLs and a build
  hash, and writes `dist/sw.js`.

Vite hashes asset filenames, so the worker must learn them at build time rather than
hardcoding them.

Precache at install: `index.html` and the entry assets from the generated manifest. Cache on
success at runtime: lazily-loaded chunks and fonts, which are not knowable ahead of time.
Precaching the shell is what makes an offline cold load work on the first visit after a
deploy, rather than depending on the user having warmed a runtime cache.

Routing:

- Navigation requests (`request.mode === "navigate"`) — network-first, falling back to cached
  `index.html`. Keeps the shell current online and renders offline.
- Same-origin static assets — precache hit, else network then store. Hashed `/assets/*` are
  immutable, so cache-first is safe there.
- Explicit bypass, never intercepted: `/api`, `/memos.api.v1`, `/memos.api.v1.*`, `/file`, and
  the SSE endpoint. This mirrors `shouldSkipFrontendStatic` in `frontend.go:79` and keeps the
  two lists in step.

Cache names carry the build hash; the `activate` handler deletes prior versions. Registration
happens in `main.tsx` after the `load` event, guarded on secure context and feature detection,
so it never competes with first render or breaks non-HTTPS development.

The worker must not buffer or delay `/api/v1/sse`; bypassing it entirely preserves the live
memo refresh behaviour in `useLiveMemoRefresh.ts`.

`navigator.storage.persist()` is requested at registration. Without it, Android Chrome may
evict both Cache Storage and IndexedDB under storage pressure, silently reintroducing the
original failure.

### Phase 3 — Persisted React Query cache

No new dependencies. `web/src/lib/query-persistence.ts` implements TanStack Query's `Persister`
interface (`persistClient`, `restoreClient`, `removeClient`) over IndexedDB. Structured clone
handles the generated protobuf messages directly, since `@bufbuild/protobuf` `create()` produces
plain objects; no JSON round-trip through `toJson`/`fromJson` is required.

Restore completes before first render to avoid an empty-then-populated flash.

Persisted queries are selected by an **allowlist** of key prefixes, not a denylist — memo lists,
memo details, comments, user settings, spaces, and attachment metadata. A default-deny policy
means a new query type is not silently written to disk.

Correctness constraints:

- **Per-user scoping.** `AuthContext.tsx:156` calls `queryClient.clear()` on logout. The
  persisted entry is keyed by user name and removed on logout, so signing in as another user
  cannot resurrect the previous account's memos.
- **Revoked access must not linger.** `discardUnavailableMemo()` in `useMemoQueries.ts:56`
  deliberately strips memos the user can no longer read. With multiple devices, a memo revoked
  elsewhere must not survive in the offline cache. Restored data is marked immediately stale,
  so it is only ever a fallback, and entries carry a hard maximum age (30 days) after which
  they are dropped absent a successful refresh.
- **No count cap.** Per the requirement, every memo ever viewed is retained. Growth is bounded
  by the IndexedDB quota rather than by policy, so eviction must not be silent:
  `navigator.storage.estimate()` is surfaced in Settings alongside the existing resource
  statistics (`web/src/components/Settings/ResourceStatsSection.tsx`).

### Phase 4 — Service worker freshness behind Cloudflare

`sw.js` has a file extension, so `shouldServeFrontendHTML` (`frontend.go:107`) returns false and
it is served `public, max-age=3600` (`frontend.go:25`). Cloudflare edge-caches `.js` by default,
so after a deploy a client could run a stale service worker for an hour or more — and a stale
worker serving a stale shell is the exact failure class this design removes.

Add `frontendServiceWorkerCacheControl = "no-cache"` and special-case `/sw.js` and the
webmanifest in `setFrontendCacheHeaders`, so both Cloudflare and the browser revalidate on every
update check. `/assets/*` keeps `immutable`; those are content-hashed and correct as-is.

Update both table tests in `server/frontend/frontend_test.go` (`CacheHeaderRules` and
`StaticCacheHeaders`).

`Cache-Control: no-store` on `index.html` does not obstruct this work: that directive governs
the HTTP cache, not the Cache Storage API, whose `put()` rejects only non-`http(s)` schemes and
non-200 range responses. The Go HTML headers need no change.

### Offline user experience

An `isOffline` indicator derived from Phase 1 and the existing SSE status. Memo views render
read-only.

Mutations must fail loudly rather than silently revert. `useUpdateMemo` in `useMemoQueries.ts`
applies an optimistic patch in `onMutate` and rolls back in `onError`, so offline an edit
visibly appears and then vanishes. While offline, mutations are blocked up front with an
explicit message. This is a stopgap until the deferred write queue lands.

## Testing

Frontend, in `web/tests/` following the existing flat convention:

- Extend `web/tests/auth-context-initialization.test.tsx`, which already mocks `@/connect` and
  `@/auth-state`. Cases: `Code.Unavailable` must not clear the token; identity and all three
  initialization flags are restored offline; `Code.Unauthenticated` still clears the token;
  expired token plus offline still restores.
- New persister tests: allowlist filtering, per-user cache key, removal on logout, max-age
  expiry, restored entries marked stale.
- `PagedMemoList` renders memo content from a restored cache while offline, with no spinner.

Backend: `go test ./server/frontend/...` for the header rules.

Manual, per the verification policy in `AGENTS.md`: DevTools offline with "Update on reload";
a real Android device through the Cloudflare domain; kill the network mid-session and confirm
reads continue and writes are refused; cold-load offline after a fresh deploy.

## Risks

- **Private notes now persist in browser storage.** This is the point of the feature on a
  personal phone, but on a shared or library device it leaves readable note content in
  IndexedDB after the session ends. Content is per-user scoped and removed on logout, but
  logout is not the same as device handover. Consider an instance or user setting to disable
  offline caching; flagged for review rather than assumed.
- **Stale shell after deploy.** Mitigated by `no-cache` on `sw.js`, build-hash-keyed cache
  names, and cleanup on `activate`. `skipWaiting`/`clients.claim` must be used carefully so an
  update does not tear down an in-flight SSE connection.
- **iOS Safari evicts website data after roughly seven days of non-use.** Android is the stated
  target and `storage.persist()` helps, but the guarantee is weaker there.
- **Two bypass lists.** The service worker's bypass set and Go's `shouldSkipFrontendStatic`
  express the same policy in two languages and can drift. Both are commented with a
  cross-reference.

## Open decisions

**Attachments (`/file/*`).** This design caches memo text and metadata, not image or attachment
binaries. Offline, notes render but their images do not. Caching `/file/*` on success with a
size-bounded LRU would make offline notes feel complete, at the cost of unbounded storage growth
that a personal photo-heavy instance could exhaust quickly. Recommendation: ship v1 without it,
then add a size-capped LRU if the gap is felt in practice. Needs a decision because the storage
profile is qualitatively different from text.

**Workbox versus hand-rolled.** Hand-rolled is chosen here: the requirement is narrow
(precache plus network-first), Workbox's main value is in runtime strategies this design
explicitly rejects, and `AGENTS.md` is dependency-cautious. The cost is owning cache-cleanup
correctness, which is contained in one small module and covered by the `activate` tests.
