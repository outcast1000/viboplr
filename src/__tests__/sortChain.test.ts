import { describe, it, expect } from "vitest";
import { toggleSortKey, chainPosition, chainDir, type SortKey } from "../sortChain";

describe("toggleSortKey", () => {
  it("click on empty chain creates single entry asc", () => {
    expect(toggleSortKey([], "title", false)).toEqual([{ field: "title", dir: "asc" }]);
  });

  it("click on same single key flips direction", () => {
    expect(toggleSortKey([{ field: "title", dir: "asc" }], "title", false))
      .toEqual([{ field: "title", dir: "desc" }]);
  });

  it("click again flips back", () => {
    expect(toggleSortKey([{ field: "title", dir: "desc" }], "title", false))
      .toEqual([{ field: "title", dir: "asc" }]);
  });

  it("click on different field replaces chain", () => {
    expect(toggleSortKey([{ field: "title", dir: "asc" }], "artist", false))
      .toEqual([{ field: "artist", dir: "asc" }]);
  });

  it("click replaces multi-key chain", () => {
    expect(toggleSortKey(
      [{ field: "title", dir: "asc" }, { field: "artist", dir: "desc" }],
      "year", false
    )).toEqual([{ field: "year", dir: "asc" }]);
  });

  it("shift+click appends new field", () => {
    expect(toggleSortKey([{ field: "title", dir: "asc" }], "artist", true))
      .toEqual([{ field: "title", dir: "asc" }, { field: "artist", dir: "asc" }]);
  });

  it("shift+click on existing field toggles its direction in place", () => {
    expect(toggleSortKey(
      [{ field: "title", dir: "asc" }, { field: "artist", dir: "asc" }],
      "title", true
    )).toEqual([{ field: "title", dir: "desc" }, { field: "artist", dir: "asc" }]);
  });

  it("shift+click toggles second field direction", () => {
    expect(toggleSortKey(
      [{ field: "title", dir: "asc" }, { field: "artist", dir: "desc" }],
      "artist", true
    )).toEqual([{ field: "title", dir: "asc" }, { field: "artist", dir: "asc" }]);
  });

  it("shift+click on empty chain creates single entry", () => {
    expect(toggleSortKey([], "title", true)).toEqual([{ field: "title", dir: "asc" }]);
  });

  it("never creates duplicate fields", () => {
    const chain: SortKey[] = [{ field: "title", dir: "asc" }];
    const result = toggleSortKey(chain, "title", true);
    expect(result.length).toBe(1);
    expect(result[0].dir).toBe("desc");
  });
});

describe("chainPosition", () => {
  it("returns -1 for empty chain", () => {
    expect(chainPosition([], "title")).toBe(-1);
  });

  it("returns 0-based index", () => {
    const chain: SortKey[] = [
      { field: "liked", dir: "desc" },
      { field: "title", dir: "asc" },
    ];
    expect(chainPosition(chain, "liked")).toBe(0);
    expect(chainPosition(chain, "title")).toBe(1);
    expect(chainPosition(chain, "artist")).toBe(-1);
  });
});

describe("chainDir", () => {
  it("returns null for missing field", () => {
    expect(chainDir([], "title")).toBe(null);
  });

  it("returns direction for present field", () => {
    const chain: SortKey[] = [
      { field: "title", dir: "desc" },
    ];
    expect(chainDir(chain, "title")).toBe("desc");
  });
});
