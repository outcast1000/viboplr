import { describe, it, expect, afterEach, vi } from "vitest";
import {
  setPlaybackPosition,
  subscribePlaybackPosition,
  subscribeVisiblePlaybackPosition,
} from "../playback/positionStore";

// Toggle what `document.hidden` reports. happy-dom exposes it as a plain
// getter on Document.prototype, so a spy on the instance works.
function setDocumentHidden(hidden: boolean) {
  vi.spyOn(document, "hidden", "get").mockReturnValue(hidden);
}

afterEach(() => {
  vi.restoreAllMocks();
  setPlaybackPosition(0);
});

describe("subscribePlaybackPosition", () => {
  it("notifies on every distinct position, hidden or not", () => {
    const listener = vi.fn();
    const unsub = subscribePlaybackPosition(listener);
    setDocumentHidden(true);
    setPlaybackPosition(1);
    setPlaybackPosition(2);
    expect(listener).toHaveBeenCalledTimes(2);
    unsub();
    setPlaybackPosition(3);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("subscribeVisiblePlaybackPosition", () => {
  it("forwards ticks while the document is visible", () => {
    setDocumentHidden(false);
    const listener = vi.fn();
    const unsub = subscribeVisiblePlaybackPosition(listener);
    setPlaybackPosition(1);
    setPlaybackPosition(2);
    expect(listener).toHaveBeenCalledTimes(2);
    unsub();
  });

  it("mutes ticks while hidden and fires once on becoming visible", () => {
    setDocumentHidden(true);
    const listener = vi.fn();
    const unsub = subscribeVisiblePlaybackPosition(listener);
    setPlaybackPosition(1);
    setPlaybackPosition(2);
    expect(listener).not.toHaveBeenCalled();

    // A visibilitychange while still hidden must not leak a notification.
    document.dispatchEvent(new Event("visibilitychange"));
    expect(listener).not.toHaveBeenCalled();

    setDocumentHidden(false);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("stops listening to visibilitychange after unsubscribe", () => {
    setDocumentHidden(false);
    const listener = vi.fn();
    const unsub = subscribeVisiblePlaybackPosition(listener);
    unsub();
    setPlaybackPosition(1);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(listener).not.toHaveBeenCalled();
  });
});
