import { describe, it, expect } from "vitest";
import { presetIds, rowActions, rowClickOpens } from "../components/pluginViews/pluginViews";

// A list of TRACKS wants the library's behaviour: click selects, double-click
// plays. A list of CONTAINERS (torrents, folders) wants the opposite — clicking
// a thing you can open should open it. `openOnClick` is the per-list opt-in.
describe("rowClickOpens", () => {
  const plain = { meta: false, ctrl: false, shift: false };

  it("leaves every existing list alone", () => {
    // The flag is absent on every list that existed before it, so a plain click
    // must still select there.
    expect(rowClickOpens(undefined, plain)).toBe(false);
    expect(rowClickOpens(false, plain)).toBe(false);
  });

  it("opens on a plain click when opted in", () => {
    expect(rowClickOpens(true, plain)).toBe(true);
    expect(rowClickOpens(true, {})).toBe(true);
  });

  it("still selects on a modifier click", () => {
    // Otherwise an opt-in list would have no way to build the multi-selection
    // its own toolbar acts on — Start / Stop / Remove would become unreachable.
    expect(rowClickOpens(true, { meta: true })).toBe(false);
    expect(rowClickOpens(true, { ctrl: true })).toBe(false);
    expect(rowClickOpens(true, { shift: true })).toBe(false);
    expect(rowClickOpens(true, { meta: true, shift: true })).toBe(false);
  });

  it("opens on a modifier click when the list is single-select", () => {
    // The exception above exists to keep a multi-selection reachable. A
    // single-select list has none, and no toolbar to act on one, so a
    // Cmd-click that refused to open the row would just be a dead click.
    expect(rowClickOpens(true, { meta: true }, "single")).toBe(true);
    expect(rowClickOpens(true, { shift: true }, "single")).toBe(true);
    expect(rowClickOpens(true, { meta: true }, "multi")).toBe(false);
    // And an absent mode is still multi, so nothing that shipped changes.
    expect(rowClickOpens(true, { meta: true }, undefined)).toBe(false);
  });

  it("does not turn a non-opted-in list into an opening one", () => {
    expect(rowClickOpens(false, plain, "single")).toBe(false);
    expect(rowClickOpens(undefined, { meta: true }, "single")).toBe(false);
  });

  it("never opens on a modifier click in an opted-out list either", () => {
    expect(rowClickOpens(false, { meta: true })).toBe(false);
    expect(rowClickOpens(undefined, { shift: true })).toBe(false);
  });

  // openOnClick: "title" splits the row instead of splitting on modifiers —
  // the name opens, the rest of the row selects (qBittorrent's torrent list).
  describe("title mode", () => {
    it("opens only when the click landed on the title", () => {
      expect(rowClickOpens("title", plain, "single", true)).toBe(true);
      expect(rowClickOpens("title", plain, "single", false)).toBe(false);
      expect(rowClickOpens("title", plain, "single", undefined)).toBe(false);
    });

    it("selects on a modifier click even on the title, in both selection modes", () => {
      // Selection is reachable with a plain body click here, so unlike plain
      // open-on-click there is no single-select carve-out: a modifier click
      // always selects, same as the body click it stands in for.
      expect(rowClickOpens("title", { meta: true }, "single", true)).toBe(false);
      expect(rowClickOpens("title", { shift: true }, "multi", true)).toBe(false);
      expect(rowClickOpens("title", { ctrl: true }, undefined, true)).toBe(false);
    });

    it("works the same in multi-select lists", () => {
      expect(rowClickOpens("title", plain, "multi", true)).toBe(true);
      expect(rowClickOpens("title", plain, "multi", false)).toBe(false);
    });
  });

  it("ignores the title flag outside title mode", () => {
    // A plain open-on-click list opens wherever the click landed; the hotspot
    // argument must not narrow it retroactively.
    expect(rowClickOpens(true, plain, "multi", false)).toBe(true);
    expect(rowClickOpens(false, plain, "multi", true)).toBe(false);
  });
});

// Selection presets: extra buttons in the All / None group ("Audio", "Video").
// A preset SELECTS rows; it never acts on them — the list's declared `actions`
// are what act on a selection.
describe("presetIds", () => {
  const items = [{ id: "0" }, { id: "1" }, { id: "2" }];

  it("keeps only the ids that have a row", () => {
    // A plugin builds presets from its own data, which can be a render behind
    // the items it supplied. Selecting a phantom id would leave the count
    // reading "3 / 2" and fire an action at something not on screen.
    expect(presetIds({ ids: ["0", "9", "2"] }, items)).toEqual(["0", "2"]);
    expect(presetIds({ ids: ["9"] }, items)).toEqual([]);
    expect(presetIds({ ids: [] }, items)).toEqual([]);
  });

  it("follows the list's order, not the preset's", () => {
    expect(presetIds({ ids: ["2", "0"] }, items)).toEqual(["0", "2"]);
  });

  it("never yields duplicates, whatever the preset says", () => {
    expect(presetIds({ ids: ["1", "1"] }, items)).toEqual(["1"]);
  });
});

// Per-row action subsets. The list declares its actions once — that's what makes
// the overlay buttons line up down the column — but which of them APPLY can
// differ per row: a file already queued for download wants "Skip" where a
// skipped one wants "Download".
describe("rowActions", () => {
  const declared = [{ id: "play" }, { id: "enqueue" }, { id: "download" }, { id: "skip" }];

  it("gives every list without the field all of them", () => {
    expect(rowActions(declared, undefined)).toEqual(declared);
  });

  it("keeps only what the row named", () => {
    expect(rowActions(declared, ["play", "enqueue", "skip"]).map((a) => a.id))
      .toEqual(["play", "enqueue", "skip"]);
  });

  it("follows the DECLARED order, not the row's", () => {
    // Otherwise the buttons two rows share would shuffle between them, and the
    // column stops being scannable.
    expect(rowActions(declared, ["skip", "play"]).map((a) => a.id)).toEqual(["play", "skip"]);
  });

  it("ignores ids the list never declared", () => {
    expect(rowActions(declared, ["play", "nonsense"]).map((a) => a.id)).toEqual(["play"]);
  });

  it("copes with an empty subset and an empty list", () => {
    expect(rowActions(declared, [])).toEqual([]);
    expect(rowActions([], ["play"])).toEqual([]);
    expect(rowActions(undefined, ["play"])).toEqual([]);
  });
});
