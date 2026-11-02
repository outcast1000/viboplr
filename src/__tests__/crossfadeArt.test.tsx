import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import { CrossfadeArt } from "../components/NowPlayingBar";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const fallback = <div data-testid="placeholder" />;

describe("CrossfadeArt", () => {
  it("shows the fallback, not a broken image, when the first src fails to load", () => {
    // A plugin can hand over an image_url whose cached file is gone.
    const { container, getByTestId } = render(
      <CrossfadeArt className="now-art" src="asset://missing.jpg" fallback={fallback} />,
    );
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    getByTestId("placeholder");
  });

  it("swaps to the fallback when a later src fails to preload", () => {
    const images: { onload?: () => void; onerror?: () => void }[] = [];
    vi.stubGlobal("Image", class {
      onload?: () => void;
      onerror?: () => void;
      src = "";
      constructor() { images.push(this); }
    });
    const { container, rerender, getByTestId } = render(
      <CrossfadeArt className="now-art" src="asset://a.jpg" fallback={fallback} />,
    );
    expect(container.querySelector("img")?.getAttribute("src")).toBe("asset://a.jpg");

    rerender(<CrossfadeArt className="now-art" src="asset://missing.jpg" fallback={fallback} />);
    act(() => images[images.length - 1].onerror?.());
    expect(container.querySelector("img")).toBeNull();
    getByTestId("placeholder");

    // A good image for the next track replaces the fallback again.
    rerender(<CrossfadeArt className="now-art" src="asset://b.jpg" fallback={fallback} />);
    act(() => images[images.length - 1].onload?.());
    expect(container.querySelector("img")?.getAttribute("src")).toBe("asset://b.jpg");
  });
});
