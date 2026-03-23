import { describe, it, expect } from "vitest";
import type { Track } from "../types";
import { computeSelection } from "../components/TrackList";

function makeTrack(id: number): Track {
  return {
    id, path: `/test${id}.mp3`, title: `Track ${id}`, artist_id: null,
    artist_name: null, album_id: null, album_title: null, year: null,
    track_number: null, duration_secs: null, format: null, file_size: null,
    collection_id: null, collection_name: null, subsonic_id: null,
    liked: false, deleted: false, youtube_url: null,
    added_at: null, modified_at: null,
  };
}

const tracks = [makeTrack(10), makeTrack(20), makeTrack(30), makeTrack(40), makeTrack(50)];

describe("computeSelection", () => {
  it("plain click selects only the clicked track", () => {
    const result = computeSelection(new Set([10, 20]), 2, tracks, null, false, false);
    expect(result).toEqual(new Set([30]));
  });

  it("plain click on already-selected sole track is idempotent", () => {
    const result = computeSelection(new Set([30]), 2, tracks, null, false, false);
    expect(result).toEqual(new Set([30]));
  });

  it("meta+click toggles a track into the selection", () => {
    const result = computeSelection(new Set([10]), 2, tracks, null, true, false);
    expect(result).toEqual(new Set([10, 30]));
  });

  it("meta+click toggles a track out of the selection", () => {
    const result = computeSelection(new Set([10, 30]), 2, tracks, null, true, false);
    expect(result).toEqual(new Set([10]));
  });

  it("shift+click selects a range from lastIndex", () => {
    const result = computeSelection(new Set(), 3, tracks, 1, false, true);
    expect(result).toEqual(new Set([20, 30, 40]));
  });

  it("shift+click selects range in reverse direction", () => {
    const result = computeSelection(new Set(), 1, tracks, 3, false, true);
    expect(result).toEqual(new Set([20, 30, 40]));
  });

  it("shift+click with no lastIndex selects from 0 to clicked", () => {
    const result = computeSelection(new Set(), 2, tracks, null, false, true);
    expect(result).toEqual(new Set([10, 20, 30]));
  });

  it("shift+click on same index as lastIndex selects single item", () => {
    const result = computeSelection(new Set(), 2, tracks, 2, false, true);
    expect(result).toEqual(new Set([30]));
  });

  it("meta+shift+click unions range with existing selection", () => {
    const result = computeSelection(new Set([10]), 3, tracks, 2, true, true);
    expect(result).toEqual(new Set([10, 30, 40]));
  });

  it("clicking first index works", () => {
    const result = computeSelection(new Set(), 0, tracks, null, false, false);
    expect(result).toEqual(new Set([10]));
  });

  it("clicking last index works", () => {
    const result = computeSelection(new Set(), 4, tracks, null, false, false);
    expect(result).toEqual(new Set([50]));
  });
});
