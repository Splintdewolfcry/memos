import { beforeEach, describe, expect, it } from "vitest";
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
