import { describe, it, expect } from "vitest";
import {
  CHAIN_EXHAUSTED_MESSAGE,
  describeTrackFailure,
  mergeTrackFailure,
  trackFailureReportLines,
  type TrackFailure,
} from "../playback/trackFailures";

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
    const rereport: TrackFailure = { stage: "playback", summary: CHAIN_EXHAUSTED_MESSAGE, at: 3_000, attempts: [] };
    expect(mergeTrackFailure(resolveFailure, rereport)).toBe(resolveFailure);
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
});
