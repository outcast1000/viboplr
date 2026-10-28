import { describe, expect, it } from "vitest";
import { parseAssistantSkin } from "../utils/controlApi";
import {
  END_CARD_SECS,
  MIN_CROP_SOURCE_W,
  SHORTS,
  serverRedactions,
  isShowcaseName,
  chatWindows,
  chatHtml,
  fillFacts,
  ROADHOUSE_SKIN,
  SHORT_H,
  SHORT_W,
  canvasFor,
  captionHtml,
  captionWindows,
  composeArgs,
  endCardHtml,
  frameRegion,
  piecewiseExpr,
  toVideoRect,
  usesInput,
  // @ts-expect-error — plain .mjs dev script, no type declarations
} from "../../scripts/lib/shorts.mjs";

/**
 * The pure half of `npm run short`: where the virtual camera points and the
 * ffmpeg graph it becomes. The runner itself needs the app, a screen and
 * ffmpeg; these are the decisions that make a short right or wrong.
 */

const canvas = canvasFor(2880, 1800);

/** Evaluate one of the camera's ffmpeg expressions in JS (they only use
 *  if / lt / clip and arithmetic). */
function evalExpr(expr: string, t: number): number {
  const js = expr
    .replace(/\(on\/30\)/g, String(t))
    .replace(/\bif\(/g, "iff(")
    .replace(/\blt\(/g, "ltf(")
    .replace(/\bclip\(/g, "clipf(");
  const fn = new Function("iff", "ltf", "clipf", `return ${js};`);
  return fn(
    (c: boolean, a: number, b: number) => (c ? a : b),
    (a: number, b: number) => a < b,
    (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi),
  );
}

describe("canvas and framing", () => {
  it("letterboxes the window into a 9:16 canvas of the same width", () => {
    expect(canvas).toEqual({ width: 2880, height: 5120, top: 1660, videoH: 1800 });
    expect(canvasFor(1080, 1920).height).toBe(1920);
  });

  it("maps viewport CSS px to video px", () => {
    expect(toVideoRect([10, 20, 30, 40], 2)).toEqual([20, 40, 60, 80]);
  });

  it("shows the whole canvas for no rect, and 9:16 regions otherwise", () => {
    expect(frameRegion(null, canvas)).toEqual({ x: 0, y: 0, w: 2880, h: 5120 });
    const r = frameRegion([1200, 600, 400, 300], canvas, { pad: 100 });
    expect(r.w / r.h).toBeCloseTo(9 / 16, 2);
  });

  it("never crops below the sharpness floor", () => {
    const r = frameRegion([1400, 900, 40, 20], canvas);
    expect(r.w).toBe(MIN_CROP_SOURCE_W);
  });

  it("keeps a short region out of the letterbox bands and inside the canvas", () => {
    // A small target at the very top of the window.
    const r = frameRegion([0, 0, 200, 100], canvas);
    expect(r.y).toBeGreaterThanOrEqual(canvas.top);
    expect(r.x).toBe(0);
    // ...and at the bottom-right corner.
    const s = frameRegion([2800, 1750, 80, 50], canvas);
    expect(s.y + s.h).toBeLessThanOrEqual(canvas.top + canvas.videoH);
    expect(s.x + s.w).toBeLessThanOrEqual(canvas.width);
  });

  it("covers the whole video height when the region is taller than it", () => {
    const r = frameRegion([200, 100, 1300, 1600], canvas);
    expect(r.h).toBeGreaterThan(canvas.videoH);
    expect(r.y).toBeLessThanOrEqual(canvas.top);
    expect(r.y + r.h).toBeGreaterThanOrEqual(canvas.top + canvas.videoH);
  });
});

describe("camera expressions", () => {
  const keys = [
    { t: 0, region: { x: 0, y: 0, w: 2880, h: 5120 } },
    { t: 2, region: { x: 400, y: 1600, w: 1200, h: 2133 } },
    { t: 2.3, region: { x: 900, y: 1800, w: 1000, h: 1778 } },
  ];

  it("holds, eases and holds again", () => {
    const x = piecewiseExpr(keys, "x", { moveSecs: 0.7 });
    expect(evalExpr(x, 0)).toBe(0);
    expect(evalExpr(x, 1.99)).toBe(0);
    const mid = evalExpr(x, 2.15);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(400);
    // The second move starts before the first could finish: the first is cut
    // to the gap, so it lands exactly when the next begins.
    expect(evalExpr(x, 2.3)).toBeCloseTo(400, 3);
    expect(evalExpr(x, 3.5)).toBe(900);
  });

  it("is monotonic within a move (smoothstep, no overshoot)", () => {
    const w = piecewiseExpr(keys.slice(0, 2), "w", { moveSecs: 1 });
    let prev = Infinity;
    for (let t = 2; t <= 3; t += 0.05) {
      const v = evalExpr(w, t);
      expect(v).toBeLessThanOrEqual(prev + 1e-9);
      prev = v;
    }
    expect(evalExpr(w, 3)).toBe(1200);
  });
});

describe("captions and the ffmpeg command", () => {
  it("shows each caption until the next one, inside the recording", () => {
    const windows = captionWindows([
      { caption: "One", startedAt: 0.1 },
      { startedAt: 2 },
      { caption: "Two", startedAt: 4 },
    ], 10);
    expect(windows).toEqual([
      { text: "One", start: 0.1, end: 3.95 },
      { text: "Two", start: 4, end: 9.95 },
    ]);
  });

  it("builds a silent 1080x1920 short with the end card appended", () => {
    const args: string[] = composeArgs({
      raw: "raw.mp4", canvas,
      keys: [{ t: 0, region: frameRegion(null, canvas) }],
      captions: [{ text: "A", start: 0, end: 3 }],
      captionPngs: ["a.png"], endCard: "end.png", out: "out.mp4", durationSecs: 12,
    });
    const graph = args[args.indexOf("-filter_complex") + 1];
    expect(graph).toContain(`s=${SHORT_W}x${SHORT_H}`);
    expect(graph).toContain("overlay=0:1660");
    expect(graph).toContain("enable='between(t,0,3)'");
    expect(graph).toContain("concat=n=2:v=1:a=0");
    expect(args).not.toContain("[a]");
    expect(args[args.indexOf("-t", args.indexOf("-filter_complex")) + 1]).toBe(String(12 + END_CARD_SECS));
  });

  it("mixes a music bed only when asked", () => {
    const args: string[] = composeArgs({
      raw: "raw.mp4", canvas, keys: [{ t: 0, region: frameRegion(null, canvas) }],
      captions: [], captionPngs: [], endCard: "end.png", out: "out.mp4", durationSecs: 10, music: "bed.mp3",
    });
    expect(args).toContain("bed.mp3");
    expect(args).toContain("[a]");
    expect(args.join(" ")).toContain("loudnorm=I=-16");
  });

  it("escapes caption text and keeps line breaks", () => {
    const html = captionHtml("A <b> & B\nsecond");
    expect(html).toContain("A &lt;b&gt; &amp; B</span><br><span>second");
    expect(endCardHtml("<svg/>")).toContain("viboplr.com");
    expect(captionHtml("x")).toContain("top:250px");
    expect(captionHtml("x", { top: 1180 })).toContain("top:1180px");
  });
});

describe("scenarios", () => {
  it("are well-formed: ordered beats, a caption to open on, a window size", () => {
    for (const s of SHORTS) {
      expect(s.window.width).toBeGreaterThan(0);
      expect(s.beats[0].at).toBe(0);
      expect(s.beats[0].caption).toBeTruthy();
      for (let i = 1; i < s.beats.length; i++) expect(s.beats[i].at).toBeGreaterThan(s.beats[i - 1].at);
      expect(s.beats[s.beats.length - 1].at).toBeLessThan(s.seconds * 1000);
    }
  });

  it("know which of them need Click and type", () => {
    const byId = Object.fromEntries(SHORTS.map((s: { id: string }) => [s.id, usesInput(s)]));
    expect(byId["collectors-bulk-edit"]).toBe(true);
    expect(byId["tinkerers-skins"]).toBe(false);
    expect(byId["audiophiles-pure-or-shaped"]).toBe(true);
    expect(byId["self-hosters-server"]).toBe(false);
  });

  it("keep the whole conversation up, one frame per message", () => {
    const beats = [
      { startedAt: 0, caption: "Hook" },
      { startedAt: 27.2, caption: "Or just ask your AI", captionTop: 150, chat: { role: "user", text: "Make it light" } },
      { startedAt: 29.4, chat: { role: "assistant", text: "Done." } },
    ];
    const chats = chatWindows(beats, 38);
    expect(chats).toEqual([
      { messages: [{ role: "user", text: "Make it light" }], start: 27.2, end: 29.35 },
      { messages: [{ role: "user", text: "Make it light" }, { role: "assistant", text: "Done." }], start: 29.4, end: 37.95 },
    ]);
    expect(captionWindows(beats, 38)[1].top).toBe(150);
    expect(captionWindows(beats, 38)[0].top).toBeUndefined();
    const html = chatHtml(chats[1].messages);
    expect(html).toContain("Your AI");
    expect(html).toContain("Make it light");
  });

  it("design a skin the create-skin route accepts", () => {
    const r = parseAssistantSkin(ROADHOUSE_SKIN);
    expect("skin" in r).toBe(true);
  });

  it("fill facts into on-screen text, leaving unknown names as written", () => {
    const facts = { artist: "The Doors", showcaseAlbum: "Morrison Hotel", showcaseTrackId: 7 };
    expect(fillFacts("$showcaseAlbum, by $artist.", facts)).toBe("Morrison Hotel, by The Doors.");
    expect(fillFacts("Track $showcaseTrackId and $nope", facts)).toBe("Track $showcaseTrackId and $nope");
  });

  it("keep Greek and placeholder names off camera", () => {
    expect(isShowcaseName("Bob Dylan")).toBe(true);
    expect(isShowcaseName("Blonde on Blonde")).toBe(true);
    expect(isShowcaseName("Μωρά Στη Φωτιά")).toBe(false);
    expect(isShowcaseName("Live in Ἀθῆναι")).toBe(false);
    expect(isShowcaseName("[Unknown Album]")).toBe(false);
    expect(isShowcaseName("Various Artists")).toBe(false);
    expect(isShowcaseName("")).toBe(false);
  });

  it("keep a real server's address off camera", () => {
    const rules = serverRedactions([
      { kind: "local", url: null, name: "Music" },
      { kind: "subsonic", url: "https://Navidrome.example.org/", name: "Navidrome.example.org" },
      { kind: "subsonic", url: "http://10.0.0.5:4533", name: "Home" },
    ]);
    expect(rules).toEqual([
      { text: "https://Navidrome.example.org", replacement: "https://navidrome.local" },
      { text: "Navidrome.example.org", replacement: "Navidrome" },
      { text: "http://10.0.0.5:4533", replacement: "https://navidrome.local" },
      { text: "10.0.0.5", replacement: "navidrome.local" },
    ]);
  });

  it("never write version numbers into captions (they must not age)", () => {
    for (const s of SHORTS) for (const b of s.beats) if (b.caption) expect(b.caption).not.toMatch(/\bv?\d+\.\d+/);
  });
});
