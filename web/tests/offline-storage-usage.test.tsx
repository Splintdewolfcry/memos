import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OfflineStorageStats } from "@/components/Settings/OfflineStorageStats";

vi.mock("@/utils/i18n", () => ({ useTranslate: () => (key: string) => key }));

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Drain pending microtasks plus one macrotask, so the mount effect's read has settled. */
const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

describe("OfflineStorageStats", () => {
  it("reports usage and whether persistence was granted", async () => {
    vi.stubGlobal("navigator", {
      storage: {
        estimate: vi.fn(async () => ({ usage: 5 * 1024 * 1024, quota: 1024 * 1024 * 1024 })),
        persisted: vi.fn(async () => true),
      },
    });

    render(<OfflineStorageStats />);

    // Exact copy pins reuse of the shared formatBytes from @/utils/format, not a bespoke formatter.
    await waitFor(() => expect(screen.getByTestId("offline-usage")).toHaveTextContent("5.0 MB of 1.0 GB"));
    expect(screen.getByTestId("offline-persisted")).toHaveTextContent("setting.resource-stats.offline.persisted-yes");
  });

  it("renders nothing when the storage API is absent", async () => {
    vi.stubGlobal("navigator", {});

    const { container } = render(<OfflineStorageStats />);

    // Wait for the read to settle: an empty container must not pass merely because
    // the first render happened before the effect resolved.
    await settle();

    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when the storage read fails", async () => {
    const estimate = vi.fn(async () => {
      throw new Error("denied");
    });
    vi.stubGlobal("navigator", { storage: { estimate, persisted: vi.fn(async () => true) } });

    const { container } = render(<OfflineStorageStats />);

    await waitFor(() => expect(estimate).toHaveBeenCalledTimes(1));
    await settle();

    expect(container).toBeEmptyDOMElement();
  });
});
