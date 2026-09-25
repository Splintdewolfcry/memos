import { useAuth } from "@/contexts/AuthContext";
import { useSSEConnectionStatus } from "@/hooks/useLiveMemoRefresh";
import { cn } from "@/lib/utils";
import { useTranslate } from "@/utils/i18n";

const OfflineBanner = () => {
  const t = useTranslate();
  const { isOffline } = useAuth();
  const sseStatus = useSSEConnectionStatus();

  const isDisconnected = sseStatus === "disconnected";
  const shouldShow = isOffline || isDisconnected;

  if (!shouldShow) {
    return null;
  }

  return (
    <div className={cn("static w-full shrink-0 border-b border-border bg-muted/70 px-4 py-2 text-sm text-muted-foreground sm:px-6")}>
      <div className="mx-auto flex max-w-5xl flex-col items-start gap-1 sm:flex-row sm:items-center sm:justify-center sm:gap-2">
        <span className="font-medium text-foreground">{t("offlineBanner.title")}</span>
        <span>{t("offlineBanner.description")}</span>
      </div>
    </div>
  );
};

export default OfflineBanner;
