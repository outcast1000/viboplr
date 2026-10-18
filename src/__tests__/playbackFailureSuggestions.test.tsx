// The failure dialog's "these plugins can look for a playable copy" section:
// shown only when there is something to suggest, worded for the two cases, and
// a row's button only asks App to open that plugin — never installs it.
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import PlaybackFailureModal from "../components/PlaybackFailureModal";
import type { QueueTrack } from "../types";
import type { TrackFailure } from "../playback/trackFailures";
import type { FallbackSuggestions } from "../utils/fallbackSuggestions";

const track: QueueTrack = {
  key: "q:1", path: null, title: "Nothingman", artist_name: "Pearl Jam", album_title: "Vitalogy",
  duration_secs: 276, format: null, liked: 0,
};
const failure: TrackFailure = { stage: "resolve", summary: "No playable source found", at: 0, attempts: [] };

function show(suggestions: FallbackSuggestions | null) {
  const onShowPlugin = vi.fn();
  render(
    <PlaybackFailureModal
      track={track}
      failure={failure}
      onClose={() => {}}
      onRetry={() => {}}
      onReportProblem={() => {}}
      suggestions={suggestions}
      onShowPlugin={onShowPlugin}
    />,
  );
  return onShowPlugin;
}

afterEach(cleanup);

describe("PlaybackFailureModal plugin suggestions", () => {
  it("lists the suggestions and opens the one picked", () => {
    const onShowPlugin = show({
      reason: "none-ran",
      plugins: [
        { id: "qbittorrent", name: "qBittorrent", description: "Torrents", action: "enable", experimental: false },
        { id: "ytdlp", name: "yt-dlp", description: "YouTube and more", action: "install", experimental: false },
      ],
    });
    expect(screen.getByText(/No playback fallback is on/)).toBeTruthy();
    expect(screen.getByText("Installed, off")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View plugin…" }));
    expect(onShowPlugin).toHaveBeenCalledWith("ytdlp");
    fireEvent.click(screen.getByRole("button", { name: "Turn on…" }));
    expect(onShowPlugin).toHaveBeenLastCalledWith("qbittorrent");
  });

  it("words the case where the user's fallbacks were asked", () => {
    show({ reason: "all-missed", plugins: [{ id: "slskd", name: "Soulseek", description: "", action: "install", experimental: true }] });
    expect(screen.getByText(/None of your playback fallbacks had it/)).toBeTruthy();
    expect(screen.getByText("Experimental")).toBeTruthy();
  });

  it("shows no section when there is nothing to suggest", () => {
    show(null);
    expect(screen.queryByText(/can look for a playable copy|None of your playback fallbacks/)).toBeNull();
    expect(screen.queryByRole("button", { name: /View plugin|Turn on/ })).toBeNull();
  });
});
