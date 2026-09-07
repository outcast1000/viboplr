import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, waitFor, act } from "@testing-library/react";

/**
 * The maximize button is a toggle whose glyph and label must follow the window,
 * including when something other than the button changes it (Aero Snap, Win+Up,
 * a double-click on the caption bar, the fullscreen unmaximize/maximize dance).
 * That resync is what these tests pin.
 */
const tauri = vi.hoisted(() => ({
  maximized: false,
  /** The handler `onResized` was registered with, so a test can fire a resize. */
  handler: null as null | (() => void),
  unlisten: vi.fn(),
  toggleMaximize: vi.fn(),
  isMaximizedCalls: 0,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isMaximized: () => {
      tauri.isMaximizedCalls += 1;
      return Promise.resolve(tauri.maximized);
    },
    onResized: (h: () => void) => {
      tauri.handler = h;
      return Promise.resolve(tauri.unlisten);
    },
    toggleMaximize: tauri.toggleMaximize,
    minimize: vi.fn(),
    close: vi.fn(),
  }),
}));

const { WindowControls } = await import("../components/WindowControls");

/** jsdom reports a non-Mac platform, so `position="right"` is the Windows branch. */
function renderControls() {
  return render(<WindowControls position="right" />);
}

function maximizeBtn(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>(".window-control-maximize");
  if (!el) throw new Error("maximize button not rendered");
  return el;
}

beforeEach(() => {
  tauri.maximized = false;
  tauri.handler = null;
  tauri.isMaximizedCalls = 0;
  tauri.unlisten.mockClear();
  tauri.toggleMaximize.mockClear();
});

afterEach(cleanup);

describe("WindowControls — maximize/restore", () => {
  it("shows the single-square Maximize glyph when the window is restored", async () => {
    const { container } = renderControls();
    await waitFor(() => expect(tauri.isMaximizedCalls).toBeGreaterThan(0));

    const btn = maximizeBtn(container);
    expect(btn.getAttribute("title")).toBe("Maximize");
    expect(btn.getAttribute("aria-label")).toBe("Maximize");
    // One square, no overlapping-square path.
    expect(btn.querySelectorAll("rect")).toHaveLength(1);
    expect(btn.querySelector("path")).toBeNull();
  });

  it("shows the two-square Restore glyph when the window starts maximized", async () => {
    tauri.maximized = true;
    const { container } = renderControls();

    await waitFor(() => expect(maximizeBtn(container).getAttribute("title")).toBe("Restore"));
    const btn = maximizeBtn(container);
    expect(btn.getAttribute("aria-label")).toBe("Restore");
    // The front square plus the exposed L of the one behind it.
    expect(btn.querySelectorAll("rect")).toHaveLength(1);
    expect(btn.querySelector("path")).not.toBeNull();
  });

  it("swaps to Restore when the window is maximized without the button", async () => {
    const { container } = renderControls();
    await waitFor(() => expect(tauri.handler).not.toBeNull());
    expect(maximizeBtn(container).getAttribute("title")).toBe("Maximize");

    // Aero Snap / Win+Up / caption double-click: state changed, no click here.
    tauri.maximized = true;
    await act(async () => {
      tauri.handler?.();
    });

    await waitFor(() => expect(maximizeBtn(container).getAttribute("title")).toBe("Restore"));
  });

  it("swaps back to Maximize when the window is restored without the button", async () => {
    tauri.maximized = true;
    const { container } = renderControls();
    await waitFor(() => expect(maximizeBtn(container).getAttribute("title")).toBe("Restore"));

    tauri.maximized = false;
    await act(async () => {
      tauri.handler?.();
    });

    await waitFor(() => expect(maximizeBtn(container).getAttribute("title")).toBe("Maximize"));
  });

  it("settles on the final state after a burst of resize events", async () => {
    // Queries are coalesced to one in flight, so the last event must still be
    // honoured — otherwise a fast snap leaves the glyph on the previous state.
    const { container } = renderControls();
    await waitFor(() => expect(tauri.handler).not.toBeNull());

    // The first event must read *false* and the last state be *true*, or the
    // single leading query would land on the right answer by luck and the test
    // would pass with the re-query removed.
    await act(async () => {
      for (let i = 0; i < 10; i++) {
        tauri.maximized = i % 2 === 1;
        tauri.handler?.();
      }
      tauri.maximized = true;
    });

    await waitFor(() => expect(maximizeBtn(container).getAttribute("title")).toBe("Restore"));
  });

  it("unsubscribes the resize listener on unmount", async () => {
    const { unmount } = renderControls();
    await waitFor(() => expect(tauri.handler).not.toBeNull());

    unmount();

    await waitFor(() => expect(tauri.unlisten).toHaveBeenCalled());
  });

  it("toggles the window when clicked", async () => {
    const { container } = renderControls();
    await waitFor(() => expect(tauri.handler).not.toBeNull());

    act(() => {
      maximizeBtn(container).click();
    });

    expect(tauri.toggleMaximize).toHaveBeenCalledTimes(1);
  });
});
