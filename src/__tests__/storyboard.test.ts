import { describe, it, expect } from "vitest";
import {
  tileIndexAt,
  tileStartSecs,
  tileFitStyle,
  tileCoverStyle,
  spreadTileIndices,
  spreadIndices,
  partialStoryboard,
  schemeOf,
  type Storyboard,
} from "../utils/storyboard";

// Matches what the Rust producer emits for a 213s 16:9 video at the 10s floor:
// 22 real tiles in a 5x5 grid (3 padded slots), one sheet, 200x112 tiles.
function board(over: Partial<Storyboard> = {}): Storyboard {
  return {
    sheets: ["/cache/abc.jpg"],
    cols: 5,
    rows: 5,
    count: 22,
    tileW: 200,
    tileH: 112,
    startSecs: 0,
    intervalSecs: 10,
    ...over,
  };
}

describe("tileIndexAt", () => {
  it("maps a time to the tile covering it", () => {
    expect(tileIndexAt(board(), 0)).toBe(0);
    expect(tileIndexAt(board(), 10)).toBe(1);
    expect(tileIndexAt(board(), 50)).toBe(5);
    expect(tileIndexAt(board(), 210)).toBe(21);
  });

  it("floors within a tile's interval rather than rounding", () => {
    // Anywhere in [10, 20) is tile 1 — the tile depicts its start moment.
    expect(tileIndexAt(board(), 10)).toBe(1);
    expect(tileIndexAt(board(), 19.99)).toBe(1);
    expect(tileIndexAt(board(), 20)).toBe(2);
  });

  it("refuses padded slots past the real tile count", () => {
    // 22 tiles in a 25-slot grid: 220s would be slot 22, which ffmpeg left black.
    expect(tileIndexAt(board(), 220)).toBeNull();
  });

  it("refuses times before startSecs", () => {
    expect(tileIndexAt(board(), -1)).toBeNull();
    expect(tileIndexAt(board({ startSecs: 30 }), 29)).toBeNull();
    expect(tileIndexAt(board({ startSecs: 30 }), 30)).toBe(0);
  });

  it("refuses an index that would fall past the supplied sheets", () => {
    // count claims 200 tiles but only one sheet was supplied.
    const b = board({ cols: 10, rows: 10, count: 200, sheets: ["/only.jpg"] });
    expect(tileIndexAt(b, 1500)).toBeNull();
    // Still fine inside the one sheet it does have.
    expect(tileIndexAt(b, 100)).toBe(10);
  });

  it("handles the multi-sheet (plugin) case", () => {
    const b = board({
      sheets: ["/a.jpg", "/b.jpg"], cols: 10, rows: 10, count: 200,
      tileW: 80, tileH: 45, intervalSecs: 2,
    });
    expect(tileIndexAt(b, 198)).toBe(99);  // last of sheet 0
    expect(tileIndexAt(b, 200)).toBe(100); // first of sheet 1
  });

  it("rejects malformed descriptors instead of dividing by zero", () => {
    expect(tileIndexAt(board({ intervalSecs: 0 }), 5)).toBeNull();
    expect(tileIndexAt(board({ intervalSecs: -10 }), 5)).toBeNull();
    expect(tileIndexAt(board({ cols: 0 }), 0)).toBeNull();
    expect(tileIndexAt(board({ rows: 0 }), 0)).toBeNull();
    expect(tileIndexAt(board({ count: 0 }), 0)).toBeNull();
    expect(tileIndexAt(board({ sheets: [] }), 0)).toBeNull();
    expect(tileIndexAt(board({ tileW: 0 }), 0)).toBeNull();
    expect(tileIndexAt(board({ tileH: 0 }), 0)).toBeNull();
  });
});

