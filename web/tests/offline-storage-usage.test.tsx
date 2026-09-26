import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OfflineStorageStats } from "@/components/Settings/OfflineStorageStats";

describe("OfflineStorageStats", () => {
  it("reports usage and whether persistence was granted", async () => {
    vi.stubGlobal("navigator", {
      storage: {
        estimate: vi.fn(async () => ({ usage: 5 * 1024 * 1024, quota: 1024 * 1024 * 1024 })),
        persisted: vi.fn(async () => true),
      },
    });

    render(<OfflineStorageStats />);

    await waitFor(() => expect(screen.getByTestId("offline-usage")).toHaveTextContent("5"));
    expect(screen.getByTestId("offline-persisted")).toHaveTextContent("yes");
  });

  it("renders nothing when the API is unavailable", async () => {
    vi.stubGlobal("navigator", {});

    const { container } = render(<OfflineStorageStats />);

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
