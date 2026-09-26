import { useEffect, useState } from "react";
import { type OfflineStorageUsage, readOfflineStorageUsage } from "@/lib/offline-store";
import { formatBytes } from "./ResourceStatsSection";
import SettingGroup from "./SettingGroup";
import { SettingList, SettingListItem, StatValue } from "./SettingList";

/**
 * Offline cache held by this browser. Nothing caps how much the offline store
 * keeps, so without this row the size and a refused persistence grant stay
 * invisible until the browser evicts the cache. Renders nothing where the
 * Storage Manager API is absent.
 */
export const OfflineStorageStats = () => {
  const [usage, setUsage] = useState<OfflineStorageUsage | undefined>(undefined);

  useEffect(() => {
    let mounted = true;
    void readOfflineStorageUsage().then((result) => {
      if (mounted) {
        setUsage(result);
      }
    });
    return () => {
      mounted = false;
    };
  }, []);

  if (!usage) {
    return null;
  }

  const size = usage.quota > 0 ? `${formatBytes(usage.usage)} of ${formatBytes(usage.quota)}` : formatBytes(usage.usage);

  return (
    <SettingGroup title="Offline cache" description="Data this browser holds so memos stay reachable offline." showSeparator>
      <SettingList>
        <SettingListItem label="Size" controlClassName="w-full justify-end sm:w-auto">
          <div data-testid="offline-usage" className="min-w-0">
            <StatValue value={size} />
          </div>
        </SettingListItem>
        <SettingListItem
          label="Persistent storage"
          description={usage.persisted ? undefined : "Not granted — the browser may evict this cache under storage pressure."}
          controlClassName="w-full justify-end sm:w-auto"
        >
          <div data-testid="offline-persisted" className="min-w-0">
            <StatValue value={usage.persisted ? "yes" : "no"} />
          </div>
        </SettingListItem>
      </SettingList>
    </SettingGroup>
  );
};
