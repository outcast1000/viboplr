import { describe, it, expect } from "vitest";
import { recordVisit, type RecentlyVisitedEntry } from "../utils/recentlyVisited";

describe("recordVisit", () => {
  it("appends a new entry", () => {
    const before: RecentlyVisitedEntry[] = [];
    const after = recordVisit(before, { kind: "album", id: 1, ts: 100 });
    expect(after).toEqual([{ kind: "album", id: 1, ts: 100 }]);
  });

  it("dedupes by kind:id, keeping the most recent ts", () => {
    const before: RecentlyVisitedEntry[] = [
      { kind: "album", id: 1, ts: 100 },
      { kind: "artist", id: 5, ts: 110 },
    ];
    const after = recordVisit(before, { kind: "album", id: 1, ts: 200 });
    expect(after).toEqual([
      { kind: "artist", id: 5, ts: 110 },
      { kind: "album", id: 1, ts: 200 },
    ]);
  });

  it("treats album:1 and artist:1 as different entries", () => {
    const before: RecentlyVisitedEntry[] = [{ kind: "album", id: 1, ts: 100 }];
    const after = recordVisit(before, { kind: "artist", id: 1, ts: 200 });
    expect(after).toHaveLength(2);
  });

  it("caps at 20 entries, dropping the oldest", () => {
    const before: RecentlyVisitedEntry[] = Array.from({ length: 20 }, (_, i) => ({
      kind: "album" as const,
      id: i + 1,
      ts: i + 1,
    }));
    const after = recordVisit(before, { kind: "album", id: 999, ts: 100 });
    expect(after).toHaveLength(20);
    expect(after[0]).toEqual({ kind: "album", id: 2, ts: 2 });
    expect(after[19]).toEqual({ kind: "album", id: 999, ts: 100 });
  });
});
