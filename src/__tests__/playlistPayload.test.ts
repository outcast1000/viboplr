import { describe, it, expect } from "vitest";
import { toPlaylistTrackPayload } from "../utils/playlistPayload";
import type { QueueTrack } from "../types";

describe("toPlaylistTrackPayload", () => {
  it("maps a full QueueTrack to the backend payload shape", () => {
    const t: QueueTrack = {
      key: "lib:5",
      path: "file:///music/a.flac",
      title: "Song A",
      artist_name: "Artist A",
      album_title: "Album A",
      duration_secs: 210.5,
      format: "flac",
      image_url: "/imgs/a.jpg",
      liked: 1,
    };
    expect(toPlaylistTrackPayload(t)).toEqual({
      title: "Song A",
      artist_name: "Artist A",
      album_name: "Album A",
      duration_secs: 210.5,
      source: "file:///music/a.flac",
      image_url: "/imgs/a.jpg",
    });
  });

  it("coalesces every optional field to null (never undefined — serde needs the keys)", () => {
    const t: QueueTrack = {
      key: "ext:1",
      path: null,
      title: "Bare",
      artist_name: null,
      album_title: null,
      duration_secs: null,
      format: null,
      liked: 0,
    };
    expect(toPlaylistTrackPayload(t)).toEqual({
      title: "Bare",
      artist_name: null,
      album_name: null,
      duration_secs: null,
      source: null,
      image_url: null,
    });
  });
});
