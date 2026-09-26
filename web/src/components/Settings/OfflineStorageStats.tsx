import { useEffect, useState } from "react";
import { type OfflineStorageUsage, readOfflineStorageUsage } from "@/lib/offline-store";
import { formatBytes } from "@/utils/format";
import { useTranslate } from "@/utils/i18n";
import SettingGroup from "./SettingGroup";
import { SettingList, SettingListItem, StatValue } from "./SettingList";

/**
 * Offline cache held by this browser. Nothing caps how much the offline store
 * keeps, so without this row the size and a refused persistence grant stay
 * invisible until the browser evicts the cache. Renders nothing where the
 * Storage Manager API is absent.
 */
export const OfflineStorageStats = () => {
  const t = useTranslate();
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
  const persisted = usage.persisted ? t("setting.resource-stats.offline.persisted-yes") : t("setting.resource-stats.offline.persisted-no");

  return (
    <SettingGroup
      title={t("setting.resource-stats.offline.title")}
      description={t("setting.resource-stats.offline.description")}
      showSeparator
    >
      <SettingList>
        <SettingListItem label={t("setting.resource-stats.offline.size")} controlClassName="w-full justify-end sm:w-auto">
          <div data-testid="offline-usage" className="min-w-0">
            <StatValue value={size} />
          </div>
        </SettingListItem>
        <SettingListItem
          label={t("setting.resource-stats.offline.persistent-storage")}
          description={usage.persisted ? undefined : t("setting.resource-stats.offline.persisted-warning")}
          controlClassName="w-full justify-end sm:w-auto"
        >
          <div data-testid="offline-persisted" className="min-w-0">
            <StatValue value={persisted} />
          </div>
        </SettingListItem>
      </SettingList>
    </SettingGroup>
  );
};
