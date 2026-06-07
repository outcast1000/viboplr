import { describe, it, expect } from "vitest";
import { buildExternalQueueTrack } from "../utils/externalTrack";

describe("buildExternalQueueTrack", () => {
  it("builds a metadata-only queue track with no path", () => {
    const t = buildExternalQueueTrack("Gardenia", "Kyuss");
    expect(t.path).toBeNull();
    expect(t.title).toBe("Gardenia");
    expect(t.artist_name).toBe("Kyuss");
    expect(t.album_title).toBeNull();
    expect(t.duration_secs).toBeNull();
    expect(t.format).toBeNull();
    expect(t.liked).toBe(0);
    expect(typeof t.key).toBe("string");
    expect(t.key.length).toBeGreaterThan(0);
  });

  it("treats missing/empty artist as null", () => {
    expect(buildExternalQueueTrack("Solo", undefined).artist_name).toBeNull();
    expect(buildExternalQueueTrack("Solo", null).artist_name).toBeNull();
    expect(buildExternalQueueTrack("Solo", "").artist_name).toBeNull();
  });

  it("mints a unique key per call", () => {
    expect(buildExternalQueueTrack("A", "B").key).not.toBe(buildExternalQueueTrack("A", "B").key);
  });
});
