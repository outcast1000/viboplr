// startRadio from a seed the library lacks (an album/artist "Not in library"
// row): the backend builds the station from the seed's artist and leaves the
// seed's slot to the caller, which opens the station with the seed itself,
// metadata-only.
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, cleanup, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { usePlayActions } from "../hooks/usePlayActions";
import type { Track, QueueTrack } from "../types";
import type { PlaylistContext } from "../hooks/useQueue";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => `asset://${p}` }));
vi.mock("../telemetry", () => ({ track: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function libTrack(id: number, title: string): Track {
  return {
    id, path: `file:///${title}.flac`, title, artist_id: 1, artist_name: "Bjork",
    album_id: 3, album_title: "Homogenic", year: null, track_number: null, duration_secs: 200,
    format: "flac", file_size: 1, collection_id: 1, collection_name: "Music", liked: 0,
    added_at: null, modified_at: null,
  };
}

function mount(station: { seedInLibrary: boolean; tracks: Track[] }) {
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === "build_radio_station") return station;
    // Every album has a cover named after it; artists have none.
    if (cmd === "get_entity_image") {
      const a = args as { kind: string; name: string };
      return a.kind === "album" ? `cover:${a.name}` : null;
    }
    return null;
  });
  const playTracks = vi.fn((_tracks: Array<Track | QueueTrack>, _index: number, _context?: PlaylistContext | null) => 1);
  const notify = vi.fn();
  const setPlaylistContext = vi.fn();
  const { result } = renderHook(() => usePlayActions({
    playTracks,
    enqueueTracks: vi.fn(),
    appendToPlaySession: vi.fn(() => true),
    markBackfillPending: vi.fn(),
    settleBackfill: vi.fn(),
    setPlaylistContext,
    albums: [], artists: [], tags: [],
    getAlbumImage: () => null, getArtistImage: () => null, getTagImage: () => null,
    notify,
    radioOptions: { artistShare: 50, taste: "mixed", spreadArtists: false },
  }));
  return { startRadio: result.current.startRadio, playTracks, notify, setPlaylistContext };
}

const played = (playTracks: ReturnType<typeof vi.fn>) => playTracks.mock.calls[0][0] as QueueTrack[];

describe("startRadio", () => {
  it("opens a station for a seed not in the library with the seed itself, metadata-only", async () => {
    const { startRadio, playTracks } = mount({ seedInLibrary: false, tracks: [libTrack(1, "Joga"), libTrack(2, "Hunter")] });
    const count = await startRadio({ title: "Army of Me", artistName: "Bjork", coverPath: null });

    expect(count).toBe(3);
    const queue = played(playTracks);
    expect(queue.map(t => t.title)).toEqual(["Army of Me", "Joga", "Hunter"]);
    expect(queue[0].path).toBeNull();
    expect(queue[0].libraryId ?? null).toBeNull();
    expect(queue[1].libraryId).toBe(1);
    expect(playTracks.mock.calls[0][2]).toMatchObject({ name: "Radio: Army of Me", source: "radio" });
  });

  it("takes the banner cover from the seed's own album, not the station's first library track", async () => {
    const { startRadio, playTracks, setPlaylistContext } = mount({ seedInLibrary: false, tracks: [libTrack(1, "Joga")] });
    await startRadio({ title: "Army of Me", artistName: "Bjork", coverPath: null, albumTitle: "Post" });

    expect(played(playTracks)[0].album_title).toBe("Post");
    await waitFor(() => expect(setPlaylistContext).toHaveBeenCalled());
    const patch = setPlaylistContext.mock.calls[0][0] as (prev: PlaylistContext | null) => PlaylistContext | null;
    expect(patch({ name: "Radio: Army of Me", source: "radio", imagePath: null })?.imagePath).toBe("cover:Post");
  });

  it("plays a library seed's station as returned", async () => {
    const { startRadio, playTracks } = mount({ seedInLibrary: true, tracks: [libTrack(1, "Joga"), libTrack(2, "Hunter")] });
    await startRadio({ title: "Joga", artistName: "Bjork", coverPath: null });
    expect(played(playTracks).map(t => t.title)).toEqual(["Joga", "Hunter"]);
  });

  it("says so and plays nothing when there is nothing to build from", async () => {
    const { startRadio, playTracks, notify } = mount({ seedInLibrary: false, tracks: [] });
    expect(await startRadio({ title: "Unknown", artistName: "Nobody", coverPath: null })).toBeNull();
    expect(playTracks).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("isn't in your library"));
  });
});
