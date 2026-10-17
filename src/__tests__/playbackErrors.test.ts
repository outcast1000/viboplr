import { describe, it, expect } from "vitest";
import {
  engineErrorMessage,
  describePlaybackFailure,
  describeLocalPlaybackFailure,
  OFFLINE_PLAYBACK_ERROR,
  UNREACHABLE_PLAYBACK_ERROR,
  FILE_NOT_FOUND_PLAYBACK_ERROR,
  FORMAT_PLAYBACK_ERROR,
  LOAD_PLAYBACK_ERROR,
  AUDIO_OUTPUT_PLAYBACK_ERROR,
  isFormatPlaybackError,
  nextPlayIntent,
  shouldAutoSkipFailure,
  MAX_CONSECUTIVE_AUTO_SKIPS,
} from "../playback/playbackErrors";

describe("engineErrorMessage", () => {
  it("names a file mpv can't demux as a format failure", () => {
    expect(engineErrorMessage("unrecognized file format (-17)")).toBe(FORMAT_PLAYBACK_ERROR);
    expect(engineErrorMessage("no audio or video data played")).toBe(FORMAT_PLAYBACK_ERROR);
  });

  it("names a load failure as one — the describe* probes then find the real cause", () => {
    expect(engineErrorMessage("loading failed (-13)")).toBe(LOAD_PLAYBACK_ERROR);
  });

  it("names an audio device that won't open", () => {
    expect(engineErrorMessage("audio output initialization failed (-18)")).toBe(AUDIO_OUTPUT_PLAYBACK_ERROR);
  });

  it("keeps an unknown message rather than inventing a cause", () => {
    expect(engineErrorMessage("something new")).toBe("Playback failed: something new");
    expect(engineErrorMessage("")).toBe("Playback failed");
    expect(engineErrorMessage(null)).toBe("Playback failed");
  });

  it("is a format error only for the format message", () => {
    expect(isFormatPlaybackError(FORMAT_PLAYBACK_ERROR)).toBe(true);
    expect(isFormatPlaybackError(LOAD_PLAYBACK_ERROR)).toBe(false);
    expect(isFormatPlaybackError(null)).toBe(false);
  });
});

describe("describePlaybackFailure", () => {
  const base = LOAD_PLAYBACK_ERROR;

  it("keeps the base message for local tracks regardless of network state", () => {
    expect(describePlaybackFailure(base, false, "offline")).toBe(base);
    expect(describePlaybackFailure(base, false, "unreachable")).toBe(base);
    expect(describePlaybackFailure(base, false, "ok")).toBe(base);
  });

  it("keeps the base for a reachable remote track — then the failure is about the content", () => {
    expect(describePlaybackFailure(base, true, "ok")).toBe(base);
    expect(describePlaybackFailure(FORMAT_PLAYBACK_ERROR, true, "ok")).toBe(FORMAT_PLAYBACK_ERROR);
  });

  it("reports offline instead of a load failure for remote tracks with no connection", () => {
    expect(describePlaybackFailure(base, true, "offline")).toBe(OFFLINE_PLAYBACK_ERROR);
  });

  it("reports an unreachable source for remote tracks when the host does not answer", () => {
    expect(describePlaybackFailure(base, true, "unreachable")).toBe(UNREACHABLE_PLAYBACK_ERROR);
  });
});

describe("describeLocalPlaybackFailure", () => {
  const base = LOAD_PLAYBACK_ERROR;

  it("keeps the base message while the file exists on disk", () => {
    expect(describeLocalPlaybackFailure(base, true)).toBe(base);
  });

  it("reports a missing file instead of a load failure when the file is gone", () => {
    expect(describeLocalPlaybackFailure(base, false)).toBe(FILE_NOT_FOUND_PLAYBACK_ERROR);
  });
});

describe("nextPlayIntent", () => {
  it("a user play always claims the intent", () => {
    expect(nextPlayIntent(null, "lib:1", "user")).toEqual({ key: "lib:1", source: "user" });
    expect(nextPlayIntent({ key: "lib:1", source: "auto" }, "lib:1", "user"))
      .toEqual({ key: "lib:1", source: "user" });
  });

  it("an auto play claims the intent for a different track (queue advance)", () => {
    expect(nextPlayIntent({ key: "lib:1", source: "user" }, "ext:2", "auto"))
      .toEqual({ key: "ext:2", source: "auto" });
  });

  it("a same-key auto replay inherits a user click (the engine-error fallback must not demote it)", () => {
    const prev = { key: "lib:1", source: "user" as const };
    expect(nextPlayIntent(prev, "lib:1", "auto")).toBe(prev);
  });

  it("claims the intent for an auto play with no standing intent", () => {
    expect(nextPlayIntent(null, "ext:3", "auto")).toEqual({ key: "ext:3", source: "auto" });
  });
});

describe("shouldAutoSkipFailure", () => {
  it("never auto-skips a user-initiated play — the modal is the answer there", () => {
    expect(shouldAutoSkipFailure("user", 0)).toBe(false);
  });

  it("auto-skips an auto-advanced play while the streak is under the cap", () => {
    for (let streak = 0; streak < MAX_CONSECUTIVE_AUTO_SKIPS; streak++) {
      expect(shouldAutoSkipFailure("auto", streak)).toBe(true);
    }
  });

  it("trips the breaker at the cap so a fully dead queue falls back to the modal", () => {
    expect(shouldAutoSkipFailure("auto", MAX_CONSECUTIVE_AUTO_SKIPS)).toBe(false);
    expect(shouldAutoSkipFailure("auto", MAX_CONSECUTIVE_AUTO_SKIPS + 1)).toBe(false);
  });
});
