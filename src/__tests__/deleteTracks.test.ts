import { describe, it, expect } from "vitest";
import { partitionTrackIds, buildDeleteConfirmPayload } from "../utils/deleteTracks";
import type { Track } from "../types";

function t(id: number, path: string | null, title = `Track ${id}`): Track {
  return {
    id,
    key: `lib:${id}`,
    path,
    title,
    artist_id: null,
    artist_name: null,
    album_id: null,
    album_title: null,
    year: null,
    track_number: null,
    duration_secs: null,
    format: null,
    file_size: null,
    collection_id: null,
    collection_name: null,
    liked: 0,
    added_at: null,
    modified_at: null,
  };
}

describe("partitionTrackIds", () => {
  it("surfaces ids not in the loaded page as missingIds instead of dropping them", () => {
    // The bug: handleDeleteTracks only resolved against the paginated library.tracks
    // (first 100), so a duplicate further down was silently filtered out and the
    // delete no-opped. These ids must be reported as missing so the caller fetches them.
    const loaded = [t(1, "file:///a.mp3")];
    const { loaded: inPage, missingIds } = partitionTrackIds([1, 2, 3], loaded);
    expect(inPage.map(x => x.id)).toEqual([1]);
    expect(missingIds).toEqual([2, 3]);
  });

  it("fetches nothing when every id is already loaded", () => {
    const loaded = [t(1, "file:///a.mp3"), t(2, "file:///b.mp3")];
    const { loaded: inPage, missingIds } = partitionTrackIds([1, 2], loaded);
    expect(inPage.map(x => x.id)).toEqual([1, 2]);
    expect(missingIds).toEqual([]);
  });

  it("dedupes repeated ids in the request", () => {
    const { missingIds } = partitionTrackIds([5, 5, 6], []);
    expect(missingIds).toEqual([5, 6]);
  });
});

describe("buildDeleteConfirmPayload", () => {
  it("builds a payload for a track resolved outside the loaded page (the bug)", () => {
    // Simulates a duplicate fetched via get_tracks_by_ids that was never in library.tracks.
    const payload = buildDeleteConfirmPayload([t(42, "file:///offpage.mp3", "Off Page")]);
    expect(payload).not.toBeNull();
    expect(payload!.trackIds).toEqual([42]);
    expect(payload!.title).toBe("Off Page");
    expect(payload!.network).toBe(false);
  });

  it("filters out remote (non-deletable) copies", () => {
    const payload = buildDeleteConfirmPayload([
      t(1, "file:///local.mp3"),
      t(2, "subsonic://server/99"),
    ]);
    expect(payload!.trackIds).toEqual([1]);
  });

  it("returns null when nothing is locally deletable", () => {
    expect(buildDeleteConfirmPayload([t(1, "subsonic://server/1")])).toBeNull();
    expect(buildDeleteConfirmPayload([])).toBeNull();
  });

  it("titles a multi-track delete by count", () => {
    const payload = buildDeleteConfirmPayload([t(1, "file:///a.mp3"), t(2, "file:///b.mp3")]);
    expect(payload!.title).toBe("2 tracks");
  });

  it("flags a network-share path as a permanent delete", () => {
    const payload = buildDeleteConfirmPayload([t(1, "file:////nas/music/a.mp3")]);
    expect(payload!.network).toBe(true);
  });
});
