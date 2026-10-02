// Missing rows (album tracks the user doesn't own) render in place inside the
// TrackList but stay out of everything that acts on library rows: selection,
// select-all, delete, drag.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { createRef } from "react";
import { TrackList, type MissingTrackRow } from "../components/TrackList";
import type { Track, QueueTrack, ColumnConfig } from "../types";

vi.mock("../nativeMenu", () => ({ showNativeMenu: vi.fn().mockResolvedValue(undefined) }));

afterEach(cleanup);

function libTrack(id: number, title: string, n: number): Track {
  return {
    id, path: `file:///${title}.flac`, title, artist_id: 1, artist_name: "Bjork",
    album_id: 3, album_title: "Homogenic", year: 1997, track_number: n, duration_secs: 200,
    format: "flac", file_size: 1, collection_id: 1, collection_name: "Music", liked: 0,
    added_at: null, modified_at: null,
  };
}

function missing(title: string, before: number, number: number): MissingTrackRow {
  const track: QueueTrack = { key: `q:${title}`, path: null, title, artist_name: "Bjork", album_title: "Homogenic", duration_secs: null, format: null, liked: 0 };
  return { track, before, number, popularity: 500 };
}

const COLUMNS: ColumnConfig[] = (["num", "title", "duration", "popularity"] as const).map(id => ({ id, visible: true }));

function mount(extra: Partial<React.ComponentProps<typeof TrackList>> = {}) {
  const props: React.ComponentProps<typeof TrackList> = {
    tracks: [libTrack(1, "Hunter", 1), libTrack(4, "Bachelorette", 4)],
    currentTrack: null,
    highlightedIndex: -1,
    sortField: null,
    trackListRef: createRef<HTMLDivElement>(),
    columns: COLUMNS,
    onColumnsChange: vi.fn(),
    onDoubleClick: vi.fn(),
    onContextMenu: vi.fn(),
    onArtistClick: vi.fn(),
    onAlbumClick: vi.fn(),
    onSort: vi.fn(),
    sortIndicator: () => "",
    onToggleLike: vi.fn(),
    onDeleteTracks: vi.fn(),
    missingRows: [missing("Joga", 1, 2), missing("Unravel", 1, 3)],
    onPlayMissing: vi.fn(),
    onEnqueueMissing: vi.fn(),
    onMissingContextMenu: vi.fn(),
    ...extra,
  };
  return { props, ...render(<TrackList {...props} />) };
}

const rowTitles = (container: HTMLElement) =>
  [...container.querySelectorAll(".track-row .col-title-text")].map(el => el.textContent);

describe("TrackList missing rows", () => {
  it("interleaves them in album order, badged", () => {
    const { container } = mount();
    expect(rowTitles(container)).toEqual(["Hunter", "Joga", "Unravel", "Bachelorette"]);
    expect(container.querySelectorAll(".track-row--missing .track-missing-badge")).toHaveLength(2);
  });

  it("are never selected, by click or select-all, so Delete only sees library rows", () => {
    const { container, props } = mount();
    const missingRow = container.querySelector(".track-row--missing")!;
    fireEvent.click(missingRow);
    expect(missingRow.getAttribute("aria-selected")).toBe("false");

    fireEvent.keyDown(document.body, { key: "a", metaKey: true });
    fireEvent.keyDown(document.body, { key: "Delete" });
    expect(props.onDeleteTracks).toHaveBeenCalledWith([1, 4]);
    expect(container.querySelectorAll(".track-row--missing[aria-selected='true']")).toHaveLength(0);
  });

  it("play on double-click and open the track menu on right-click", () => {
    const { container, props } = mount();
    const missingRow = container.querySelector(".track-row--missing")!;
    fireEvent.doubleClick(missingRow);
    expect(props.onPlayMissing).toHaveBeenCalledWith(expect.objectContaining({ title: "Joga" }));
    expect(props.onDoubleClick).not.toHaveBeenCalled();
    fireEvent.contextMenu(missingRow);
    expect(props.onMissingContextMenu).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ title: "Joga" }));
    expect(props.onContextMenu).not.toHaveBeenCalled();
  });

  it("go after the library rows when placed at the end", () => {
    const { container } = mount({ missingRows: [missing("Joga", 2, 2)] });
    expect(rowTitles(container)).toEqual(["Hunter", "Bachelorette", "Joga"]);
  });

  it("get the same hover actions as library rows: play, enqueue, radio, details", () => {
    const onStartRadioMissing = vi.fn();
    const onLocateMissing = vi.fn();
    const { container, props } = mount({ onStartRadioMissing, onLocateMissing });
    const missingRow = container.querySelector(".track-row--missing")!;
    const titles = [...missingRow.querySelectorAll(".row-hover-action")].map(b => b.getAttribute("title"));
    expect(titles).toEqual(["Play", "Enqueue", "Start radio", "Details"]);

    fireEvent.click(missingRow.querySelector("[title='Start radio']")!);
    expect(onStartRadioMissing).toHaveBeenCalledWith(expect.objectContaining({ title: "Joga" }));
    fireEvent.click(missingRow.querySelector("[title='Details']")!);
    expect(onLocateMissing).toHaveBeenCalledWith(expect.objectContaining({ title: "Joga" }));
    fireEvent.click(missingRow.querySelector("[title='Enqueue']")!);
    expect(props.onEnqueueMissing).toHaveBeenCalledWith(expect.objectContaining({ title: "Joga" }));
  });
});
