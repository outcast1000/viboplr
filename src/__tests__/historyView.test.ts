import { describe, it, expect } from "vitest";
import {
  coerceHistorySettings, rangeSinceTs, historyQueueTrack, playsLabel, DEFAULT_HISTORY_SETTINGS,
} from "../utils/historyView";
import { toggleSortKey } from "../sortChain";

describe("coerceHistorySettings", () => {
  it("returns the defaults for nothing saved", () => {
    expect(coerceHistorySettings(undefined)).toEqual(DEFAULT_HISTORY_SETTINGS);
    expect(coerceHistorySettings("garbage")).toEqual(DEFAULT_HISTORY_SETTINGS);
  });

  it("keeps valid fields and replaces malformed ones one by one", () => {
    const s = coerceHistorySettings({
      activeTab: "artists",
      sortChains: { tracks: [{ field: "title", dir: "asc" }], recent: [{ field: 3 }] },
      range: "year",
      viewModes: { artists: "tiles", tracks: "carousel" },
      sortBarCollapsed: false,
    });
    expect(s.activeTab).toBe("artists");
    expect(s.sortChains).toEqual({ recent: [], tracks: [{ field: "title", dir: "asc" }], artists: [] });
    expect(s.range).toBe("year");
    expect(coerceHistorySettings({ range: "forever" }).range).toBe("30-days");
    expect(s.viewModes).toEqual({ recent: "list", tracks: "list", artists: "tiles" });
    expect(s.sortBarCollapsed).toBe(false);
  });

  it("rejects an unknown tab", () => {
    expect(coerceHistorySettings({ activeTab: "albums" }).activeTab).toBe("recent");
  });
});

describe("rangeSinceTs", () => {
  it("is null for all time and counts back whole days otherwise", () => {
    expect(rangeSinceTs("all-time", 1_000_000_000)).toBeNull();
    expect(rangeSinceTs("30-days", 1_000_000_000)).toBe(1_000_000_000 - 30 * 86400);
    expect(rangeSinceTs("year", 1_000_000_000)).toBe(1_000_000_000 - 365 * 86400);
  });
});

describe("historyQueueTrack", () => {
  const base = {
    display_title: "Teardrop",
    display_artist: "Massive Attack",
    display_album: "Mezzanine",
    display_album_artist: "Massive Attack",
  };

  it("carries the library copy's id, path, length and format", () => {
    const q = historyQueueTrack({
      ...base,
      display_path: "file:///m/teardrop.flac",
      display_track_id: 42,
      display_duration_secs: 330,
      display_format: "flac",
    });
    expect(q).toMatchObject({
      libraryId: 42, path: "file:///m/teardrop.flac", title: "Teardrop", artist_name: "Massive Attack",
      album_title: "Mezzanine", album_artist_name: "Massive Attack", duration_secs: 330, format: "flac",
    });
    expect(q.key).toMatch(/^q:/);
  });

  it("is metadata-only for a play with no library copy", () => {
    const q = historyQueueTrack({ ...base, display_album: null, display_album_artist: null, display_path: null });
    expect(q).toMatchObject({ libraryId: null, path: null, title: "Teardrop", duration_secs: null, format: null });
  });

  it("mints a fresh key per entry", () => {
    const row = { ...base, display_path: null };
    expect(historyQueueTrack(row).key).not.toBe(historyQueueTrack(row).key);
  });
});

describe("history sort fields", () => {
  it("open descending: latest played first, most plays first", () => {
    expect(toggleSortKey([], "played", false)).toEqual([{ field: "played", dir: "desc" }]);
    expect(toggleSortKey([], "plays", false)).toEqual([{ field: "plays", dir: "desc" }]);
    expect(toggleSortKey([], "title", false)).toEqual([{ field: "title", dir: "asc" }]);
  });
});

it("playsLabel", () => {
  expect(playsLabel(1)).toBe("1 play");
  expect(playsLabel(0)).toBe("0 plays");
  expect(playsLabel(12)).toBe("12 plays");
});
