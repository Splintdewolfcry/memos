import { useAuth } from "@/contexts/AuthContext";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { cn } from "@/lib/utils";
import { useTranslate } from "@/utils/i18n";

const ConnectionStatusBadge = ({ className }: { className?: string }) => {
  const t = useTranslate();
  const { isOffline } = useAuth();
  const online = useOnlineStatus();

  // The two confident "cached copy" signals, mirroring OfflineBanner's
  // predicate: the session was restored from the offline cache, or the browser
  // reports no connectivity. An SSE drop while the browser stays online is
  // deliberately not one — the live store also disconnects during retry backoff
  // and in hidden tabs, so it cannot distinguish a cached read.
  const cached = isOffline || !online;

  return (
    <div
      role="status"
      data-testid="connection-status-badge"
      className={cn(
        "flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-border/60 bg-background/85 px-2.5 text-xs text-muted-foreground shadow-xs backdrop-blur-md",
        className,
      )}
    >
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", cached ? "bg-warning" : "bg-success")} />
      {cached ? t("connectionStatus.cached") : t("connectionStatus.online")}
    </div>
  );
};

export default ConnectionStatusBadge;
