import { describe, it, expect } from "vitest";
import {
  CHAIN_EXHAUSTED_MESSAGE,
  describeSourceNote,
  describeTrackFailure,
  mergeTrackFailure,
  sourceNoteAddress,
  sourceNoteChipTitle,
  sourceNoteReportLines,
  trackFailureReportLines,
  type EntrySourceNote,
  type TrackFailure,
} from "../playback/trackFailures";

describe("describeSourceNote", () => {
  const note: EntrySourceNote = {
    name: "Soulseek",
    reason: "fallback",
    sourceUrl: "file:///Users/me/slskd/Black Hole Sun.flac",
    attempts: [
      { name: "Local file", outcome: "unplayable" },
      { name: "Library", outcome: "miss" },
      { name: "Soulseek", outcome: "found" },
    ],
    at: 1_000,
  };

  it("names the source, shows the file as a path, and explains a fallback", () => {
    const d = describeSourceNote(note, 1_000);
    expect(d.headline).toBe("Played from Soulseek");
    expect(d.explanation).toMatch(/own source couldn't be used/);
    expect(d.rows).toContainEqual({ label: "Address", value: "/Users/me/slskd/Black Hole Sun.flac", code: true });
    expect(d.attempts.map((a) => [a.name, a.outcome, a.found])).toEqual([
      ["Local file", "Found, but wouldn't play", false],
      ["Library", "Not in library", false],
      ["Soulseek", "Found a source", true],
    ]);
  });

  it("explains a metadata-only entry without blaming anything", () => {
    expect(describeSourceNote({ ...note, reason: "no-source" }).explanation).toMatch(/no source of its own/);
  });

  it("explains a Prefer video win as the user's choice", () => {
    const d = describeSourceNote({ ...note, reason: "prefer-video" });
    expect(d.explanation).toMatch(/Prefer video is on/);
    expect(d.explanation).not.toMatch(/no source of its own|couldn't be used/);
    expect(sourceNoteChipTitle({ ...note, reason: "prefer-video" })).toMatch(/^Prefer video/);
  });

  it("keeps the app's file:// paths as written, Windows drive paths included", () => {
    expect(sourceNoteAddress({ ...note, sourceUrl: "file://D:/slskd/Black Hole Sun.flac" })).toBe("D:/slskd/Black Hole Sun.flac");
    expect(sourceNoteAddress({ ...note, sourceUrl: "https://youtu.be/x" })).toBe("https://youtu.be/x");
    expect(sourceNoteAddress({ ...note, sourceUrl: null })).toBeNull();
  });

  it("report lines name the reason, the address and the walk", () => {
    const lines = sourceNoteReportLines(note, { title: "Black Hole Sun", artist_name: "Soundgarden" });
    expect(lines).toContain("Played from: Soulseek (fallback)");
    expect(lines).toContain("Address: /Users/me/slskd/Black Hole Sun.flac");
    expect(lines).toContain("Resolver Local file: Found, but wouldn't play");
  });
});

const resolveFailure: TrackFailure = {
  stage: "resolve",
  summary: "yt-dlp found no match",
  at: 1_000,
  attempts: [
    { name: "Library", outcome: "miss" },
    { name: "yt-dlp", outcome: "miss" },
  ],
};

const playbackFailure: TrackFailure = {
  stage: "playback",
  summary: "The track couldn’t be opened",
  at: 2_000,
  attempts: [
    { name: "Library", outcome: "miss" },
    { name: "yt-dlp", outcome: "found" },
  ],
  source: { name: "yt-dlp", url: "https://www.youtube.com/watch?v=abc" },
  engineError: "loading failed (-13)",
  tries: 3,
};

describe("mergeTrackFailure", () => {
  it("keeps the chain's record when handlePlay re-reports the same exhausted chain", () => {
    const rereport: TrackFailure = { stage: "resolve", summary: CHAIN_EXHAUSTED_MESSAGE, at: 3_000, attempts: [] };
    expect(mergeTrackFailure(resolveFailure, rereport)).toBe(resolveFailure);
  });

  it("a refined re-report (offline) keeps the chain's attempts and its stage", () => {
    const offline: TrackFailure = { stage: "resolve", summary: "You're offline", at: 3_000, attempts: [] };
    const merged = mergeTrackFailure(resolveFailure, offline);
    expect(merged.stage).toBe("resolve");
    expect(merged.summary).toBe("You're offline");
    expect(merged.attempts).toBe(resolveFailure.attempts);
  });

  it("an engine-unavailable failure never claims a source was found", () => {
    const engine: TrackFailure = { stage: "engine", summary: "The playback engine couldn't start", at: 3_000, attempts: [] };
    expect(mergeTrackFailure(playbackFailure, engine)).toBe(engine);
    const d = describeTrackFailure(engine, 3_000);
    expect(d.explanation).not.toMatch(/source was found/);
    expect(d.rows.map((r) => r.label)).toEqual(["When"]);
  });

  it("an engine failure replaces an earlier resolve failure", () => {
    expect(mergeTrackFailure(resolveFailure, playbackFailure)).toBe(playbackFailure);
  });

  it("a newer failure of either kind replaces a playback failure", () => {
    expect(mergeTrackFailure(playbackFailure, resolveFailure)).toBe(resolveFailure);
    const refined = { ...playbackFailure, summary: "Couldn't reach the server" };
    expect(mergeTrackFailure(playbackFailure, refined)).toBe(refined);
  });

  it("records the first failure", () => {
    expect(mergeTrackFailure(undefined, playbackFailure)).toBe(playbackFailure);
  });
});

describe("describeTrackFailure", () => {
  it("explains a playback failure with its source, the player's error and the retries", () => {
    const d = describeTrackFailure(playbackFailure, 2_000);
    expect(d.headline).toBe("The track couldn’t be opened");
    expect(d.explanation).toMatch(/player couldn't open it/);
    expect(d.rows).toEqual([
      { label: "Source", value: "yt-dlp" },
      { label: "Address", value: "https://www.youtube.com/watch?v=abc", code: true },
      { label: "Player error", value: "loading failed (-13)", code: true },
      { label: "Attempts", value: "Tried 3 times, with a fresh link each time" },
      { label: "When", value: "Just now" },
    ]);
    expect(d.attempts).toEqual([
      { name: "Library", outcome: "Not in library", detail: null, found: false },
      { name: "yt-dlp", outcome: "Found a source", detail: null, found: true },
    ]);
  });

  it("explains a resolve failure as nothing found, with every source asked", () => {
    const d = describeTrackFailure(resolveFailure, 1_000 + 5 * 60_000);
    expect(d.explanation).toBe("None of your sources could find this track.");
    expect(d.rows).toEqual([{ label: "When", value: "5 min ago" }]);
    expect(d.attempts.map((a) => a.outcome)).toEqual(["Not in library", "No match"]);
  });

  it("omits what a failure doesn't know", () => {
    const bare: TrackFailure = { stage: "playback", summary: "x", at: 0, attempts: [], tries: 1 };
    expect(describeTrackFailure(bare, 0).rows.map((r) => r.label)).toEqual(["When"]);
  });

  it("carries a resolver's error text and names timeouts and video misses", () => {
    const f: TrackFailure = {
      ...resolveFailure,
      attempts: [
        { name: "yt-dlp", outcome: "no-video" },
        { name: "Soulseek", outcome: "timeout", detail: "Timed out after 60s" },
        { name: "Spotify", outcome: "error", detail: "boom" },
      ],
    };
    expect(describeTrackFailure(f).attempts).toEqual([
      { name: "yt-dlp", outcome: "No video stream", detail: null, found: false },
      { name: "Soulseek", outcome: "Timed out", detail: "Timed out after 60s", found: false },
      { name: "Spotify", outcome: "Failed", detail: "boom", found: false },
    ]);
  });
});

describe("trackFailureReportLines", () => {
  it("lists the track, the failure and every attempt for the problem report", () => {
    expect(trackFailureReportLines(playbackFailure, { title: "The Killing Moon", artist_name: "Echo & the Bunnymen" })).toEqual([
      "Track: The Killing Moon — Echo & the Bunnymen",
      "Stage: playback",
      "Error: The track couldn’t be opened",
      "Source: yt-dlp",
      "Address: https://www.youtube.com/watch?v=abc",
      "Player error: loading failed (-13)",
      "Attempts: Tried 3 times, with a fresh link each time",
      "Resolver Library: Not in library",
      "Resolver yt-dlp: Found a source",
    ]);
  });

  it("names the album when known — two copies of one song can share a collection", () => {
    const lines = trackFailureReportLines(playbackFailure, {
      title: "El Rodeo", artist_name: "Kyuss", album_title: "Muchas Gracias (best of)",
    });
    expect(lines.slice(0, 2)).toEqual(["Track: El Rodeo — Kyuss", "Album: Muchas Gracias (best of)"]);
  });
});
