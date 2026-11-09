// The window's no-modifier transport keys (Space = pause, ←/→ = seek, ↑/↓ =
// volume) stand down for a key a focused widget already handled
// (utils/textEntry.ts → widgetHandledKey). This pins that the widgets which
// act on those keys really do mark them handled — and only those keys — so a
// keypress moves the widget OR the transport, never both. Each check dispatches
// a real bubbling keydown and reads it the way the window listener does.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { createRef } from "react";
import { TrackList } from "../components/TrackList";
import { EqBarControl } from "../components/EqBarControl";
import { widgetHandledKey } from "../utils/textEntry";
import type { Track, ColumnConfig } from "../types";

vi.mock("../nativeMenu", () => ({ showNativeMenu: vi.fn().mockResolvedValue(undefined) }));

Element.prototype.scrollIntoView = function () { /* jsdom has none */ };

// What the window-level shortcut handler would decide for the last keydown.
let windowSaw: boolean | null = null;
const onWindowKey = (e: KeyboardEvent) => { windowSaw = widgetHandledKey(e); };
beforeEach(() => { windowSaw = null; window.addEventListener("keydown", onWindowKey); });
afterEach(() => { window.removeEventListener("keydown", onWindowKey); cleanup(); });

function press(el: Element, key: string): boolean | null {
  windowSaw = null;
  fireEvent.keyDown(el, { key });
  return windowSaw;
}

function track(id: number, title: string): Track {
  return {
    id, path: `file:///${title}.flac`, title, artist_id: 1, artist_name: "Bjork",
    album_id: 3, album_title: "Homogenic", year: 1997, track_number: id, duration_secs: 200,
    format: "flac", file_size: 1, collection_id: 1, collection_name: "Music", liked: 0,
    added_at: null, modified_at: null,
  };
}

const COLUMNS: ColumnConfig[] = (["num", "title", "duration"] as const).map(id => ({ id, visible: true }));

describe("widgets claim the transport keys they act on", () => {
  it("a focused TrackList: ↑/↓/Home/End move the cursor and Space selects, without seeking, volume or pausing", () => {
    const r = render(
      <TrackList
        tracks={[track(1, "Hunter"), track(2, "Joga"), track(3, "Bachelorette")]}
        currentTrack={null}
        highlightedIndex={-1}
        sortField={null}
        trackListRef={createRef<HTMLDivElement>()}
        columns={COLUMNS}
        onColumnsChange={vi.fn()}
        onDoubleClick={vi.fn()}
        onContextMenu={vi.fn()}
        onArtistClick={vi.fn()}
        onAlbumClick={vi.fn()}
        onSort={vi.fn()}
        sortIndicator={() => ""}
        onToggleLike={vi.fn()}
        onDeleteTracks={vi.fn()}
      />,
    );
    const list = r.getByRole("listbox");
    for (const key of ["ArrowDown", "ArrowDown", "ArrowUp", "End", "Home", " "]) {
      expect(press(list, key), key).toBe(true);
    }
    // Keys the list ignores still reach the transport.
    expect(press(list, "ArrowLeft")).toBe(false);
    expect(press(list, "ArrowRight")).toBe(false);
  });

  it("the EQ bar sliders: arrows step the gain, without seeking or changing the volume", () => {
    const r = render(
      <EqBarControl
        mode="simple" enabled bassDb={0} trebleDb={0} gains={[]} preGainDb={0}
        onBassChange={vi.fn()} onTrebleChange={vi.fn()} onEnsureEnabled={vi.fn()}
      />,
    );
    const [slider] = r.getAllByRole("slider");
    for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"]) {
      expect(press(slider, key), key).toBe(true);
    }
    // Space isn't a slider key: it still pauses.
    expect(press(slider, " ")).toBe(false);
  });
});
