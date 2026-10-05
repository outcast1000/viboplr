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
      providerId="slskd:slskd-import"
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
