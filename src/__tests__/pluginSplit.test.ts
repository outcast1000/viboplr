import { describe, it, expect } from "vitest";
import {
  clampSplitSize,
  coerceSplitSizes,
  splitSizeKey,
  splitSizesForPlugin,
  withSplitSize,
  SPLIT_DEFAULT_MIN,
  SPLIT_MIN_SECOND_PANE,
  SPLIT_SIZES_MAX_KEYS,
} from "../utils/pluginSplit";

describe("clampSplitSize", () => {
  it("keeps a width inside min / max", () => {
    expect(clampSplitSize(300, { minSize: 200, maxSize: 500 })).toBe(300);
    expect(clampSplitSize(100, { minSize: 200, maxSize: 500 })).toBe(200);
    expect(clampSplitSize(900, { minSize: 200, maxSize: 500 })).toBe(500);
  });

  it("defaults the minimum", () => {
    expect(clampSplitSize(10, {})).toBe(SPLIT_DEFAULT_MIN);
  });

  it("always leaves the second pane its minimum", () => {
    expect(clampSplitSize(900, {}, 1000)).toBe(1000 - SPLIT_MIN_SECOND_PANE);
  });

  it("lets the minimum win when the container is too narrow for both", () => {
    expect(clampSplitSize(300, { minSize: 200 }, 300)).toBe(200);
  });

  it("treats garbage as the default width", () => {
    expect(clampSplitSize(Number.NaN, {})).toBe(300);
  });
});

describe("pluginSplitSizes record", () => {
  it("keys per plugin and reads one plugin's widths back by persistKey", () => {
    const sizes = { [splitSizeKey("explorer", "main")]: 320, [splitSizeKey("other", "main")]: 280 };
    expect(splitSizesForPlugin(sizes, "explorer")).toEqual({ main: 320 });
  });

  it("restores finite positive numbers only", () => {
    expect(coerceSplitSizes({ "a:x": 300, "a:y": -1, "a:z": "wide", "a:w": Number.POSITIVE_INFINITY })).toEqual({ "a:x": 300 });
    expect(coerceSplitSizes(null)).toBeUndefined();
    expect(coerceSplitSizes([300])).toBeUndefined();
  });

  it("returns the same object when the width didn't change", () => {
    const sizes = { "a:x": 300 };
    expect(withSplitSize(sizes, "a:x", 300)).toBe(sizes);
    expect(withSplitSize(sizes, "a:x", 310)).toEqual({ "a:x": 310 });
  });

  it("stays bounded, dropping the oldest keys", () => {
    let sizes: Record<string, number> = {};
    for (let i = 0; i < SPLIT_SIZES_MAX_KEYS + 5; i++) sizes = withSplitSize(sizes, `p:${i}`, 200 + i);
    const keys = Object.keys(sizes);
    expect(keys).toHaveLength(SPLIT_SIZES_MAX_KEYS);
    expect(keys[0]).toBe("p:5");
    expect(keys[keys.length - 1]).toBe(`p:${SPLIT_SIZES_MAX_KEYS + 4}`);
  });
});
