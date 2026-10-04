import { describe, expect, it } from "vitest";
import {
  MINI_LAYOUTS,
  MINI_WIDTHS,
  SCENES,
  SCREENSHOT_SCENES,
  checkExpect,
  cropRect,
  encodeArgs,
  gridComposeArgs,
  gridLayout,
  missingNeeds,
  parseRedactArg,
  parseScreenDevice,
  resolveRefs,
  sceneFile,
  // @ts-expect-error — plain .mjs dev script, no type declarations
} from "../../scripts/lib/captureScenes.mjs";
import { parseMiniSizes, parseNavigateTarget, parseRedact, parseUiAction } from "../utils/uiControl";
import { MINI_RESTING_SIZES, MINI_WIDTH_SIZES } from "../utils/miniSizes";
import { existsSync } from "node:fs";

describe("SCENES", () => {
  it("have unique ids and only use API verbs the app accepts", () => {
    const all = [...SCENES, ...SCREENSHOT_SCENES];
    const ids = all.map((s: { id: string }) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const facts = {
      artist: "Glass Harbour", albumTrackIds: [1, 2], lyricsTrackId: 6, skin0: "default",
      flacTrackId: 9, flacArtist: "Low Saturn Club", detailAlbumTitle: "Afterglow Arcade",
      detailAlbumArtist: "Neon Orchard", detailTrackTitle: "Paper Lanterns",
      detailTrackArtist: "Glass Harbour", searchQuery: "harbour",
    };
    for (const scene of all) {
      const steps = [...(scene.steps ?? []), ...(scene.during ?? []), ...(scene.after ?? [])];
      for (const step of resolveRefs(steps, facts)) {
        // The same validators the dispatcher runs, so a scene can't ship a
        // request the app would 400 on.
        if (step.navigate) expect(() => parseNavigateTarget(step.navigate)).not.toThrow();
        if (step.action) expect(() => parseUiAction(step.action)).not.toThrow();
        if (step.window) expect(() => parseMiniSizes(step.window)).not.toThrow();
      }
      // A grid's cells are window requests too.
      for (const row of scene.rows ?? []) {
        for (const col of scene.cols ?? []) expect(parseMiniSizes({ ...row, ...col })).not.toBeNull();
      }
    }
  });

  it("write the screenshot names the site already links to", () => {
    const files = SCREENSHOT_SCENES.map(sceneFile);
    expect(new Set(files).size).toBe(files.length);
    for (const f of files) expect(existsSync(`docs/assets/screenshots/${f}.webp`)).toBe(true);
  });

  it("name the mini sizes the app knows, every one of them", () => {
    expect([...MINI_LAYOUTS].sort()).toEqual([...MINI_RESTING_SIZES].sort());
    expect([...MINI_WIDTHS].sort()).toEqual([...MINI_WIDTH_SIZES].sort());
  });
});

describe("parseRedactArg", () => {
  it("splits on commas and takes an optional =replacement", () => {
    expect(parseRedactArg("outcast1000=you, Private Mix")).toEqual([
      { text: "outcast1000", replacement: "you" },
      { text: "Private Mix" },
    ]);
    expect(parseRedactArg("")).toEqual([]);
  });

  it("produces rules the app accepts", () => {
    expect(() => parseRedact(parseRedactArg("outcast1000=you,Private Mix"))).not.toThrow();
  });
});

describe("gridLayout / gridComposeArgs", () => {
  const cells = [
    [{ width: 280, height: 24 }, { width: 400, height: 24 }],
    [{ width: 280, height: 52 }, { width: 400, height: 52 }],
  ];

  it("sizes columns by their widest cell and rows by their tallest", () => {
    const layout = gridLayout(cells, 10);
    expect(layout.at).toEqual([
      [{ x: 10, y: 10 }, { x: 300, y: 10 }],
      [{ x: 10, y: 44 }, { x: 300, y: 44 }],
    ]);
    expect(layout).toMatchObject({ width: 710, height: 106 });
  });

  it("paints every cell once, masked, onto a transparent canvas", () => {
    const layout = gridLayout(cells, 10);
    const args = gridComposeArgs(["a.png", "b.png", "c.png", "d.png"], layout, "out.png", { inset: 1, radius: 8 });
    const graph = args[args.indexOf("-filter_complex") + 1];
    expect(graph).toContain("black@0.0:s=710x106");
    expect(graph.match(/overlay=/g)).toHaveLength(4);
    expect(graph.match(/geq=/g)).toHaveLength(4);
    expect(graph).toContain("crop=iw-2:ih-2:1:1");
    expect(args.at(-1)).toBe("out.png");
    expect(() => gridComposeArgs(["a.png"], layout, "out.png")).toThrow(/one png per grid cell/);
  });
});

describe("checkExpect", () => {
  const state = { view: "nowplaying", panels: { eqPanel: true, lyricsHidden: false }, modals: ["download"] };

  it("passes a matching state", () => {
    expect(checkExpect(state, { view: "nowplaying", panels: { eqPanel: true }, modals: ["download"] })).toEqual([]);
  });

  it("reports every mismatch, not just the first", () => {
    const problems = checkExpect(state, { view: "home", panels: { eqPanel: false }, modals: ["bulk-edit"] });
    expect(problems).toHaveLength(3);
  });

  it("checks for an open track page, which is a selection rather than a view", () => {
    expect(checkExpect({ ...state, selection: { track: "lib:4" } }, { track: true })).toEqual([]);
    expect(checkExpect({ ...state, selection: { track: null } }, { track: true })).toHaveLength(1);
    expect(checkExpect({ ...state, view: "artists", selection: { albumId: 13 } }, { album: true })).toEqual([]);
    expect(checkExpect({ ...state, selection: { albumId: null } }, { album: true })).toHaveLength(1);
  });

  it("treats no expectation as a pass", () => {
    expect(checkExpect(state, undefined)).toEqual([]);
  });
});

describe("resolveRefs", () => {
  it("substitutes nested references and refuses unknown ones", () => {
    expect(resolveRefs({ navigate: { artist: "$artist" } }, { artist: "Kyuss" })).toEqual({ navigate: { artist: "Kyuss" } });
    expect(() => resolveRefs({ a: "$missing" }, {})).toThrow(/no value/);
  });
});

describe("missingNeeds", () => {
  it("names what a scene lacks", () => {
    const scene = { needs: ["track", "plugin:ytdlp"] };
    expect(missingNeeds(scene, { hasTrack: true, pluginIds: ["ytdlp"] })).toEqual([]);
    expect(missingNeeds(scene, { hasTrack: false, pluginIds: [] })).toHaveLength(2);
    expect(missingNeeds({ needs: ["flac"] }, { hasTrack: true, pluginIds: [] })).toHaveLength(1);
    expect(missingNeeds({ needs: ["flac"] }, { hasTrack: true, hasFlacTrack: true, pluginIds: [] })).toEqual([]);
  });
});

describe("cropRect", () => {
  it("scales to physical pixels and keeps sizes even", () => {
    expect(cropRect({ x: 40, y: 60, width: 1441, height: 901 }, 2, { width: 6000, height: 4000 }))
      .toEqual({ x: 80, y: 120, width: 2882, height: 1802 });
  });

  it("clamps padding to the screen", () => {
    expect(cropRect({ x: 10, y: 10, width: 400, height: 52 }, 2, { width: 3024, height: 1964 }, 50))
      .toEqual({ x: 0, y: 0, width: 920, height: 224 });
  });
});

describe("encodeArgs / parseScreenDevice", () => {
  it("builds muted web encodes", () => {
    const a = encodeArgs("raw.mov", "out/home");
    expect(a.mp4).toContain("-an");
    expect(a.mp4.at(-1)).toBe("out/home.mp4");
    expect(a.webm).toContain("libvpx-vp9");
  });

  it("finds the main screen device", () => {
    const listing = "[AVFoundation indev] [0] FaceTime HD Camera\n[AVFoundation indev] [1] Capture screen 0\n";
    expect(parseScreenDevice(listing)).toBe(1);
    expect(parseScreenDevice("[0] FaceTime HD Camera")).toBeNull();
  });
});
