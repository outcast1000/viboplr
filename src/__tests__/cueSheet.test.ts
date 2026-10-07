import { describe, expect, it } from "vitest";
import { activeCueIndex, cueCountBucket, cueCredit, cueEnd, cueErrorField, cuePastEndError, cueSheetDetails, cueTimingNote, DEFAULT_CUE_SECS, sameCueSong, splitSheetMeta, type Cue } from "../utils/cueSheet";
import { CONTEXT_IMAGE_CAP, galleryImages, lyricsForContext, proseText, PROSE_CHAR_CAP } from "../utils/cueContext";

const cues: Cue[] = [
  { at: 5, kind: "text", text: "intro" },
  { at: 12, until: 30, kind: "quote", text: "line", caption: "meaning" },
  { at: 20, kind: "text", text: "cuts the quote short" },
  { at: 60, until: 62, kind: "text", text: "brief" },
];

describe("cue timing", () => {
  it("defaults the dwell and never runs into the next cue", () => {
    expect(cueEnd(cues, 0)).toBe(5 + DEFAULT_CUE_SECS > 12 ? 12 : 5 + DEFAULT_CUE_SECS);
    expect(cueEnd(cues, 1)).toBe(20); // own until (30) cut by the next cue at 20
    expect(cueEnd(cues, 2)).toBe(20 + DEFAULT_CUE_SECS);
    expect(cueEnd(cues, 3)).toBe(62);
  });

  it("finds the card on screen, and nothing in the gaps", () => {
    expect(activeCueIndex(cues, 0)).toBe(-1);
    expect(activeCueIndex(cues, 5)).toBe(0);
    expect(activeCueIndex(cues, 11.9)).toBe(0);
    expect(activeCueIndex(cues, 12)).toBe(1);
    expect(activeCueIndex(cues, 25)).toBe(2);
    expect(activeCueIndex(cues, 45)).toBe(-1); // 2 ended at 30
    expect(activeCueIndex(cues, 61)).toBe(3);
    expect(activeCueIndex(cues, 62)).toBe(-1);
    expect(activeCueIndex([], 10)).toBe(-1);
  });

  it("matches songs the way the backend keys them", () => {
    expect(sameCueSong({ title: "Jóga", artistName: "Björk" }, { title: "joga", artistName: "BJORK" })).toBe(true);
    expect(sameCueSong({ title: "Joga", artistName: null }, { title: "joga" })).toBe(true);
    expect(sameCueSong({ title: "Joga", artistName: "Björk" }, { title: "Joga", artistName: "Other" })).toBe(false);
  });
});

