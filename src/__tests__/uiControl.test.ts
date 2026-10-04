import { describe, expect, it } from "vitest";
import {
  MAX_REDACT_RULES,
  buildUiState,
  parseMiniSizes,
  parseNavigateTarget,
  parseRedact,
  parseUiAction,
  parseWindowGeometry,
} from "../utils/uiControl";
import { SECTION_TABS, SETTINGS_SECTION_IDS } from "../utils/settingsSections";

describe("parseNavigateTarget", () => {
  it("accepts the plain views and the library alias", () => {
    expect(parseNavigateTarget({ view: "home" })).toEqual({ kind: "view", view: "home" });
    expect(parseNavigateTarget({ view: "Library" })).toEqual({ kind: "view", view: "search" });
    expect(parseNavigateTarget({ view: "nowplaying" })).toEqual({ kind: "view", view: "nowplaying" });
  });

  it("refuses detail views, which need an entity", () => {
    expect(() => parseNavigateTarget({ view: "artists" })).toThrow(/open artists\/albums\/tags by name/);
  });

  it("opens entities by name, keeping the optional disambiguators", () => {
    expect(parseNavigateTarget({ artist: " Kyuss " })).toEqual({ kind: "artist", name: "Kyuss" });
    expect(parseNavigateTarget({ album: "Blues for the Red Sun", artistName: "Kyuss" }))
      .toEqual({ kind: "album", name: "Blues for the Red Sun", artistName: "Kyuss" });
    expect(parseNavigateTarget({ tag: "stoner rock" })).toEqual({ kind: "tag", name: "stoner rock" });
    expect(parseNavigateTarget({ track: "Hurricane", artistName: "Kyuss" }))
      .toEqual({ kind: "track", title: "Hurricane", artistName: "Kyuss" });
  });

  it("needs exactly one target", () => {
    expect(() => parseNavigateTarget({})).toThrow(/exactly one/);
    expect(() => parseNavigateTarget({ view: "home", artist: "Kyuss" })).toThrow(/exactly one/);
  });

  it("validates settings sections against the panel's own list", () => {
    expect(parseNavigateTarget({ settings: true })).toEqual({ kind: "settings" });
    expect(parseNavigateTarget({ settings: "radio" })).toEqual({ kind: "settings", section: "radio" });
    expect(() => parseNavigateTarget({ settings: "nope" })).toThrow(/one of/);
    // Every listed section maps to a tab, so navigating can always land on it.
    for (const id of SETTINGS_SECTION_IDS) expect(SECTION_TABS[id]).toBeDefined();
  });

  it("opens plugin views with an optional search seed", () => {
    expect(parseNavigateTarget({ pluginView: { pluginId: "ytdlp", viewId: "search", query: "lofi" } }))
      .toEqual({ kind: "plugin", pluginId: "ytdlp", viewId: "search", query: "lofi" });
    expect(() => parseNavigateTarget({ pluginView: "ytdlp" })).toThrow(/object/);
    expect(() => parseNavigateTarget({ pluginView: { pluginId: "ytdlp" } })).toThrow(/viewId/);
  });
});

