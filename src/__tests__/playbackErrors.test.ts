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
