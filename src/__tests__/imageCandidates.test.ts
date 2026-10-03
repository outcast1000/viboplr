import { describe, expect, it, vi } from "vitest";
import { firstUsableImage } from "../utils/imageCandidates";

describe("firstUsableImage", () => {
  it("returns the first present candidate", () => {
    expect(firstUsableImage([null, undefined, "a", "b"], new Set())).toBe("a");
  });

  it("skips candidates that failed to load", () => {
    expect(firstUsableImage(["a", "b"], new Set(["a"]))).toBe("b");
  });

  it("returns null when every candidate is missing or failed", () => {
    expect(firstUsableImage([null, "a"], new Set(["a"]))).toBeNull();
  });

  it("evaluates a thunk only once every earlier candidate is unusable", () => {
    const lazy = vi.fn(() => "fallback");
    expect(firstUsableImage(["cover", lazy], new Set())).toBe("cover");
    expect(lazy).not.toHaveBeenCalled();
    expect(firstUsableImage(["cover", lazy], new Set(["cover"]))).toBe("fallback");
    expect(lazy).toHaveBeenCalledTimes(1);
  });
});
