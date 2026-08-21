import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { HeroCarousel } from "../components/HeroCarousel";
import { VideoFrameQueueProvider } from "../hooks/useVideoFrameQueueContext";
import type { ResolvedShelf } from "../hooks/useHome";

const ROTATE_MS = 8_000;

function shelfWith(count: number): ResolvedShelf {
  return {
    id: "radio",
    title: "Radio",
    displayKind: "playlist-cards",
    items: Array.from({ length: count }, (_, i) => ({
      id: `radio:${i}`,
      name: `Station ${i}`,
      coverUrl: `http://covers.test/${i}.jpg`,
      tracks: [],
    })) as ResolvedShelf["items"],
  };
}

function renderCarousel(count = 4) {
  return render(
    <VideoFrameQueueProvider>
      <HeroCarousel
        shelf={shelfWith(count)}
        albumImageFor={() => null}
        artistImageFor={() => null}
        onItemClick={() => {}}
        onItemPlay={() => {}}
      />
    </VideoFrameQueueProvider>,
  );
}

function setDocumentHidden(hidden: boolean) {
  vi.spyOn(document, "hidden", "get").mockReturnValue(hidden);
}

beforeEach(() => {
  vi.useFakeTimers();
  // @ts-expect-error test stub — happy-dom has no IntersectionObserver
  globalThis.IntersectionObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  // @ts-expect-error remove the IntersectionObserver test stub
  delete globalThis.IntersectionObserver;
});

describe("HeroCarousel background layers", () => {
  it("mounts only the active layer at rest, never one per item", () => {
    const { container } = renderCarousel(6);
    const layers = container.querySelectorAll(".home-hero-bg-layer");
    expect(layers.length).toBe(1);
    expect(layers[0].classList.contains("active")).toBe(true);
  });

  it("mounts exactly active + outgoing after a rotation, active first", () => {
    const { container } = renderCarousel(6);
    act(() => { vi.advanceTimersByTime(ROTATE_MS); });
    const layers = container.querySelectorAll(".home-hero-bg-layer");
    expect(layers.length).toBe(2);
    // Incoming (active) below, outgoing on top so its fade-out reads as a dissolve.
    expect(layers[0].classList.contains("active")).toBe(true);
    expect(layers[1].classList.contains("active")).toBe(false);
    act(() => { vi.advanceTimersByTime(ROTATE_MS); });
    expect(container.querySelectorAll(".home-hero-bg-layer").length).toBe(2);
  });
});

describe("HeroCarousel rotation gating", () => {
  it("rotates on the interval while visible", () => {
    const { container } = renderCarousel();
    expect(container.querySelector(".home-hero-title")?.textContent).toBe("Station 0");
    act(() => { vi.advanceTimersByTime(ROTATE_MS); });
    expect(container.querySelector(".home-hero-title")?.textContent).toBe("Station 1");
  });

  it("does not rotate while the document is hidden, resumes on visible", () => {
    setDocumentHidden(true);
    const { container } = renderCarousel();
    act(() => { vi.advanceTimersByTime(ROTATE_MS * 3); });
    expect(container.querySelector(".home-hero-title")?.textContent).toBe("Station 0");

    setDocumentHidden(false);
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    act(() => { vi.advanceTimersByTime(ROTATE_MS); });
    expect(container.querySelector(".home-hero-title")?.textContent).toBe("Station 1");
  });
});
