import { describe, it, expect } from "vitest";
import {
  formatChartValue,
  chartPoints,
  buildLinePath,
  buildAreaPath,
  heatIntensity,
} from "../utils/pluginCharts";

describe("formatChartValue", () => {
  it("formats integers with thousands separators", () => {
    expect(formatChartValue(0)).toBe("0");
    expect(formatChartValue(1234)).toBe("1,234");
    expect(formatChartValue(1234567)).toBe("1,234,567");
    expect(formatChartValue(412.7)).toBe("413"); // rounds
  });

  it("formats percent", () => {
    expect(formatChartValue(61.4, "percent")).toBe("61%");
    expect(formatChartValue(100, "percent")).toBe("100%");
  });

  it("formats duration in s / m / h", () => {
    expect(formatChartValue(45, "duration")).toBe("45s");
    expect(formatChartValue(90, "duration")).toBe("2m"); // rounds 1.5m -> 2m
    expect(formatChartValue(3600, "duration")).toBe("1h");
    expect(formatChartValue(5400, "duration")).toBe("1.5h");
  });

  it("handles non-finite gracefully", () => {
    expect(formatChartValue(NaN)).toBe("0");
    expect(formatChartValue(Infinity)).toBe("0");
  });
});

describe("chartPoints", () => {
  it("returns [] for no points", () => {
    expect(chartPoints([], 10, 100, 40)).toEqual([]);
  });

  it("maps a single point to a flat segment across the width", () => {
    // value === max -> y at top (0)
    expect(chartPoints([10], 10, 100, 40)).toEqual([
      [0, 0],
      [100, 0],
    ]);
  });

  it("spreads points across the width and inverts the y axis", () => {
    // 0 -> bottom (h), max -> top (0), midpoint -> h/2
    expect(chartPoints([0, 5, 10], 10, 100, 40)).toEqual([
      [0, 40],
      [50, 20],
      [100, 0],
    ]);
  });

  it("flattens to the baseline when max <= 0", () => {
    expect(chartPoints([0, 0], 0, 100, 40)).toEqual([
      [0, 40],
      [100, 40],
    ]);
  });

  it("clamps values above max to the top", () => {
    expect(chartPoints([20], 10, 100, 40)).toEqual([
      [0, 0],
      [100, 0],
    ]);
  });
});

describe("buildLinePath / buildAreaPath", () => {
  it("returns empty string for no points", () => {
    expect(buildLinePath([], 10, 100, 40)).toBe("");
    expect(buildAreaPath([], 10, 100, 40)).toBe("");
  });

  it("builds an M/L polyline path", () => {
    expect(buildLinePath([0, 10], 10, 100, 40)).toBe("M0 40 L100 0");
  });

  it("closes the area path down to the baseline", () => {
    expect(buildAreaPath([0, 10], 10, 100, 40)).toBe("M0 40 L100 0 L100 40 L0 40 Z");
  });
});

describe("heatIntensity", () => {
  it("returns 0 for empty / invalid scales", () => {
    expect(heatIntensity(5, 0)).toBe(0);
    expect(heatIntensity(0, 10)).toBe(0);
    expect(heatIntensity(NaN, 10)).toBe(0);
  });

  it("returns the value/max ratio, clamped to [0,1]", () => {
    expect(heatIntensity(5, 10)).toBe(0.5);
    expect(heatIntensity(10, 10)).toBe(1);
    expect(heatIntensity(20, 10)).toBe(1);
  });
});
