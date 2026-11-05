import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { QueueItemThumb } from "../components/QueuePanel";
import type { QueueTrack } from "../types";

afterEach(cleanup);

const track: QueueTrack = {
  key: "q:1",
  path: "spotify://abc",
  title: "The Hollow",
  artist_name: "A Perfect Circle",
  album_title: "Mer De Noms",
  duration_secs: 178,
  format: null,
  image_url: "C:/cache/track-0476f2a4.jpg",
};

const img = (c: HTMLElement) => c.querySelector<HTMLImageElement>("img.queue-item-thumb");

describe("QueueItemThumb", () => {
  it("doesn't ask the album/artist chain while the entry's own image loads", () => {
    const entity = vi.fn(() => "album.jpg");
    const { container } = render(
      <QueueItemThumb localThumb={null} fallback="own.jpg" entityFallback={entity} track={track} />,
    );
    expect(img(container)?.getAttribute("src")).toBe("own.jpg");
    expect(entity).not.toHaveBeenCalled();
  });

  it("falls back to the album/artist image when the entry's own image is gone", () => {
    // A plugin handed a local path it pruned later (Spotify mix refresh).
    const { container } = render(
      <QueueItemThumb localThumb={null} fallback="own.jpg" entityFallback={() => "album.jpg"} track={track} />,
    );
    fireEvent.error(img(container)!);
    expect(img(container)?.getAttribute("src")).toBe("album.jpg");
  });

  it("tries the local thumb, then the entry's image, then the entity chain", () => {
    const { container } = render(
      <QueueItemThumb localThumb="thumb.jpg" fallback="own.jpg" entityFallback={() => "album.jpg"} track={track} />,
    );
    fireEvent.error(img(container)!);
    expect(img(container)?.getAttribute("src")).toBe("own.jpg");
    fireEvent.error(img(container)!);
    expect(img(container)?.getAttribute("src")).toBe("album.jpg");
  });

  it("shows the placeholder once every candidate has failed", () => {
    const { container } = render(
      <QueueItemThumb localThumb={null} fallback="own.jpg" entityFallback={() => "album.jpg"} track={track} />,
    );
    fireEvent.error(img(container)!);
    fireEvent.error(img(container)!);
    expect(img(container)).toBeNull();
    expect(container.querySelector(".queue-item-thumb-placeholder")).not.toBeNull();
  });

  it("shows the placeholder while the entity lookup has nothing yet", () => {
    const { container } = render(
      <QueueItemThumb localThumb={null} fallback="own.jpg" entityFallback={() => null} track={track} />,
    );
    fireEvent.error(img(container)!);
    expect(container.querySelector(".queue-item-thumb-placeholder")).not.toBeNull();
  });
});
