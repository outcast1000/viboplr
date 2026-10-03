import { describe, expect, it } from "vitest";
import {
  SCENES,
  checkExpect,
  cropRect,
  encodeArgs,
  missingNeeds,
  parseScreenDevice,
  resolveRefs,
  // @ts-expect-error — plain .mjs dev script, no type declarations
} from "../../scripts/lib/captureScenes.mjs";
import { parseNavigateTarget, parseUiAction } from "../utils/uiControl";

describe("SCENES", () => {
  it("have unique ids and only use API verbs the app accepts", () => {
    const ids = SCENES.map((s: { id: string }) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const facts = { artist: "Kyuss", albumTrackIds: [1, 2], lyricsTrackId: 6, skin0: "default" };
    for (const scene of SCENES) {
      const steps = [...(scene.steps ?? []), ...(scene.during ?? []), ...(scene.after ?? [])];
      for (const step of resolveRefs(steps, facts)) {
        // The same validators the dispatcher runs, so a scene can't ship a
        // request the app would 400 on.
        if (step.navigate) expect(() => parseNavigateTarget(step.navigate)).not.toThrow();
        if (step.action) expect(() => parseUiAction(step.action)).not.toThrow();
      }
    }
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
