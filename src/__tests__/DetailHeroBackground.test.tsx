import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { DetailHeroBackground } from "../components/DetailHeroBackground";

afterEach(() => {
  cleanup();
});

function layers(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll(".detail-hero-bg-layer"));
}

describe("DetailHeroBackground", () => {
  it("renders 0 layers for empty images", () => {
    const { container } = render(<DetailHeroBackground images={[]} />);
    expect(layers(container)).toHaveLength(0);
  });

  it("renders 1 layer that fills the full width for a single image", () => {
    const { container } = render(<DetailHeroBackground images={["/a.jpg"]} />);
    const ls = layers(container);
    expect(ls).toHaveLength(1);
    expect(ls[0].className).toMatch(/detail-hero-bg-edge-full/);
    expect(ls[0].style.backgroundImage).toContain("/a.jpg");
    expect(ls[0].style.left).toBe("0%");
    expect(ls[0].style.width).toBe("100%");
  });

  it("renders 2 side-by-side slices with soft overlap and edge feathering", () => {
    const { container } = render(<DetailHeroBackground images={["/a.jpg", "/b.jpg"]} />);
    const ls = layers(container);
    expect(ls).toHaveLength(2);
    // Left slice: feathered on the right edge only.
    expect(ls[0].className).toMatch(/detail-hero-bg-edge-left/);
    expect(ls[0].style.left).toBe("0%");
    // 50% base + 10% overlap on the inner side = 60%.
    expect(ls[0].style.width).toBe("60%");
    // Right slice: feathered on the left edge only, anchored at 40%.
    expect(ls[1].className).toMatch(/detail-hero-bg-edge-right/);
    expect(ls[1].style.left).toBe("40%");
    expect(ls[1].style.width).toBe("60%");
  });

  it("renders N>=3 layers with middle layers feathered on both sides", () => {
    for (const n of [3, 4]) {
      cleanup();
      const images = Array.from({ length: n }, (_, i) => `/img-${i}.jpg`);
      const { container } = render(<DetailHeroBackground images={images} />);
      const ls = layers(container);
      expect(ls).toHaveLength(n);
      expect(ls[0].className).toMatch(/detail-hero-bg-edge-left/);
      expect(ls[ls.length - 1].className).toMatch(/detail-hero-bg-edge-right/);
      for (let i = 1; i < ls.length - 1; i++) {
        expect(ls[i].className).toMatch(/detail-hero-bg-edge-middle/);
      }
    }
  });

  it("uses imagePath as the React key so changing source remounts the layer", () => {
    const { container, rerender } = render(<DetailHeroBackground images={["/a.jpg"]} />);
    const before = layers(container)[0];
    rerender(<DetailHeroBackground images={["/b.jpg"]} />);
    const after = layers(container)[0];
    // Different DOM node identity is the simplest evidence of a remount.
    expect(after).not.toBe(before);
    expect(after.style.backgroundImage).toContain("/b.jpg");
  });

  it("layers gain the `loaded` class on the next animation frame", async () => {
    const { container } = render(<DetailHeroBackground images={["/a.jpg", "/b.jpg"]} />);
    // Before requestAnimationFrame fires, layers are not yet "loaded" (opacity 0).
    expect(layers(container)[0].className).not.toMatch(/loaded/);
    // Wait for rAF to fire and state to update.
    await waitFor(() => {
      for (const l of layers(container)) {
        expect(l.className).toMatch(/loaded/);
      }
    });
  });

  it("applies the className prop to the wrapper", () => {
    const { container } = render(<DetailHeroBackground images={[]} className="my-bg" />);
    expect(container.querySelector(".my-bg")).toBeTruthy();
  });
});