describe("parseUiAction", () => {
  it("parses the open/close panel actions", () => {
    expect(parseUiAction({ action: "eqPanel", open: true })).toEqual({ action: "eqPanel", open: true });
    expect(parseUiAction({ action: "queuePanel", open: false })).toEqual({ action: "queuePanel", open: false });
    expect(() => parseUiAction({ action: "eqPanel", open: "yes" })).toThrow(/boolean/);
  });

  it("parses search: a query opens it, an empty one closes it", () => {
    expect(parseUiAction({ action: "search", query: "harbour" })).toEqual({ action: "search", query: "harbour" });
    expect(parseUiAction({ action: "search", query: "" })).toEqual({ action: "search", query: "" });
    expect(() => parseUiAction({ action: "search" })).toThrow(/query/);
  });

  it("checks hero looks against the real list", () => {
    expect(parseUiAction({ action: "heroLook", look: "aurora-drift" })).toEqual({ action: "heroLook", look: "aurora-drift" });
    expect(() => parseUiAction({ action: "heroLook", look: "disco" })).toThrow(/look must be/);
  });

  it("needs positive integer ids for bulk edit", () => {
    expect(parseUiAction({ action: "bulkEdit", trackIds: [3, 4] })).toEqual({ action: "bulkEdit", trackIds: [3, 4] });
    expect(() => parseUiAction({ action: "bulkEdit", trackIds: [] })).toThrow(/non-empty/);
    expect(() => parseUiAction({ action: "bulkEdit", trackIds: [1.5] })).toThrow(/non-empty/);
  });

  it("parses scroll targets", () => {
    expect(parseUiAction({ action: "scroll", to: "bottom" })).toEqual({ action: "scroll", to: "bottom", smooth: false });
    expect(parseUiAction({ action: "scroll", to: 600, smooth: true })).toEqual({ action: "scroll", to: 600, smooth: true });
    expect(() => parseUiAction({ action: "scroll", to: -1 })).toThrow(/pixel offset/);
  });

  it("names the valid actions on a miss", () => {
    expect(() => parseUiAction({ action: "click" })).toThrow(/one of: queuePanel/);
  });

  it("takes showcase redactions as strings or { text, replacement }", () => {
    expect(parseUiAction({ action: "showcase", on: true })).toEqual({ action: "showcase", on: true, redact: [] });
    expect(parseUiAction({ action: "showcase", on: true, redact: ["outcast", { text: "Poop Song", replacement: "Mix" }] }))
      .toEqual({
        action: "showcase", on: true,
        redact: [{ text: "outcast", replacement: "•••" }, { text: "Poop Song", replacement: "Mix" }],
      });
  });
});

describe("parseRedact", () => {
  it("refuses rules short enough to hit ordinary words, and too many rules", () => {
    expect(() => parseRedact(["ab"])).toThrow(/at least 3/);
    expect(() => parseRedact("name")).toThrow(/array/);
    expect(() => parseRedact([{ text: "name", replacement: 5 }])).toThrow(/replacement/);
    expect(() => parseRedact(Array.from({ length: MAX_REDACT_RULES + 1 }, (_, i) => `rule${i}`))).toThrow(/at most/);
  });
});

describe("parseMiniSizes", () => {
  it("is null when neither mini size is present", () => {
    expect(parseMiniSizes({ mini: true })).toBeNull();
  });

  it("takes either size alone, by the app's own names", () => {
    expect(parseMiniSizes({ miniSize: "full" })).toEqual({ miniSize: "full" });
    expect(parseMiniSizes({ miniWidth: "small", miniSize: "compact" })).toEqual({ miniSize: "compact", miniWidth: "small" });
    expect(() => parseMiniSizes({ miniSize: "huge" })).toThrow(/normal, compact, full/);
    expect(() => parseMiniSizes({ miniWidth: 400 })).toThrow(/small, medium, large/);
  });
});

describe("parseWindowGeometry", () => {
  it("is null when no geometry field is present", () => {
    expect(parseWindowGeometry({ mini: true })).toBeNull();
  });

  it("takes size and position as pairs", () => {
    expect(parseWindowGeometry({ width: 1440, height: 900 })).toEqual({ width: 1440, height: 900 });
    expect(parseWindowGeometry({ x: 0, y: 25, width: 1440, height: 900 })).toEqual({ x: 0, y: 25, width: 1440, height: 900 });
    expect(() => parseWindowGeometry({ width: 1440 })).toThrow(/together/);
    expect(() => parseWindowGeometry({ x: 10 })).toThrow(/together/);
  });

  it("refuses a window too small for the layout", () => {
    expect(() => parseWindowGeometry({ width: 300, height: 200 })).toThrow(/at least/);
  });
});

describe("buildUiState", () => {
  it("groups the snapshot", () => {
    const state = buildUiState({
      view: "artists", selectedArtistId: 7, selectedAlbumId: null, selectedTagId: null, selectedTrack: null,
      settingsSection: null, queueCollapsed: false, nowPlayingAbout: false, lyricsHidden: false, eqPanel: true,
      modals: ["bulk-edit"], showcase: true, heroLook: "minimal", bitPerfect: null,
    });
    expect(state.selection.artistId).toBe(7);
    expect(state.panels.eqPanel).toBe(true);
    expect(state.modals).toEqual(["bulk-edit"]);
  });
});
