import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

const openUrl = vi.fn((_url: string) => Promise.resolve());
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (u: string) => openUrl(u) }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => `asset://${p}` }));

// jsdom implements no layout, so no scrollIntoView (the dialog scrolls the
// photo on screen into view).
Element.prototype.scrollIntoView = vi.fn();

import { PhotoCreditsModal } from "../components/PhotoCreditsModal";

const PHOTOS = [
  { url: "https://img/a.jpg", credit: "Jane Doe · 1979 · Wikimedia Commons / CC BY-SA 4.0", pageUrl: "https://commons/a" },
  { url: "https://img/b.jpg", credit: null },
];

afterEach(cleanup);

describe("PhotoCreditsModal", () => {
  it("lists every photo with its credit, marks the one on screen, and opens a photo's page", () => {
    render(<PhotoCreditsModal photos={PHOTOS} currentUrl="https://img/b.jpg" onClose={vi.fn()} />);
    expect(screen.getByText("Jane Doe · 1979 · Wikimedia Commons / CC BY-SA 4.0")).toBeTruthy();
    expect(screen.getByText("No credit given by the source")).toBeTruthy();

    const rows = document.querySelectorAll(".photo-credits-row");
    expect(rows).toHaveLength(2);
    expect(rows[1].getAttribute("aria-current")).toBe("true");
    expect(rows[0].getAttribute("aria-current")).toBeNull();

    // Only the photo with a page offers one.
    const open = screen.getAllByRole("button", { name: "Open page" });
    expect(open).toHaveLength(1);
    fireEvent.click(open[0]);
    expect(openUrl).toHaveBeenCalledWith("https://commons/a");
  });

  it("closes with Close or Escape", () => {
    const onClose = vi.fn();
    render(<PhotoCreditsModal photos={PHOTOS} currentUrl={null} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
