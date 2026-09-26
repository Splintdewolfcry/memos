import { create } from "@bufbuild/protobuf";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoKeys, useUpdateMemo } from "@/hooks/useMemoQueries";
import { setNavigatorOnline } from "@/lib/offline-state";
import { MemoSchema } from "@/types/proto/api/v1/memo_service_pb";

const api = vi.hoisted(() => ({ updateMemo: vi.fn() }));
vi.mock("@/connect", () => ({ memoServiceClient: api }));

const setup = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
};

describe("useUpdateMemo while writes are blocked", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setNavigatorOnline(true);
  });

  afterEach(() => {
    setNavigatorOnline(true);
  });

  it("fails without invalidating or touching the cache", async () => {
    setNavigatorOnline(false);
    const { client, wrapper } = setup();
    const memo = create(MemoSchema, { name: "memos/offline", content: "original" });
    client.setQueryData(memoKeys.detail(memo.name), memo);
    const invalidate = vi.spyOn(client, "invalidateQueries");

    const { result } = renderHook(() => useUpdateMemo(), { wrapper });
    act(() => result.current.mutate({ update: { name: memo.name, content: "edited" }, updateMask: ["content"] }));
    await waitFor(() => expect(result.current.isError).toBe(true));

    // The blocked write never reached the server, so onError must not start a
    // storm of refetches that would all fail the same way.
    expect(api.updateMemo).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
    expect(client.getQueryData(memoKeys.detail(memo.name))).toEqual(memo);
    client.clear();
  });

  it("still rolls back the optimistic patch when an online update fails", async () => {
    const { client, wrapper } = setup();
    const memo = create(MemoSchema, { name: "memos/online", content: "original" });
    client.setQueryData(memoKeys.detail(memo.name), memo);
    api.updateMemo.mockRejectedValue(new Error("server exploded"));
    const invalidate = vi.spyOn(client, "invalidateQueries");

    const { result } = renderHook(() => useUpdateMemo(), { wrapper });
    act(() => result.current.mutate({ update: { name: memo.name, content: "edited" }, updateMask: ["content"] }));
    await waitFor(() => expect(result.current.isError).toBe(true));

    // Online failures keep the original recovery path: rollback via the
    // previousMemo snapshot, and invalidation only when there was no snapshot.
    expect(api.updateMemo).toHaveBeenCalledOnce();
    expect(client.getQueryData(memoKeys.detail(memo.name))).toEqual(memo);
    expect(invalidate).not.toHaveBeenCalled();
    client.clear();
  });
});
