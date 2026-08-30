import { describe, it, expect } from "vitest";
import {
  mediaErrorMessage,
  describePlaybackFailure,
  describeLocalPlaybackFailure,
  OFFLINE_PLAYBACK_ERROR,
  UNREACHABLE_PLAYBACK_ERROR,
  FILE_NOT_FOUND_PLAYBACK_ERROR,
  REMOTE_FORMAT_PLAYBACK_ERROR,
  isFormatPlaybackError,
  nextPlayIntent,
  shouldAutoSkipFailure,
  MAX_CONSECUTIVE_AUTO_SKIPS,
} from "../playback/playbackErrors";

describe("mediaErrorMessage", () => {
  it("maps the four MediaError codes", () => {
    expect(mediaErrorMessage(1)).toBe("Playback aborted");
    expect(mediaErrorMessage(2)).toBe("Network error during playback");
    expect(mediaErrorMessage(3)).toContain("decoded");
    expect(mediaErrorMessage(4)).toBe("File format not supported");
  });

  it("falls back to a generic message for unknown codes", () => {
    expect(mediaErrorMessage(9)).toBe("Playback error (code 9)");
  });
});

describe("describePlaybackFailure", () => {
  const base = "File format not supported";

  it("keeps the base message for local tracks regardless of network state", () => {
    expect(describePlaybackFailure(base, false, "offline")).toBe(base);
    expect(describePlaybackFailure(base, false, "unreachable")).toBe(base);
    expect(describePlaybackFailure(base, false, "ok")).toBe(base);
  });

  it("reworks a reachable remote FORMAT error into a stream-specific message (still a format error → mpv offer)", () => {
    const msg = describePlaybackFailure(base, true, "ok");
    expect(msg).toBe(REMOTE_FORMAT_PLAYBACK_ERROR);
    expect(isFormatPlaybackError(msg)).toBe(true);
  });

  it("reworks WebKit's unsupported-source play rejection into the stream-specific message", () => {
    const base = "Failed to load because no supported source was found.";
    expect(describePlaybackFailure(base, true, "ok"))
      .toBe(REMOTE_FORMAT_PLAYBACK_ERROR);
    expect(isFormatPlaybackError(base)).toBe(true);
  });

  it("keeps a NON-format base for reachable remote tracks (e.g. a resolution failure)", () => {
    const notFound = "Couldn't find a playable source for this track";
    expect(describePlaybackFailure(notFound, true, "ok")).toBe(notFound);
    expect(isFormatPlaybackError(notFound)).toBe(false);
  });

  it("reports offline instead of 'not supported' for remote tracks with no connection", () => {
    expect(describePlaybackFailure(base, true, "offline")).toBe(OFFLINE_PLAYBACK_ERROR);
  });

  it("reports an unreachable source for remote tracks when the host does not answer", () => {
    expect(describePlaybackFailure(base, true, "unreachable")).toBe(UNREACHABLE_PLAYBACK_ERROR);
  });

  it("also overrides play() rejection messages, not just media error text", () => {
    expect(describePlaybackFailure("The operation is not supported.", true, "offline"))
      .toBe(OFFLINE_PLAYBACK_ERROR);
  });
});

describe("describeLocalPlaybackFailure", () => {
  const base = "File format not supported";

  it("keeps the base message while the file exists on disk", () => {
    expect(describeLocalPlaybackFailure(base, true)).toBe(base);
  });

  it("reports a missing file instead of 'not supported' when the file is gone", () => {
    expect(describeLocalPlaybackFailure(base, false)).toBe(FILE_NOT_FOUND_PLAYBACK_ERROR);
  });

  it("also overrides play() rejection messages, not just media error text", () => {
    expect(describeLocalPlaybackFailure("The operation is not supported.", false))
      .toBe(FILE_NOT_FOUND_PLAYBACK_ERROR);
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
