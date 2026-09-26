import { useAuth } from "@/contexts/AuthContext";
import { useSSEConnectionStatus } from "@/hooks/useLiveMemoRefresh";
import { cn } from "@/lib/utils";
import { useTranslate } from "@/utils/i18n";

const OfflineBanner = () => {
  const t = useTranslate();
  const { isOffline, currentUser } = useAuth();
  const sseStatus = useSSEConnectionStatus();

  // "disconnected" is the SSE store's idle default: signed-out visitors and tabs
  // waiting out a retry backoff report it while online. Count it only for an
  // authenticated session that has also lost connectivity.
  const shouldShow = isOffline || (!!currentUser && sseStatus === "disconnected" && !navigator.onLine);

  if (!shouldShow) {
    return null;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn("static w-full shrink-0 border-b border-border bg-muted/70 px-4 py-2 text-sm text-muted-foreground sm:px-6")}
    >
      <div className="mx-auto flex max-w-5xl flex-col items-start gap-1 sm:flex-row sm:items-center sm:justify-center sm:gap-2">
        <span className="font-medium text-foreground">{t("offlineBanner.title")}</span>
        <span>{t("offlineBanner.description")}</span>
      </div>
    </div>
  );
};

export default OfflineBanner;
