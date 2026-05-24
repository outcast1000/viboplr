import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { useDetailHeroImages } from "../hooks/useDetailHeroImages";
import type { QueueTrack } from "../types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (p: string) => `asset://${p}`,
}));

import { invoke } from "@tauri-apps/api/core";

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function audioTrack(): QueueTrack {
  return {
    key: "lib:1",
    path: "file:///t.mp3",
    title: "T",
    artist_name: "Alpha",
    album_title: "A",
    duration_secs: 60,
    format: "mp3",
    liked: 0,
  };
}

function videoTrack(): QueueTrack {
  return {
    key: "lib:2",
    path: "file:///t.mp4",
    title: "V",
    artist_name: "Alpha",
    album_title: null,
    duration_secs: 60,
    format: "mp4",
    liked: 0,
  };
}

describe("useDetailHeroImages.track", () => {
  it("returns up to 4 cached video frame paths for a video track", async () => {
    (invoke as unknown as ReturnType<typeof vi.fn>).mockImplementation((cmd: string) => {
      if (cmd === "find_track_id_by_path") return Promise.resolve(42);
      if (cmd === "get_video_frames") return Promise.resolve({ status: "ok", paths: ["/f1", "/f2", "/f3", "/f4", "/f5"] });
      throw new Error("unexpected " + cmd);
    });
    const { result } = renderHook(() => useDetailHeroImages.track(videoTrack(), () => null));
    await waitFor(() => expect(result.current.length).toBe(4));
    // resolveImageUrl wraps file paths via convertFileSrc (mocked above)
    expect(result.current).toEqual(["asset:///f1", "asset:///f2", "asset:///f3", "asset:///f4"]);
  });

  it("falls back to artist image when video has no frames", async () => {
    (invoke as unknown as ReturnType<typeof vi.fn>).mockImplementation((cmd: string) => {
      if (cmd === "find_track_id_by_path") return Promise.resolve(42);
      if (cmd === "get_video_frames") return Promise.resolve(null);
      throw new Error("unexpected " + cmd);
    });
    const resolveArtist = vi.fn(() => "/artist.jpg");
    const { result } = renderHook(() => useDetailHeroImages.track(videoTrack(), resolveArtist));
    await waitFor(() => expect(result.current).toEqual(["asset:///artist.jpg"]));
    expect(resolveArtist).toHaveBeenCalledWith("Alpha");
  });

  it("uses artist image directly for an audio track without invoking video frame command", async () => {
    const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;
    const resolveArtist = vi.fn(() => "/artist.jpg");
    const { result } = renderHook(() => useDetailHeroImages.track(audioTrack(), resolveArtist));
    await waitFor(() => expect(result.current).toEqual(["asset:///artist.jpg"]));
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("returns empty array if neither frames nor artist image are available", async () => {
    (invoke as unknown as ReturnType<typeof vi.fn>).mockImplementation((cmd: string) => {
      if (cmd === "find_track_id_by_path") return Promise.resolve(42);
      if (cmd === "get_video_frames") return Promise.resolve(null);
      throw new Error("unexpected " + cmd);
    });
    const { result } = renderHook(() => useDetailHeroImages.track(videoTrack(), () => null));
    await waitFor(() => expect(result.current).toEqual([]));
  });
});
