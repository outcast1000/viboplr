import { describe, it, expect } from "vitest";
import type { Track } from "../types";
import {
  QUIZ_MODES,
  buildQuestion,
  eligibleQuizTracks,
  fiftyFiftyRemovals,
  formatClock,
  getQuizMode,
  hasEnoughQuizTracks,
  normalizeBestScores,
  normalizeTitle,
  pickSnippetWindow,
} from "../utils/quiz";

let nextId = 1;
function makeTrack(overrides: Partial<Track> = {}): Track {
  const id = overrides.id !== undefined ? overrides.id : nextId++;
  return {
    id,
    key: `lib:${id}`,
    path: "file:///music/song.mp3",
    title: `Song ${id}`,
    artist_id: 1,
    artist_name: "Artist",
    album_id: 1,
    album_title: "Album",
    year: 2020,
    track_number: 1,
    duration_secs: 240,
    format: "mp3",
    file_size: 1000,
    collection_id: 1,
    collection_name: "Local",
    liked: 0,
    added_at: null,
    modified_at: null,
    ...overrides,
  };
}

/** Deterministic rand from a fixed sequence (cycles). */
function seqRand(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

const NO_SAME_ARTIST = { snippetSecs: 10, sameArtistDistractors: false };

describe("quiz modes", () => {
  it("defines easy, medium and hard", () => {
    expect(QUIZ_MODES.map((m) => m.id)).toEqual(["easy", "medium", "hard"]);
  });

  it("harder modes start with less time and shorter snippets", () => {
    const [easy, medium, hard] = QUIZ_MODES;
    expect(easy.startSecs).toBeGreaterThan(medium.startSecs);
    expect(medium.startSecs).toBeGreaterThan(hard.startSecs);
    expect(easy.snippetSecs).toBeGreaterThan(medium.snippetSecs);
    expect(medium.snippetSecs).toBeGreaterThan(hard.snippetSecs);
  });

  it("harder modes reward less and punish more", () => {
    const [easy, medium, hard] = QUIZ_MODES;
    expect(easy.bonusSecs).toBeGreaterThan(medium.bonusSecs);
    expect(medium.bonusSecs).toBeGreaterThan(hard.bonusSecs);
    expect(hard.penaltySecs).toBeGreaterThan(medium.penaltySecs);
    expect(medium.penaltySecs).toBeGreaterThan(easy.penaltySecs);
  });

  it("only hard uses same-artist distractors", () => {
    expect(QUIZ_MODES.filter((m) => m.sameArtistDistractors).map((m) => m.id)).toEqual(["hard"]);
  });

  it("getQuizMode resolves by id and falls back to the first mode", () => {
    expect(getQuizMode("hard").id).toBe("hard");
    expect(getQuizMode("nope" as never).id).toBe("easy");
  });
});

describe("formatClock", () => {
  it("formats m:ss, rounding partial seconds up", () => {
    expect(formatClock(120)).toBe("2:00");
    expect(formatClock(90)).toBe("1:30");
    expect(formatClock(59.2)).toBe("1:00");
    expect(formatClock(9)).toBe("0:09");
  });

  it("never goes below 0:00", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(-5)).toBe("0:00");
  });
});

describe("normalizeBestScores", () => {
  it("keeps positive finite integers per known mode", () => {
    expect(normalizeBestScores({ easy: 7, medium: 3.9, hard: 12 }))
      .toEqual({ easy: 7, medium: 3, hard: 12 });
  });

  it("drops junk values, unknown modes, and non-objects", () => {
    expect(normalizeBestScores({ easy: -1, medium: NaN, hard: "9", legend: 4 })).toEqual({});
    expect(normalizeBestScores(null)).toEqual({});
    expect(normalizeBestScores("high")).toEqual({});
    expect(normalizeBestScores(undefined)).toEqual({});
  });

  it("treats zero as no best yet", () => {
    expect(normalizeBestScores({ easy: 0 })).toEqual({});
  });
});

describe("snippet windows", () => {
  it("keeps the window inside the middle 80% of the track", () => {
    const { start, len } = pickSnippetWindow(200, 10, () => 0.5);
    expect(len).toBe(10);
    expect(start).toBeGreaterThanOrEqual(20); // 10%
    expect(start + len).toBeLessThanOrEqual(180); // 90%
  });

  it("spans the full random range", () => {
    expect(pickSnippetWindow(200, 10, () => 0).start).toBeCloseTo(20);
    expect(pickSnippetWindow(200, 10, () => 1).start).toBeCloseTo(170);
  });

  it("falls back to the start for very short tracks", () => {
    const { start, len } = pickSnippetWindow(12, 10, () => 0.5);
    expect(start).toBe(0);
    expect(len).toBe(10);
  });

  it("clamps snippet length to the track duration", () => {
    const { len } = pickSnippetWindow(6, 10, () => 0.5);
    expect(len).toBe(6);
  });
});

describe("normalizeTitle", () => {
  it("is case- and diacritic-insensitive", () => {
    expect(normalizeTitle("Jóga")).toBe(normalizeTitle("joga"));
    expect(normalizeTitle("  Björk ")).toBe("bjork");
  });
});

