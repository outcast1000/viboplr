import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { RankedListRenderer } from "../components/renderers/RankedListRenderer";

afterEach(cleanup);

// Similar Tracks: two track rows (one in the library, one not) around an
// artist row, which is not a track and must not join the queued list.
const data = {
  items: [
    { name: "Airbag", subtitle: "Radiohead", value: 90 },
    { name: "Radiohead", libraryKind: "artist", libraryId: 7, value: 80 },
    { name: "Let Down", subtitle: "Radiohead", value: 70, libraryKind: "track", libraryId: 42 },
  ],
};

function rows(container: HTMLElement) {
  return Array.from(container.querySelectorAll(".ranked-list-item")) as HTMLElement[];
}

describe("RankedListRenderer row click", () => {
  it("queues every track row from the clicked one, library or not", () => {
    const onAction = vi.fn();
    const onEntityClick = vi.fn();
    const { container } = render(<RankedListRenderer data={data} onAction={onAction} onEntityClick={onEntityClick} />);

    fireEvent.click(rows(container)[2]);

    expect(onAction).toHaveBeenCalledWith("play-list", {
      items: [{ name: "Airbag", artist: "Radiohead" }, { name: "Let Down", artist: "Radiohead" }],
      startIndex: 1,
    });
    expect(onEntityClick).not.toHaveBeenCalled();
  });

  it("makes a track row clickable even when nothing in the library matches", () => {
    const { container } = render(<RankedListRenderer data={data} onAction={vi.fn()} />);
    expect(rows(container)[0].classList.contains("clickable")).toBe(true);
  });

  it("still navigates for a non-track row", () => {
    const onAction = vi.fn();
    const onEntityClick = vi.fn();
    const { container } = render(<RankedListRenderer data={data} onAction={onAction} onEntityClick={onEntityClick} />);

    fireEvent.click(rows(container)[1]);

    expect(onEntityClick).toHaveBeenCalledWith("artist", 7, "Radiohead");
    expect(onAction).not.toHaveBeenCalled();
  });

  it("keeps the hover Play button to the single track", () => {
    const onAction = vi.fn();
    const { container } = render(<RankedListRenderer data={data} onAction={onAction} />);

    fireEvent.click(rows(container)[0].querySelector(".track-row-action-play")!);

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith("play-track", { name: "Airbag", artist: "Radiohead" });
  });
});
