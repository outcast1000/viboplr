import { describe, it, expect, afterEach, vi } from "vitest";
import { StrictMode } from "react";
import { render, cleanup, waitFor, act } from "@testing-library/react";
import { DetailHeroBackground } from "../components/DetailHeroBackground";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function layers(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll(".detail-hero-bg-layer"));
}

describe("DetailHeroBackground", () => {
  it("renders 0 layers for empty images", () => {
    const { container } = render(<DetailHeroBackground images={[]} />);
    expect(layers(container)).toHaveLength(0);
  });

  it("renders one full-bleed layer for a single image", () => {
    const { container } = render(<DetailHeroBackground images={["/a.jpg"]} />);
    const ls = layers(container);
    expect(ls).toHaveLength(1);
    expect(ls[0].style.backgroundImage).toContain("/a.jpg");
    // No inline slice geometry — the layer fills the hero via CSS `inset: 0`.
    expect(ls[0].style.left).toBe("");
    expect(ls[0].style.width).toBe("");
  });

  it("stacks one layer per image (capped at 4)", () => {
    const images = Array.from({ length: 6 }, (_, i) => `/img-${i}.jpg`);
    const { container } = render(<DetailHeroBackground images={images} />);
    const ls = layers(container);
    expect(ls).toHaveLength(4);
    for (let i = 0; i < 4; i++) {
      expect(ls[i].style.backgroundImage).toContain(`/img-${i}.jpg`);
    }
  });

  it("marks only the first layer active on mount", async () => {
    const { container } = render(
      <DetailHeroBackground images={["/a.jpg", "/b.jpg", "/c.jpg"]} />
    );
    await waitFor(() => {
      expect(layers(container)[0].className).toMatch(/active/);
    });
    const ls = layers(container);
    expect(ls[1].className).not.toMatch(/active/);
    expect(ls[2].className).not.toMatch(/active/);
  });

  it("advances the active layer on an interval and wraps around", async () => {
    vi.useFakeTimers();
    const { container } = render(
      <DetailHeroBackground images={["/a.jpg", "/b.jpg"]} />
    );
    // Flush the mount rAF/effects so the first layer becomes active.
    await act(async () => {
      vi.advanceTimersByTime(20);
    });
    expect(layers(container)[0].className).toMatch(/active/);

    // After one hold, the second image is active.
    await act(async () => {
      vi.advanceTimersByTime(7000);
    });
    let ls = layers(container);
    expect(ls[0].className).not.toMatch(/active/);
    expect(ls[1].className).toMatch(/active/);

    // After another hold, it wraps back to the first.
    await act(async () => {
      vi.advanceTimersByTime(7000);
    });
    ls = layers(container);
    expect(ls[0].className).toMatch(/active/);
    expect(ls[1].className).not.toMatch(/active/);
  });

  it("does not cycle when there is only a single image", async () => {
    vi.useFakeTimers();
    const { container } = render(<DetailHeroBackground images={["/a.jpg"]} />);
    await act(async () => {
      vi.advanceTimersByTime(20);
    });
    expect(layers(container)[0].className).toMatch(/active/);
    // Advancing well past the hold must not change anything (no second layer).
    await act(async () => {
      vi.advanceTimersByTime(30000);
    });
    expect(layers(container)).toHaveLength(1);
    expect(layers(container)[0].className).toMatch(/active/);
  });

  it("resets to the first image when the image set changes", async () => {
    vi.useFakeTimers();
    const { container, rerender } = render(
      <DetailHeroBackground images={["/a.jpg", "/b.jpg"]} />
    );
    await act(async () => {
      vi.advanceTimersByTime(7000);
    });
    expect(layers(container)[1].className).toMatch(/active/);

    rerender(<DetailHeroBackground images={["/c.jpg", "/d.jpg"]} />);
    await act(async () => {
      vi.advanceTimersByTime(20);
    });
    const ls = layers(container);
    expect(ls[0].style.backgroundImage).toContain("/c.jpg");
    expect(ls[0].className).toMatch(/active/);
    expect(ls[1].className).not.toMatch(/active/);
  });

  it("applies the className prop to the wrapper", () => {
    const { container } = render(<DetailHeroBackground images={[]} className="my-bg" />);
    expect(container.querySelector(".my-bg")).toBeTruthy();
  });

  it("activates the first layer under React StrictMode", async () => {
    // The app renders inside <StrictMode>, which mounts/unmounts/remounts each
    // component once on mount. A one-shot reveal guard would leave the layer
    // stuck at opacity 0 (regression: artist hero with images showed no bg).
    const { container } = render(
      <StrictMode>
        <DetailHeroBackground images={["/a.jpg", "/b.jpg"]} />
      </StrictMode>
    );
    await waitFor(() => {
      expect(layers(container)[0].className).toMatch(/active/);
    });
  });
});