describe("eligibleQuizTracks", () => {
  it("keeps local and subsonic tracks in browser-playable formats", () => {
    const ok1 = makeTrack();
    const ok2 = makeTrack({ path: "subsonic://1/abc", format: "flac" });
    const noId = makeTrack({ id: null });
    const noArtist = makeTrack({ artist_name: null });
    const short = makeTrack({ duration_secs: 20 });
    const pluginScheme = makeTrack({ path: "custom://xyz" });
    const badFormat = makeTrack({ format: "ape" });
    const noFormat = makeTrack({ format: null });
    const result = eligibleQuizTracks([ok1, ok2, noId, noArtist, short, pluginScheme, badFormat, noFormat]);
    expect(result).toEqual([ok1, ok2]);
  });

  it("hasEnoughQuizTracks requires 4 distinct titles", () => {
    const dupes = [
      makeTrack({ title: "Same" }),
      makeTrack({ title: "same" }),
      makeTrack({ title: "SAME" }),
      makeTrack({ title: "Other" }),
    ];
    expect(hasEnoughQuizTracks(dupes)).toBe(false);
    expect(hasEnoughQuizTracks([...dupes, makeTrack({ title: "Third" }), makeTrack({ title: "Fourth" })])).toBe(true);
  });
});

describe("buildQuestion", () => {
  const rand = seqRand([0.13, 0.71, 0.42, 0.98, 0.05, 0.66, 0.29, 0.84]);

  it("returns 4 options with distinct titles including the correct track", () => {
    const tracks = Array.from({ length: 10 }, () => makeTrack());
    const q = buildQuestion(tracks, NO_SAME_ARTIST, new Set(), rand);
    expect(q).not.toBeNull();
    expect(q!.options).toHaveLength(4);
    expect(q!.options[q!.correctIndex]).toBe(q!.correct);
    const titles = new Set(q!.options.map((t) => normalizeTitle(t.title)));
    expect(titles.size).toBe(4);
  });

  it("avoids reusing tracks already asked", () => {
    const tracks = Array.from({ length: 6 }, () => makeTrack());
    const used = new Set(tracks.slice(0, 5).map((t) => t.id!));
    const q = buildQuestion(tracks, NO_SAME_ARTIST, used, rand);
    expect(q).not.toBeNull();
    expect(q!.correct.id).toBe(tracks[5].id);
  });

  it("recycles used tracks when the pool is exhausted rather than failing", () => {
    const tracks = Array.from({ length: 4 }, () => makeTrack());
    const used = new Set(tracks.map((t) => t.id!));
    const q = buildQuestion(tracks, NO_SAME_ARTIST, used, rand);
    expect(q).not.toBeNull();
  });

  it("returns null when fewer than 4 distinct titles exist", () => {
    const tracks = [
      makeTrack({ title: "A" }),
      makeTrack({ title: "a" }),
      makeTrack({ title: "B" }),
      makeTrack({ title: "C" }),
    ];
    expect(buildQuestion(tracks, NO_SAME_ARTIST, new Set(), rand)).toBeNull();
  });

  it("prefers same-artist distractors when the mode asks for them", () => {
    const sameArtist = Array.from({ length: 5 }, (_, i) =>
      makeTrack({ artist_name: "Target", title: `Target Song ${i}` }));
    const others = Array.from({ length: 10 }, (_, i) =>
      makeTrack({ artist_name: `Other ${i}`, title: `Other Song ${i}` }));
    const used = new Set(others.map((t) => t.id!)); // force a Target correct answer
    const q = buildQuestion(
      [...sameArtist, ...others],
      { snippetSecs: 4, sameArtistDistractors: true },
      used,
      rand,
    );
    expect(q).not.toBeNull();
    expect(q!.correct.artist_name).toBe("Target");
    for (const opt of q!.options) expect(opt.artist_name).toBe("Target");
  });

  it("snippet window respects the mode's snippet length", () => {
    const tracks = Array.from({ length: 8 }, () => makeTrack({ duration_secs: 300 }));
    const q = buildQuestion(tracks, { snippetSecs: 4, sameArtistDistractors: false }, new Set(), rand);
    expect(q!.snippetLen).toBe(4);
    expect(q!.snippetStart).toBeGreaterThanOrEqual(30);
    expect(q!.snippetStart + q!.snippetLen).toBeLessThanOrEqual(270);
  });
});

describe("fiftyFiftyRemovals", () => {
  it("removes exactly two wrong answers, never the correct one", () => {
    for (const r of [0, 0.3, 0.6, 0.99]) {
      const removed = fiftyFiftyRemovals(4, 2, () => r);
      expect(removed).toHaveLength(2);
      expect(removed).not.toContain(2);
      expect(new Set(removed).size).toBe(2);
    }
  });

  it("returns sorted indices", () => {
    const removed = fiftyFiftyRemovals(4, 0, seqRand([0.9, 0.1]));
    expect(removed).toEqual([...removed].sort((a, b) => a - b));
  });
});
