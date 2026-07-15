import { describe, it, expect, vi } from "vitest";
import { readPersistedSettings } from "../startup/readPersistedSettings";
import type { AppStore } from "../store";

// Build a fake AppStore whose `entries()` returns a caller-supplied merged
// cache (the store's Rust cache = configured defaults overlaid with the on-disk
// file). `get` is a spy that must NOT be called by readPersistedSettings — the
// whole point of the refactor is one `entries()` IPC instead of ~29 `get`s.
function makeStore(pairs: Array<[string, unknown]>) {
  const get = vi.fn(async (key: string) => {
    const hit = pairs.find(([k]) => k === key);
    return hit ? hit[1] : undefined;
  });
  const entries = vi.fn(async () => pairs);
  const store: AppStore = {
    get: get as AppStore["get"],
    set: vi.fn(async () => {}),
    entries: entries as AppStore["entries"],
    init: vi.fn(async () => {}),
    save: vi.fn(async () => {}),
  };
  return { store, get, entries };
}

describe("readPersistedSettings", () => {
  it("maps present keys to their values and absent keys to undefined", async () => {
    const { store } = makeStore([
      ["volume", 0.5],
      ["muted", true],
      ["crossfadeSecs", 3], // default-seeded key present in the merged cache
      ["playbackEngine", "native"],
      ["miniMode", true],
      ["fullWindowWidth", 1200],
      ["fullWindowHeight", 800],
      ["trackColumns", [{ key: "title", visible: true }]],
      ["searchViewModes", { tracks: "list", albums: "tiles", artists: "tiles" }],
      ["uiZoom", 1.25],
      // Intentionally omitted: queueWidth, reduceMotion, lastDownloadDest, ...
    ]);

    const s = await readPersistedSettings(store);

    // Present → value
    expect(s.vol).toBe(0.5);
    expect(s.muted).toBe(true);
    expect(s.crossfadeSecs).toBe(3);
    expect(s.playbackEngine).toBe("native");
    expect(s.miniMode).toBe(true);
    expect(s.fullWindowWidth).toBe(1200);
    expect(s.fullWindowHeight).toBe(800);
    expect(s.trackColumns).toEqual([{ key: "title", visible: true }]);
    expect(s.searchViewModes).toEqual({ tracks: "list", albums: "tiles", artists: "tiles" });
    expect(s.uiZoom).toBe(1.25);

    // Absent → undefined (exactly what per-key `get` returned before)
    expect(s.queueWidth).toBeUndefined();
    expect(s.reduceMotion).toBeUndefined();
    expect(s.lastDownloadDest).toBeUndefined();
    expect(s.pluginViewMode).toBeUndefined();
  });

  it("preserves falsy values (0, false, empty string, null) without dropping them", async () => {
    const { store } = makeStore([
      ["volume", 0],
      ["miniMode", false],
      ["trackSortField", ""],
      ["fullWindowWidth", null],
      ["uiZoom", 0],
    ]);

    const s = await readPersistedSettings(store);

    expect(s.vol).toBe(0);
    expect(s.miniMode).toBe(false);
    expect(s.trackSortField).toBe("");
    expect(s.fullWindowWidth).toBeNull();
    expect(s.uiZoom).toBe(0);
  });

  it("reads the whole store in a single entries() IPC and never calls get()", async () => {
    const { store, get, entries } = makeStore([["volume", 1]]);

    await readPersistedSettings(store);

    expect(entries).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
  });
});
