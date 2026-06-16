import { describe, it, expect } from "vitest";
import { classifyTagCounts } from "../hooks/useEntityTags";

describe("classifyTagCounts", () => {
  it("splits full (count === total) from partial (0 < count < total)", () => {
    const rows: Array<[number, string, number]> = [
      [1, "jazz", 5], // on all 5 → full
      [2, "bebop", 3], // 3 of 5 → partial
    ];
    const { applied, partial } = classifyTagCounts(rows, 5);
    expect(applied).toEqual(["jazz"]);
    expect(partial).toEqual([{ name: "bebop", count: 3, total: 5 }]);
  });

  it("treats a one-track entity's tags as full (1 of 1), never partial", () => {
    const rows: Array<[number, string, number]> = [[1, "live", 1]];
    const { applied, partial } = classifyTagCounts(rows, 1);
    expect(applied).toEqual(["live"]);
    expect(partial).toEqual([]);
  });

  it("returns empty for zero total", () => {
    expect(classifyTagCounts([], 0)).toEqual({ applied: [], partial: [] });
  });

  it("sorts applied and partial case-insensitively by name", () => {
    const rows: Array<[number, string, number]> = [
      [1, "Zydeco", 4],
      [2, "ambient", 4],
      [3, "Bebop", 2],
      [4, "acid", 1],
    ];
    const { applied, partial } = classifyTagCounts(rows, 4);
    expect(applied).toEqual(["ambient", "Zydeco"]);
    expect(partial.map((p) => p.name)).toEqual(["acid", "Bebop"]);
  });

  it("excludes tags with a zero count defensively", () => {
    const rows: Array<[number, string, number]> = [
      [1, "ghost", 0],
      [2, "real", 2],
    ];
    const { applied, partial } = classifyTagCounts(rows, 3);
    expect(applied).toEqual([]);
    expect(partial).toEqual([{ name: "real", count: 2, total: 3 }]);
  });
});