describe("cue context shaping", () => {
  it("turns synced LRC into timed lines and drops instrumental gaps", () => {
    const out = lyricsForContext({ kind: "synced", text: "[00:01.50]First\n[00:04.00]\n[00:07.25]Second" });
    expect(out).toEqual({ kind: "synced", lines: [{ at: 1.5, text: "First" }, { at: 7.25, text: "Second" }] });
  });

  it("passes plain lyrics through and ignores empty ones", () => {
    expect(lyricsForContext({ kind: "plain", text: " la la \n" })).toEqual({ kind: "plain", text: "la la" });
    expect(lyricsForContext({ kind: "plain", text: "  " })).toBeNull();
    expect(lyricsForContext(null)).toBeNull();
  });

  it("extracts plain prose from every prose display kind", () => {
    expect(proseText("rich_text", { summary: "short", full: "<p>Long &amp; full</p>" })).toBe("Long & full");
    expect(proseText("html", { content: "a<br>b" })).toBe("a\nb");
    expect(proseText("annotated_text", { overview: "Over", sections: [{ heading: "Story", text: "told" }] }))
      .toBe("Over\n\nStory: told");
    expect(proseText("annotations", { annotations: [{ fragment: "line", explanation: "means x" }] }))
      .toBe('"line" — means x');
    expect(proseText("entity_list", { items: [] })).toBeNull();
    expect(proseText("rich_text", { summary: "<a href='x'></a>" })).toBeNull();
  });

  it("caps long prose", () => {
    const text = proseText("html", { content: "x".repeat(PROSE_CHAR_CAP + 50) })!;
    expect(text.length).toBeLessThanOrEqual(PROSE_CHAR_CAP + 2);
    expect(text.endsWith("…")).toBe(true);
  });

  it("keeps https gallery images with their attribution, drops the rest", () => {
    const out = galleryImages({
      images: [
        { url: "https://upload.wikimedia.org/a.jpg", caption: " On stage ", source: "Jane · CC BY-SA 4.0", author: "Jane", license: "CC BY-SA 4.0", pageUrl: "https://commons.wikimedia.org/wiki/File:A.jpg", width: 800, height: 600, extra: "x" },
        { url: "http://example.com/b.jpg" },
        { url: "data:image/png;base64,AAAA" },
        { caption: "no url" },
        null,
      ],
    });
    expect(out).toEqual([{
      url: "https://upload.wikimedia.org/a.jpg", caption: "On stage", source: "Jane · CC BY-SA 4.0", author: "Jane",
      license: "CC BY-SA 4.0", pageUrl: "https://commons.wikimedia.org/wiki/File:A.jpg", width: 800, height: 600,
    }]);
    expect(galleryImages(null)).toEqual([]);
    expect(galleryImages({ images: "nope" })).toEqual([]);
  });

  it("caps a gallery", () => {
    const images = Array.from({ length: CONTEXT_IMAGE_CAP + 5 }, (_, i) => ({ url: `https://x.org/${i}.jpg` }));
    expect(galleryImages({ images })).toHaveLength(CONTEXT_IMAGE_CAP);
  });
});

describe("cuePastEndError", () => {
  it("names the first cue past the song's end — the milliseconds-for-seconds mistake", () => {
    const sheet = { cues: [{ at: 12, kind: "text" }, { at: 65000, kind: "text" }] };
    expect(cuePastEndError(sheet, 268.9)).toBe(
      "cues[1].at is 65000s but the song is 269s long — times are seconds into the track, not milliseconds",
    );
  });

  it("passes a sheet that fits, an unknown duration, and malformed input (the backend names those)", () => {
    expect(cuePastEndError({ cues: [{ at: 12 }, { at: 268 }] }, 268.9)).toBeNull();
    expect(cuePastEndError({ cues: [{ at: 65000 }] }, null)).toBeNull();
    expect(cuePastEndError({ cues: [{ at: "1:05" }] }, 268.9)).toBeNull();
    expect(cuePastEndError("nonsense", 268.9)).toBeNull();
  });

  it("reads a bare cue array, which the backend also accepts", () => {
    expect(cuePastEndError([{ at: 300 }], 268.9)).toMatch(/^cues\[0\]\.at is 300s/);
  });
});

describe("cue telemetry labels", () => {
  it("names only a known field, never the message", () => {
    expect(cueErrorField("cues[3].color must be one of light, dark")).toBe("color");
    expect(cueErrorField("cues[0].keyframes[2].t must be between 0 and 5")).toBe("keyframes");
    expect(cueErrorField("cues[1].at is 65000s but the song is 269s long")).toBe("at");
    expect(cueErrorField("cues[2] is a text cue and needs text")).toBe("cue");
    expect(cueErrorField("cues[2].myPrivateNote must be")).toBe("other");
    expect(cueErrorField("sheet.mode must be one of cards, clip")).toBe("sheet");
    expect(cueErrorField("database is locked")).toBe("other");
  });

  it("buckets cue counts", () => {
    expect([1, 9, 10, 29, 30, 200].map(cueCountBucket)).toEqual(["1-9", "1-9", "10-29", "10-29", "30-99", "100+"]);
  });
});