describe("tileFitStyle", () => {
  it("sizes the sheet to the grid so one tile fills the box", () => {
    const s = tileFitStyle(board(), 0)!;
    expect(s.backgroundSize).toBe("500% 500%");
    expect(s.backgroundPosition).toBe("0% 0%");
    expect(s.backgroundImage).toBe('url("/cache/abc.jpg")');
  });

  it("interpolates position across the grid", () => {
    // 5 cols -> 4 steps of 25%. Tile 5 starts row 1 at col 0.
    expect(tileFitStyle(board(), 1)!.backgroundPosition).toBe("25% 0%");
    expect(tileFitStyle(board(), 4)!.backgroundPosition).toBe("100% 0%");
    expect(tileFitStyle(board(), 5)!.backgroundPosition).toBe("0% 25%");
    expect(tileFitStyle(board(), 21)!.backgroundPosition).toBe("25% 100%");
  });

  it("is resolution-independent — no pixel values at all", () => {
    // This is why the filmstrip can stretch tiles across a flex row without measuring.
    const s = tileFitStyle(board(), 7)!;
    expect(s.backgroundPosition).not.toMatch(/px/);
    expect(s.backgroundSize).not.toMatch(/px/);
  });

  it("avoids dividing by zero on a single-column or single-row grid", () => {
    const one = board({ cols: 1, rows: 1, count: 1 });
    expect(tileFitStyle(one, 0)!.backgroundPosition).toBe("0% 0%");
    const strip = board({ cols: 4, rows: 1, count: 4 });
    expect(tileFitStyle(strip, 2)!.backgroundPosition).toBe("66.66666666666666% 0%");
  });

  it("picks the right sheet in the multi-sheet case", () => {
    const b = board({ sheets: ["/a.jpg", "/b.jpg"], cols: 10, rows: 10, count: 200 });
    expect(tileFitStyle(b, 0)!.backgroundImage).toBe('url("/a.jpg")');
    expect(tileFitStyle(b, 100)!.backgroundImage).toBe('url("/b.jpg")');
    // Tile 100 is the first of sheet 1, so it sits at that sheet's origin.
    expect(tileFitStyle(b, 100)!.backgroundPosition).toBe("0% 0%");
  });

  it("refuses out-of-range indices", () => {
    expect(tileFitStyle(board(), -1)).toBeNull();
    expect(tileFitStyle(board(), 22)).toBeNull();
    expect(tileFitStyle(board({ sheets: [] }), 0)).toBeNull();
  });
});

describe("tileCoverStyle", () => {
  it("scales up to cover a square box and centres the horizontal crop", () => {
    // 200x112 tile into 200x200: k = 200/112, tile becomes 357x200, so 157px of
    // width overflows and ~79 is cropped from each side.
    const s = tileCoverStyle(board(), 0, 200, 200)!;
    expect(s.backgroundSize).toBe("1786px 1000px"); // 5 x 357 by 5 x 200
    expect(s.backgroundPosition).toBe("-79px 0px");
  });

  it("offsets by whole scaled tiles for later positions", () => {
    const s = tileCoverStyle(board(), 6, 200, 200)!;
    // Tile 6 is col 1, row 1: one scaled tile right and down, plus the centre crop.
    expect(s.backgroundPosition).toBe("-436px -200px");
  });

  it("does not scale when the tile already matches the box", () => {
    const s = tileCoverStyle(board(), 0, 200, 112)!;
    expect(s.backgroundSize).toBe("1000px 560px");
    expect(s.backgroundPosition).toBe("0px 0px");
  });

  it("rounds to whole pixels so tiles don't bleed at the seams", () => {
    const s = tileCoverStyle(board(), 3, 137, 137)!;
    expect(s.backgroundPosition).toMatch(/^-?\d+px -?\d+px$/);
    expect(s.backgroundSize).toMatch(/^\d+px \d+px$/);
  });

  it("refuses a degenerate box or index", () => {
    expect(tileCoverStyle(board(), 0, 0, 100)).toBeNull();
    expect(tileCoverStyle(board(), 0, 100, 0)).toBeNull();
    expect(tileCoverStyle(board(), 99, 100, 100)).toBeNull();
  });
});

describe("tileStartSecs", () => {
  it("returns the moment a tile depicts", () => {
    expect(tileStartSecs(board(), 0)).toBe(0);
    expect(tileStartSecs(board(), 21)).toBe(210);
    expect(tileStartSecs(board({ startSecs: 5 }), 2)).toBe(25);
  });

  it("round-trips with tileIndexAt", () => {
    for (const i of [0, 1, 7, 21]) {
      expect(tileIndexAt(board(), tileStartSecs(board(), i))).toBe(i);
    }
  });
});

