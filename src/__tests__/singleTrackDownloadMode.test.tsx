import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";

/**
 * Which step the single-track download modal opens on is decided by ONE input:
 * whether the caller handed it a `resolveTrack`. It used to be inferred from
 * `track.uri`, and a track a playback fallback played (or a "Not in library"
 * row) has none — so a plan that knew exactly how to fetch the track opened the
 * provider's interactive search instead, which Soulseek doesn't answer: "No
 * matches found on Soulseek" on the song that was playing. These tests pin the
 * mode to `resolveTrack` and nothing else.
 */
const invoke = vi.hoisted(() => vi.fn(async (cmd: string) => {
  if (cmd === "check_dest_conflict") return { has_conflict: false, dest_path: "/music/A - B.flac", existing_size: null, existing_format: null };
  if (cmd === "download_to_path") return { path: "/music/A - B.flac", format: "flac", file_size: 1 };
  return null;
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke, convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../utils/tauriEvents", () => ({ subscribe: () => () => undefined, safeUnlisten: vi.fn() }));

const { SingleTrackDownload } = await import("../components/download/SingleTrackDownload");

const store = { get: vi.fn(async () => null), set: vi.fn() } as never;

function renderModal(props: { uri: string | null; resolveTrack?: ReturnType<typeof vi.fn> }) {
  const onSearch = vi.fn(async () => []);
  const onResolve = vi.fn();
  const utils = render(
    <SingleTrackDownload
      track={{ title: "Lady Writer", artistName: "Dire Straits", uri: props.uri }}
      providerName="Soulseek"
      resolveTrack={props.resolveTrack as never}
      collections={[{ id: 1, name: "Music", path: "/music" }]}
      store={store}
      lastDest={null}
      onSearch={onSearch}
      onResolve={onResolve}
      onClose={vi.fn()}
      onComplete={vi.fn()}
    />,
  );
  return { ...utils, onSearch, onResolve };
}

afterEach(() => {
  cleanup();
  invoke.mockClear();
});

describe("SingleTrackDownload mode", () => {
  it("a plan's resolve with NO uri skips the search and resolves the track itself", async () => {
    const resolveTrack = vi.fn(async (_format: string) => ({ url: "file:///slskd/Lady Writer.flac", headers: null, metadata: null, ext: "flac" }));
    const { getByText, queryByText, onSearch, onResolve } = renderModal({ uri: null, resolveTrack });

    expect(queryByText(/No matches found/)).toBeNull();
    expect(onSearch).not.toHaveBeenCalled();

    fireEvent.click(getByText("Download"));
    await waitFor(() => expect(resolveTrack).toHaveBeenCalledTimes(1));
    expect(resolveTrack.mock.calls[0][0]).toBe("original");
    expect(onResolve).not.toHaveBeenCalled();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("download_to_path", expect.objectContaining({ streamUrl: "file:///slskd/Lady Writer.flac" })));
  });

  it("a uri alone does not make it direct — no resolveTrack means the provider's search", async () => {
    const { onSearch } = renderModal({ uri: "tidal://5" });
    await waitFor(() => expect(onSearch).toHaveBeenCalledWith("Lady Writer Dire Straits", 10));
  });
});

// A quality option is often a cap ("1080p") the source falls short of, so the
// result step shows what the provider says it actually fetched.
describe("SingleTrackDownload quality line", () => {
  it("shows the provider's quality on the result step", async () => {
    const resolveTrack = vi.fn(async () => ({
      url: "file:///tmp/dl.mp4", headers: null, metadata: null, ext: "mp4",
      quality: "  480p · H.264 + AAC · 714 kbps — the best H.264 this source offers up to 1080p ",
    }));
    const { getByText, findByText } = renderModal({ uri: null, resolveTrack });
    fireEvent.click(getByText("Download"));
    await findByText("Download complete");
    expect(getByText("Quality")).toBeTruthy();
    expect(getByText("480p · H.264 + AAC · 714 kbps — the best H.264 this source offers up to 1080p")).toBeTruthy();
  });

  it("shows no Quality row when the provider reports none", async () => {
    const resolveTrack = vi.fn(async () => ({ url: "file:///tmp/a.flac", headers: null, metadata: null, ext: "flac" }));
    const { getByText, findByText, queryByText } = renderModal({ uri: null, resolveTrack });
    fireEvent.click(getByText("Download"));
    await findByText("Download complete");
    expect(queryByText("Quality")).toBeNull();
  });
});

// The rest of the window's behaviour, each pinned because it was a user-visible
// problem in the download UX review.
describe("SingleTrackDownload review fixes", () => {
  const baseInvoke = invoke.getMockImplementation()!;
  afterEach(() => { invoke.mockImplementation(baseInvoke); });

  function withInvoke(over: Record<string, (args: Record<string, unknown>) => unknown>) {
    invoke.mockImplementation((async (cmd: string, args?: Record<string, unknown>) => {
      if (over[cmd]) return over[cmd](args ?? {});
      return baseInvoke(cmd);
    }) as never);
  }

  function renderWith(props: Partial<Parameters<typeof SingleTrackDownload>[0]> & { storeValues?: Record<string, unknown> }) {
    const { storeValues, ...rest } = props;
    const s = { get: vi.fn(async (k: string) => storeValues?.[k] ?? null), set: vi.fn() } as never;
    return render(
      <SingleTrackDownload
        track={{ title: "Alive", artistName: "Pearl Jam", uri: null }}
        providerName="yt-dlp"
        collections={[{ id: 1, name: "Music", path: "/music" }]}
        store={s}
        lastDest={null}
        onSearch={vi.fn(async () => [])}
        onResolve={vi.fn()}
        onClose={vi.fn()}
        onComplete={vi.fn()}
        {...rest}
      />,
    );
  }

  const COMPARE_PREVIEW = { old_path: "/music/a.flac", old_format: "flac", old_file_size: 40, new_path: "/music/a.new.ogg", new_format: "ogg", new_file_size: 5 };

  it("Back from Compare files returns to the configure step, not an empty search", async () => {
    withInvoke({
      download_preview: () => COMPARE_PREVIEW,
      get_audio_properties_by_path: () => ({ sample_rate: 48000, bit_depth: null, channels: 2, bitrate: 130, duration_secs: 341 }),
    });
    const resolveTrack = vi.fn(async () => ({ url: "file:///tmp/a.ogg", headers: null, metadata: null, ext: "ogg" }));
    const { getByText, findByText, queryByText } = renderWith({
      track: { title: "Alive", artistName: "Pearl Jam", uri: "file:///music/a.flac", trackId: 7 },
      resolveTrack: resolveTrack as never,
    });
    fireEvent.click(getByText("Download"));
    await findByText("Compare files");
    fireEvent.click(getByText("Back"));
    await findByText("Download");
    expect(queryByText(/No matches found/)).toBeNull();
    expect(queryByText("Compare files")).toBeNull();
  });

  it("warns about a downgrade and makes Save as Copy the default", async () => {
    withInvoke({
      download_preview: () => COMPARE_PREVIEW,
      get_audio_properties_by_path: ({ path }) => path === "/music/a.flac"
        ? { sample_rate: 44100, bit_depth: 16, channels: 2, bitrate: 1012, duration_secs: 341 }
        : { sample_rate: 48000, bit_depth: null, channels: 2, bitrate: 130, duration_secs: 362 },
    });
    const resolveTrack = vi.fn(async () => ({ url: "file:///tmp/a.ogg", headers: null, metadata: null, ext: "ogg" }));
    const { getByText, findByText } = renderWith({
      track: { title: "Alive", artistName: "Pearl Jam", uri: "file:///music/a.flac", trackId: 7 },
      resolveTrack: resolveTrack as never,
    });
    fireEvent.click(getByText("Download"));
    await findByText("This is lower quality than your file, and 21 s longer, so it may be a different version.");
    expect(getByText("16-bit · 44.1 kHz")).toBeTruthy();
    expect(getByText("Save as Copy").className).toBe("dl-btn-primary");
    expect(getByText("Replace").className).toBe("dl-btn-secondary");
  });

  it("shows the previewed item and downloads exactly that one, tagged with the track's own names", async () => {
    const resolveTrack = vi.fn();
    const resolveMatch = vi.fn(async (_id: string, _format: string) => ({ url: "file:///tmp/v.mp4", headers: null, metadata: { title: "Pearl Jam - Alive (Official Video)" }, ext: "mp4" }));
    const preview = vi.fn(async () => ({
      match: { id: "ytdlp://abc", title: "Pearl Jam - Alive (Official Video)", artistName: "PearlJamVEVO", durationSecs: 341 },
      note: "The same video you just watched",
      qualities: [{ value: "original", label: "Audio · Original — Opus 130 kbps" }, { value: "video", label: "Video · MP4 · Best (480p)", video: true }],
    }));
    const { getByText, findByText } = renderWith({
      track: { title: "Alive", artistName: "Pearl Jam", uri: null, isVideo: true },
      resolveTrack: resolveTrack as never,
      preview: preview as never,
      resolveMatch: resolveMatch as never,
      search: vi.fn(async () => []) as never,
    });
    await findByText("Pearl Jam - Alive (Official Video)");
    expect(preview).toHaveBeenCalledWith({ isVideo: true });
    expect(getByText(/The same video you just watched/)).toBeTruthy();
    expect(getByText("Choose a different match…")).toBeTruthy();
    // The previewed list replaces the fixed one, and a video track lands on its
    // video option in the same render the preview appears in.
    expect(getByText("Video · MP4 · Best (480p)").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(getByText("Download"));
    await findByText("Download complete");
    expect(resolveTrack).not.toHaveBeenCalled();
    expect(resolveMatch.mock.calls[0][0]).toBe("ytdlp://abc");
    expect(resolveMatch.mock.calls[0][1]).toBe("video");
    expect(invoke).toHaveBeenCalledWith("download_to_path", expect.objectContaining({ title: "Alive", artistName: "Pearl Jam" }));
  });

  it("a match picked from the search gets its own real qualities", async () => {
    const preview = vi.fn(async (opts: { isVideo: boolean; uri?: string }) => opts.uri === "ytdlp://picked"
      ? { match: { id: "ytdlp://picked", title: "x" }, qualities: [{ value: "original", label: "Audio · Original — AAC 128 kbps" }] }
      : { match: { id: "ytdlp://first", title: "Pearl Jam - Alive (Official Video)" } });
    const search = vi.fn(async () => [{ id: "ytdlp://picked", title: "Alive (Live)", artistName: "Pearl Jam" }]);
    const { getByText, findByText } = renderWith({
      resolveTrack: vi.fn() as never,
      preview: preview as never,
      resolveMatch: vi.fn() as never,
      search: search as never,
    });
    fireEvent.click(await findByText("Choose a different match…"));
    fireEvent.click(await findByText("Alive (Live)"));
    await findByText("Audio · Original — AAC 128 kbps");
    expect(preview).toHaveBeenLastCalledWith({ isVideo: false, uri: "ytdlp://picked" });
    expect(getByText("Alive (Live)")).toBeTruthy();
  });

  it("checks the destination with the folder layout and the album", async () => {
    const resolveTrack = vi.fn(async () => ({ url: "file:///tmp/a.flac", headers: null, metadata: { album: "Ten", trackNumber: 2 }, ext: "flac" }));
    const { getByText, findByText } = renderWith({ resolveTrack: resolveTrack as never });
    expect(getByText("Music › Artist › Album")).toBeTruthy();
    fireEvent.click(getByText("Download"));
    await findByText("Download complete");
    expect(invoke).toHaveBeenCalledWith("check_dest_conflict", expect.objectContaining({
      layout: "artist-album", albumTitle: "Ten", trackNumber: 2, isVideo: false,
    }));
  });

  it("says why a saved file isn't in the library", async () => {
    withInvoke({ add_downloaded_track: () => { throw new Error("the library couldn't read the file"); } });
    const resolveTrack = vi.fn(async () => ({ url: "https://x/a.flac", headers: null, metadata: null, ext: "flac" }));
    const { getByText, findByText, queryByText } = renderWith({ resolveTrack: resolveTrack as never });
    fireEvent.click(getByText("Download"));
    await findByText(/Saved, but not added to the library: the library couldn't read the file/);
    expect(queryByText("Added to library.")).toBeNull();
  });

  it("warns when the song is already in the library", async () => {
    withInvoke({ find_track_by_metadata: () => ({ id: 3, title: "Alive", artist_name: "Pearl Jam", format: "flac", collection_name: "Music", path: "file:///music/x.flac" }) });
    const { findByText } = renderWith({ resolveTrack: vi.fn() as never });
    await findByText(/You already have this song: Alive — Pearl Jam · FLAC · in Music/);
    await findByText("Download anyway");
  });

  it("opens on the quality last used with this provider", async () => {
    const qualityOptions = [
      { value: "original", label: "Audio · Original" },
      { value: "video", label: "Video · MP4 · Best", video: true },
      { value: "video-720", label: "Video · MP4 · 720p", video: true },
    ];
    const resolveTrack = vi.fn(async () => ({ url: "file:///tmp/v.mp4", headers: null, metadata: null, ext: "mp4" }));
    const { findByText, getByText } = renderWith({
      track: { title: "Alive", artistName: "Pearl Jam", uri: null, isVideo: true },
      providerId: "ytdlp:ytdlp-download",
      qualityOptions,
      resolveTrack: resolveTrack as never,
      storeValues: { downloadQualityByProvider: { "ytdlp:ytdlp-download": { video: "video-720" } } },
    });
    await findByText("Your last choice for yt-dlp videos");
    fireEvent.click(getByText("Download"));
    await waitFor(() => expect(resolveTrack).toHaveBeenCalled());
    expect((resolveTrack.mock.calls[0] as unknown[])[0]).toBe("video-720");
  });
});
