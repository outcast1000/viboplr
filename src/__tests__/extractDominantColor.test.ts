import { describe, it, expect, beforeEach, vi } from "vitest";
import { extractDominantColor, _averagePixels, _isDesaturated } from "../utils/extractDominantColor";

describe("_averagePixels", () => {
  it("averages a uniform red image", () => {
    const data = new Uint8ClampedArray([
      200, 30, 40, 255,
      200, 30, 40, 255,
      200, 30, 40, 255,
      200, 30, 40, 255,
    ]);
    expect(_averagePixels(data)).toEqual({ r: 200, g: 30, b: 40 });
  });

  it("averages a mixed image", () => {
    const data = new Uint8ClampedArray([
      100, 0, 0, 255,
      0, 100, 0, 255,
      0, 0, 100, 255,
      100, 100, 100, 255,
    ]);
    expect(_averagePixels(data)).toEqual({ r: 50, g: 50, b: 50 });
  });
});

describe("_isDesaturated", () => {
  it("flags grayscale colors", () => {
    expect(_isDesaturated({ r: 128, g: 128, b: 128 })).toBe(true);
    expect(_isDesaturated({ r: 50, g: 60, b: 55 })).toBe(true);
  });

  it("does not flag colorful colors", () => {
    expect(_isDesaturated({ r: 200, g: 30, b: 40 })).toBe(false);
    expect(_isDesaturated({ r: 50, g: 100, b: 30 })).toBe(false);
  });

  it("uses a 20-unit threshold", () => {
    expect(_isDesaturated({ r: 100, g: 119, b: 100 })).toBe(true);
    expect(_isDesaturated({ r: 100, g: 121, b: 100 })).toBe(false);
  });
});

describe("extractDominantColor", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when the image fails to load", async () => {
    class FailingImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      crossOrigin = "";
      set src(_v: string) {
        queueMicrotask(() => this.onerror?.());
      }
    }
    vi.stubGlobal("Image", FailingImage);
    const result = await extractDominantColor("http://example.com/x.jpg");
    expect(result).toBeNull();
  });

  it("returns null on canvas SecurityError", async () => {
    class OkImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      crossOrigin = "";
      set src(_v: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("Image", OkImage);

    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = origCreate(tag);
      if (tag === "canvas") {
        const canvas = el as HTMLCanvasElement;
        canvas.getContext = (() => ({
          drawImage: () => {},
          getImageData: () => { throw new Error("SecurityError"); },
        })) as unknown as typeof canvas.getContext;
      }
      return el;
    });

    const result = await extractDominantColor("http://example.com/x.jpg");
    expect(result).toBeNull();
  });
});
