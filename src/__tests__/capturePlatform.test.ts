import { describe, expect, it } from "vitest";
import {
  gdigrabStillArgs,
  grabInputArgs,
  profilesDir,
  webpArgs,
  // @ts-expect-error — plain .mjs dev script, no type declarations
} from "../../scripts/lib/capturePlatform.mjs";

const rect = { x: 80, y: 120, width: 2880, height: 1800 };

describe("profilesDir", () => {
  it("follows the app's layout on each platform", () => {
    expect(profilesDir("darwin", {}, "/Users/a")).toBe("/Users/a/Library/Application Support/com.alex.viboplr/profiles");
    expect(profilesDir("win32", { APPDATA: "C:/Users/a/AppData/Roaming" }, "C:/Users/a"))
      .toMatch(/AppData[\\/]Roaming[\\/]com\.alex\.viboplr[\\/]profiles$/);
  });
});

describe("grabInputArgs", () => {
  it("records the whole screen on macOS and crops in the filter", () => {
    const g = grabInputArgs("darwin", rect, { device: 1, seconds: 9 });
    expect(g.input).toContain("avfoundation");
    expect(g.input).toContain("1:none");
    expect(g.filter).toBe("crop=2880:1800:80:120");
  });

  it("crops at the source with gdigrab on Windows, without the pointer", () => {
    const g = grabInputArgs("win32", rect, { seconds: 9 });
    expect(g.input).toEqual(expect.arrayContaining(["gdigrab", "-draw_mouse", "0", "-offset_x", "80", "-offset_y", "120", "-video_size", "2880x1800", "desktop", "-t", "9"]));
    expect(g.filter).toBeNull();
  });

  it("refuses other platforms by name", () => {
    expect(() => grabInputArgs("linux", rect)).toThrow(/macOS and Windows only/);
  });
});

describe("stills and webp", () => {
  it("grabs one frame for a Windows still", () => {
    const a = gdigrabStillArgs(rect, "out.png");
    expect(a).toEqual(expect.arrayContaining(["-frames:v", "1", "out.png"]));
  });

  it("crops the bottom with cwebp (pixel size) or ffmpeg (filter)", () => {
    const c = webpArgs("in.png", "out.webp", { cropBottom: 0.25, encoder: "cwebp", size: { width: 2880, height: 1800 } });
    expect(c.cmd).toBe("cwebp");
    expect(c.args).toEqual(expect.arrayContaining(["-crop", "0", "0", "2880", "1350"]));
    const f = webpArgs("in.png", "out.webp", { cropBottom: 0.25, encoder: "ffmpeg" });
    expect(f.cmd).toBe("ffmpeg");
    expect(f.args).toContain("libwebp");
    expect(f.args.join(" ")).toContain("crop=iw:trunc(ih*0.7500/2)*2:0:0");
  });
});