describe("sheet metadata", () => {
  const CUES = [{ at: 1, text: "hi" }];

  it("splits track and author off the cues, which go on unchanged", () => {
    const track = { title: " Jóga ", artistName: "Björk", albumName: "Homogenic", durationSecs: 305 };
    expect(splitSheetMeta({ mode: "clip", track, author: "Claude", cues: CUES })).toEqual({
      sheet: { mode: "clip", cues: CUES },
      track: { title: "Jóga", artistName: "Björk", albumName: "Homogenic", durationSecs: 305 },
      author: "Claude",
    });
    expect(splitSheetMeta(CUES)).toEqual({ sheet: CUES, track: null, author: null });
    expect(splitSheetMeta({ cues: CUES })).toEqual({ sheet: { cues: CUES }, track: null, author: null });
  });

  it("refuses a malformed block, naming the field", () => {
    expect(() => splitSheetMeta({ track: "Jóga", cues: CUES })).toThrow("sheet.track must be an object");
    expect(() => splitSheetMeta({ track: { title: 5 }, cues: CUES })).toThrow("sheet.track.title must be a string");
    expect(() => splitSheetMeta({ track: { title: "x", durationSecs: -305 }, cues: CUES })).toThrow("durationSecs");
    expect(() => splitSheetMeta({ track: { artistName: "Björk" }, cues: CUES })).toThrow("needs sheet.track.title");
    expect(() => splitSheetMeta({ author: 3, cues: CUES })).toThrow("sheet.author must be a string");
  });

  it("notes a different-length cut, and only a clearly different one", () => {
    expect(cueTimingNote(250, 252)).toBeNull(); // the same recording, encoders disagree
    expect(cueTimingNote(600, 615)).toBeNull(); // within 3% of a long track
    expect(cueTimingNote(250, 390)).toBe("timed to a 4:10 version");
    expect(cueTimingNote(65, 300)).toBe("timed to a 1:05 version");
    expect(cueTimingNote(null, 300)).toBeNull();
    expect(cueTimingNote(250, null)).toBeNull();
  });

  it("lists what the sheet records, leaving out what it doesn't know", () => {
    const row = {
      title: "Jóga", artistName: "Björk", albumName: "Homogenic", durationSecs: 305, author: "Claude",
      version: 3, createdAt: 100, updatedAt: 200, sheet: { cues: [{ at: 1, kind: "text" as const, text: "x" }] },
    };
    const date = (s: number) => `t${s}`;
    expect(cueSheetDetails(row, 306, date)).toEqual([
      { label: "Song", value: "Björk — Jóga" },
      { label: "Album", value: "Homogenic" },
      { label: "Timed to", value: "5:05" },
      { label: "Type", value: "Cue cards · 1 cue" },
      { label: "Author", value: "Claude" },
      { label: "Version", value: "3" },
      { label: "Created", value: "t100" },
      { label: "Updated", value: "t200" },
    ]);
    // A different cut playing gets a warning row; an old sheet with no
    // metadata shows only what it has.
    expect(cueSheetDetails(row, 390, date)).toContainEqual({
      label: "This copy", value: "6:30 — the cues may not line up", warn: true,
    });
    const bare = { ...row, artistName: null, albumName: null, durationSecs: null, author: null, version: 1, updatedAt: 100,
      sheet: { mode: "clip" as const, cues: [row.sheet.cues[0], row.sheet.cues[0]] } };
    expect(cueSheetDetails(bare, 390, date).map((d) => `${d.label}: ${d.value}`)).toEqual([
      "Song: Jóga", "Type: Clip · 2 elements", "Author: Not recorded", "Version: 1", "Created: t100",
    ]);
  });

  it("builds the credit line from author and note", () => {
    expect(cueCredit("Claude", null)).toEqual({ text: "Claude", title: "Who wrote this cue sheet" });
    expect(cueCredit("Claude", "timed to a 4:10 version")?.text).toBe("Claude · timed to a 4:10 version");
    expect(cueCredit(null, "timed to a 4:10 version")?.title).toMatch(/different-length version/);
    expect(cueCredit(null, null)).toBeNull();
  });
});