describe("spreadTileIndices", () => {
  it("spans first to last tile", () => {
    const out = spreadTileIndices(board(), 8);
    expect(out[0]).toBe(0);
    expect(out[out.length - 1]).toBe(21);
    expect(out).toHaveLength(8);
  });

  it("returns every tile when asked for at least as many as exist", () => {
    expect(spreadTileIndices(board({ count: 3 }), 8)).toEqual([0, 1, 2]);
  });

  it("never repeats an index when tiles are scarce", () => {
    const out = spreadTileIndices(board({ count: 2 }), 2);
    expect(new Set(out).size).toBe(out.length);
  });

  it("stays in range for every count/n combination", () => {
    for (const count of [1, 2, 3, 7, 22, 100]) {
      for (const n of [1, 4, 8, 12]) {
        for (const i of spreadTileIndices(board({ count }), n)) {
          expect(i).toBeGreaterThanOrEqual(0);
          expect(i).toBeLessThan(count);
        }
      }
    }
  });

  it("handles degenerate requests", () => {
    expect(spreadTileIndices(board(), 0)).toEqual([]);
    expect(spreadTileIndices(board({ count: 0 }), 4)).toEqual([]);
    expect(spreadTileIndices(board(), 1)).toEqual([0]);
  });

  // The count-based core is what the loading filmstrip spreads partial frames with;
  // it must place them exactly where the finished strip will, or frames jump when
  // the sheet lands.
  it("spreadIndices agrees with the board-based wrapper", () => {
    for (const count of [1, 2, 3, 7, 22, 100]) {
      expect(spreadIndices(count, 8)).toEqual(spreadTileIndices(board({ count }), 8));
    }
  });
});

describe("partialStoryboard (frames extracted so far as a usable board)", () => {
  // 3 of an eventual 100 frames, one every 48s (an ~80-minute video).
  const p = () => partialStoryboard(["f0.jpg", "f1.jpg", "f2.jpg"], 48, 100)!;

  it("serves the extracted moments and declines the rest", () => {
    const b = p();
    expect(tileIndexAt(b, 0)).toBe(0);
    expect(tileIndexAt(b, 100)).toBe(2); // 100s / 48s -> frame 2, extracted
    expect(tileIndexAt(b, 200)).toBeNull(); // frame 4 — not extracted yet
    expect(tileIndexAt(b, 4790)).toBeNull(); // near the end — not extracted yet
  });

  it("keeps the finished layout from the first frame, so nothing reflows", () => {
    // Spread over the FINAL count, not the frames on hand — a slot that shows a
    // frame now must be the same slot that shows it when the sheet lands.
    const b = p();
    expect(b.count).toBe(100);
    expect(spreadTileIndices(b, 8)).toEqual(spreadIndices(100, 8));
    expect(tileStartSecs(b, 99)).toBe(99 * 48);
  });

  it("styles resolve for extracted frames only", () => {
    const b = p();
    expect(tileFitStyle(b, 1)?.backgroundImage).toBe('url("f1.jpg")');
    expect(tileCoverStyle(b, 2, 60, 34)).not.toBeNull();
    expect(tileFitStyle(b, 3)).toBeNull();
    expect(tileCoverStyle(b, 50, 60, 34)).toBeNull();
  });

  it("is null when there is nothing to show or the descriptor is degenerate", () => {
    expect(partialStoryboard([], 48, 100)).toBeNull();
    expect(partialStoryboard(["f0.jpg"], 0, 100)).toBeNull();
    expect(partialStoryboard(["f0.jpg"], 48, 0)).toBeNull();
  });
});

describe("schemeOf (storyboard producer routing)", () => {
  it("splits a plugin scheme from its id", () => {
    expect(schemeOf("ytdlp://dQw4w9WgXcQ")).toEqual({ scheme: "ytdlp", id: "dQw4w9WgXcQ" });
    expect(schemeOf("subsonic://col-1/42")).toEqual({ scheme: "subsonic", id: "col-1/42" });
  });

  it("identifies local files so they route to the ffmpeg producer", () => {
    expect(schemeOf("file:///music/clip.mp4")).toEqual({ scheme: "file", id: "/music/clip.mp4" });
  });

  it("returns null for a bare path rather than inventing a scheme", () => {
    expect(schemeOf("/music/clip.mp4")).toBeNull();
    expect(schemeOf("")).toBeNull();
  });

  it("does not treat a leading :// as a scheme", () => {
    expect(schemeOf("://weird")).toBeNull();
  });

  it("keeps query strings and extra slashes in the id", () => {
    expect(schemeOf("ytdlp://abc?x=1&y=2")).toEqual({ scheme: "ytdlp", id: "abc?x=1&y=2" });
  });
});
