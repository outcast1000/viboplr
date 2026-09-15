import { describe, expect, it } from "vitest";
import { formatAverage, formatCompactCount } from "../utils/formatCount";

describe("formatCompactCount", () => {
  it("leaves small counts plain", () => {
    expect(formatCompactCount(0)).toBe("0");
    expect(formatCompactCount(1)).toBe("1");
    expect(formatCompactCount(999)).toBe("999");
  });

  it("formats thousands with one decimal, dropping a trailing .0", () => {
    expect(formatCompactCount(1000)).toBe("1k");
    expect(formatCompactCount(1500)).toBe("1.5k");
    expect(formatCompactCount(10_412)).toBe("10.4k");
    expect(formatCompactCount(12_000)).toBe("12k");
  });

  it("drops the decimal once a tier reaches three digits", () => {
    expect(formatCompactCount(99_940)).toBe("99.9k");
    expect(formatCompactCount(99_960)).toBe("100k");
    expect(formatCompactCount(170_900)).toBe("171k");
  });

  it("promotes a value that would round into the next tier — never four digits", () => {
    expect(formatCompactCount(999_700)).toBe("1M");
    expect(formatCompactCount(999_400)).toBe("999k");
    expect(formatCompactCount(999_700_000)).toBe("1B");
  });

  it("covers millions and billions", () => {
    expect(formatCompactCount(2_160_000)).toBe("2.2M");
    expect(formatCompactCount(1_200_000_000)).toBe("1.2B");
  });

  it("is defensive about junk", () => {
    expect(formatCompactCount(Number.NaN)).toBe("0");
    expect(formatCompactCount(-5)).toBe("0");
    expect(formatCompactCount(Infinity)).toBe("0");
  });
});

describe("formatAverage", () => {
  it("keeps one decimal for small ratios and none past 100", () => {
    expect(formatAverage(12.34)).toBe("12.3");
    expect(formatAverage(3)).toBe("3");
    expect(formatAverage(142.4)).toBe("142");
    expect(formatAverage(99.96)).toBe("100");
  });

  it("returns null when there is nothing to show", () => {
    expect(formatAverage(0)).toBeNull();
    expect(formatAverage(Number.NaN)).toBeNull();
    expect(formatAverage(-1)).toBeNull();
  });
});
