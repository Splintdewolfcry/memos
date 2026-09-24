import { fromJson, type JsonValue, toJson } from "@bufbuild/protobuf";
import type {
  User,
  UserSetting_GeneralSetting,
  UserSetting_TagsSetting,
  UserSetting_WebhooksSetting,
} from "@/types/proto/api/v1/user_service_pb";
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
      ...(parsed.general ? { general: fromJson(UserSetting_GeneralSettingSchema, parsed.general, { ignoreUnknownFields: true }) } : {}),
      ...(parsed.tags ? { tags: fromJson(UserSetting_TagsSettingSchema, parsed.tags, { ignoreUnknownFields: true }) } : {}),
      ...(parsed.webhooks ? { webhooks: fromJson(UserSetting_WebhooksSettingSchema, parsed.webhooks, { ignoreUnknownFields: true }) } : {}),
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
