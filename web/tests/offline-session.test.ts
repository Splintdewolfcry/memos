import { create } from "@bufbuild/protobuf";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearOfflineSession, getStoredOfflineUserName, loadOfflineSession, saveOfflineSession } from "@/lib/offline-session";
import { UserSchema, UserSetting_TagsSettingSchema } from "@/types/proto/api/v1/user_service_pb";

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

  it("reports the stored user name until the session is cleared", () => {
    // The name decides which persisted cache an offline boot restores into, and
    // which one a foreign sign-in has to drop.
    expect(getStoredOfflineUserName()).toBeUndefined();

    saveOfflineSession(alice(), {});
    expect(getStoredOfflineUserName()).toBe("users/1");

    clearOfflineSession();
    expect(getStoredOfflineUserName()).toBeUndefined();
  });

  it("reports no user name for a corrupt payload", () => {
    store.set("memos_offline_session", "{not json");

    expect(getStoredOfflineUserName()).toBeUndefined();
  });
});
