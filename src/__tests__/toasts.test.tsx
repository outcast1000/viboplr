import { afterEach, describe, it, expect, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook } from "@testing-library/react";
import {
  ACTION_TOAST_MS,
  RELEASE_MIN_MS,
  TOAST_DURATION_MS,
  TOAST_FADE_MS,
  TOAST_TO_BELL_MS,
  coerceToastKind,
  useToasts,
  type CurrentToast,
} from "../hooks/useToasts";
import { Toasts } from "../components/Toasts";
import { NotificationBell } from "../components/NotificationBell";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** The message on screen, or null (a leaving toast is on its way out). */
function shown(current: CurrentToast | null): string | null {
  return current && !current.leaving ? current.item.message : null;
}

function toast(over: Partial<CurrentToast["item"]> = {}, extra = 0): CurrentToast {
  return {
    item: { id: 1, message: "Saved", kind: "info", count: 1, at: 1, unseen: false, ...over },
    extra,
    durationMs: 4500,
    running: true,
    leaving: null,
  };
}

function renderToast(current: CurrentToast, handlers: Partial<Parameters<typeof Toasts>[0]> = {}) {
  return render(
    <Toasts
      current={current}
      onDismiss={handlers.onDismiss ?? (() => {})}
      onAction={handlers.onAction ?? (() => {})}
      onHold={handlers.onHold ?? (() => {})}
      onOpenList={handlers.onOpenList ?? (() => {})}
    />,
  );
}

describe("the toast", () => {
  it("shows the whole message with its source, and clicking the text does nothing", () => {
    const onDismiss = vi.fn();
    const long = "This station has only 9 tracks, because your library has little by this artist. Add more of their albums for a longer station.";
    const { getByText, container } = renderToast(toast({ message: long, source: "Radio" }), { onDismiss });
    expect(container.querySelector(".toast-message")?.textContent).toBe(`Radio${long}`);
    fireEvent.click(getByText(long));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("dismisses only from ×, and runs its action from the button", () => {
    const onDismiss = vi.fn();
    const onAction = vi.fn();
    const { getByLabelText, getByText } = renderToast(
      toast({ id: 7, message: "slskd isn't running.", kind: "warning", action: { label: "Start slskd", run: () => {} } }),
      { onDismiss, onAction },
    );
    fireEvent.click(getByText("Start slskd"));
    expect(onAction).toHaveBeenCalledWith(7);
    fireEvent.click(getByLabelText("Dismiss"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("draws the kind as the notice tone, and an error as an alert", () => {
    const { container, rerender } = renderToast(toast({ kind: "success" }));
    const el = () => container.querySelector(".toast")!;
    expect(el().className).toContain("notice-tone--success");
    expect(el().getAttribute("role")).toBe("status");
    rerender(<Toasts current={toast({ kind: "error" })} onDismiss={() => {}} onAction={() => {}} onHold={() => {}} onOpenList={() => {}} />);
    expect(el().className).toContain("notice-tone--error");
    expect(el().getAttribute("role")).toBe("alert");
  });

  it("shows ×N for a repeat and +N for what it replaced, which opens the list", () => {
    const onOpenList = vi.fn();
    const { container, getByText } = renderToast(toast({ count: 3 }, 2), { onOpenList });
    expect(container.querySelector(".toast-count")?.textContent).toBe("×3");
    fireEvent.click(getByText("+2"));
    expect(onOpenList).toHaveBeenCalled();
  });

  it("holds the countdown while hovered, and lets go when it unmounts under the pointer", () => {
    const onHold = vi.fn();
    const { container, unmount } = renderToast(toast(), { onHold });
    fireEvent.mouseEnter(container.querySelector(".toast")!);
    expect(onHold).toHaveBeenLastCalledWith("hover", true);
    unmount();
    expect(onHold).toHaveBeenCalledWith("hover", false);
  });
});

describe("one toast at a time", () => {
  it("replaces the toast on screen and counts what it replaced", () => {
    const { result } = renderHook(() => useToasts());
    act(() => {
      for (const m of ["a", "b", "c"]) result.current.notify(m);
    });
    expect(shown(result.current.current)).toBe("c");
    expect(result.current.current?.extra).toBe(2);
    expect(result.current.items.map((i) => i.message)).toEqual(["c", "b", "a"]);
  });

  it("times each kind out, an action later, and nothing is sticky", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useToasts());
    act(() => result.current.notify("Couldn't save", { kind: "error" }));
    act(() => vi.advanceTimersByTime(TOAST_DURATION_MS.error - 100));
    expect(shown(result.current.current)).toBe("Couldn't save");
    act(() => vi.advanceTimersByTime(200 + TOAST_TO_BELL_MS));
    expect(result.current.current).toBeNull();

    act(() => result.current.notify("Ready", { action: { label: "Open", run: () => {} } }));
    act(() => vi.advanceTimersByTime(TOAST_DURATION_MS.info + 100));
    expect(shown(result.current.current)).toBe("Ready");
    act(() => vi.advanceTimersByTime(ACTION_TOAST_MS));
    expect(shown(result.current.current)).toBeNull();
  });

  it("waits while held and gets at least a short while once let go", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useToasts());
    act(() => result.current.notify("hello"));
    act(() => vi.advanceTimersByTime(4000));
    act(() => result.current.hold("hover", true));
    act(() => vi.advanceTimersByTime(60_000));
    expect(shown(result.current.current)).toBe("hello");
    expect(result.current.current?.running).toBe(false);
    act(() => result.current.hold("hover", false));
    act(() => vi.advanceTimersByTime(RELEASE_MIN_MS - 100));
    expect(shown(result.current.current)).toBe("hello");
    act(() => vi.advanceTimersByTime(200));
    expect(shown(result.current.current)).toBeNull();
  });

  it("holds while the window is in the background", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useToasts());
    act(() => result.current.notify("while you were away"));
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    act(() => vi.advanceTimersByTime(60_000));
    expect(shown(result.current.current)).toBe("while you were away");
  });

  it("folds a repeat into one row and shows it again", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useToasts());
    act(() => result.current.notify("No video found"));
    act(() => vi.advanceTimersByTime(4000));
    act(() => result.current.notify("No video found"));
    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0].count).toBe(2);
    // The original deadline has passed; the repeat restarted it.
    act(() => vi.advanceTimersByTime(1000));
    expect(shown(result.current.current)).toBe("No video found");
  });

  it("does not fold the same text across kinds or buttons", () => {
    const { result } = renderHook(() => useToasts());
    act(() => {
      result.current.notify("Same words");
      result.current.notify("Same words", { kind: "error" });
      result.current.notify("Same words", { action: { label: "Fix", run: () => {} } });
    });
    expect(result.current.items).toHaveLength(3);
  });
});

describe("the bell", () => {
  it("lights only for an error or an untaken action that left unhandled", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useToasts());
    act(() => result.current.notify("Saved", { kind: "success" }));
    act(() => vi.advanceTimersByTime(TOAST_DURATION_MS.success + TOAST_FADE_MS));
    expect(result.current.unseenCount).toBe(0);

    act(() => result.current.notify("Couldn't save", { kind: "error" }));
    expect(result.current.unseenCount).toBe(0); // on screen: not unseen yet
    act(() => vi.advanceTimersByTime(TOAST_DURATION_MS.error + TOAST_TO_BELL_MS));
    expect(result.current.unseenCount).toBe(1);
    expect(result.current.unseenError).toBe(true);
  });

  it("counts an error pushed off by a newer toast", () => {
    const { result } = renderHook(() => useToasts());
    act(() => {
      result.current.notify("Couldn't reach Last.fm", { kind: "error" });
      result.current.notify("Added 12 tracks");
    });
    expect(result.current.unseenCount).toBe(1);
  });

  it("lights nothing for a toast the user closed", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useToasts());
    act(() => result.current.notify("Couldn't save", { kind: "error" }));
    act(() => result.current.dismiss());
    act(() => vi.advanceTimersByTime(TOAST_FADE_MS));
    expect(result.current.current).toBeNull();
    expect(result.current.unseenCount).toBe(0);
    expect(result.current.items).toHaveLength(1);
  });

  it("clears when the list opens, marking what was unseen for that look", () => {
    const { result } = renderHook(() => useToasts());
    act(() => {
      result.current.notify("Couldn't save", { kind: "error" });
      result.current.notify("next");
    });
    const errorId = result.current.items[1].id;
    act(() => result.current.setListOpen(true));
    expect(result.current.unseenCount).toBe(0);
    expect(result.current.freshIds.has(errorId)).toBe(true);
    expect(result.current.current?.leaving).toBeTruthy();
  });

  it("shows no toast while the list is open — the row is right there", () => {
    const { result } = renderHook(() => useToasts());
    act(() => result.current.setListOpen(true));
    act(() => result.current.notify("Added"));
    expect(result.current.current).toBeNull();
    expect(result.current.items[0].message).toBe("Added");
  });

  it("running an action handles it: the button goes and the dot doesn't light", () => {
    const run = vi.fn();
    const { result } = renderHook(() => useToasts());
    act(() => result.current.notify("Upgrade ready", { action: { label: "Compare", run } }));
    act(() => result.current.runAction(result.current.items[0].id));
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.current.items[0].action).toBeUndefined();
    expect(result.current.unseenCount).toBe(0);
  });

  it("removes one row or clears them all", () => {
    const { result } = renderHook(() => useToasts());
    act(() => {
      result.current.notify("a");
      result.current.notify("b");
    });
    act(() => result.current.remove(result.current.items[0].id));
    expect(result.current.items.map((i) => i.message)).toEqual(["a"]);
    act(() => result.current.clearAll());
    expect(result.current.items).toEqual([]);
  });

  it("names its state, and its dot is red for an error", () => {
    const { getByRole, container, rerender } = render(<NotificationBell unseenCount={0} unseenError={false} open={false} onToggle={() => {}} />);
    expect(getByRole("button").getAttribute("aria-label")).toBe("Notifications");
    expect(container.querySelector(".notification-bell-dot")).toBeNull();
    rerender(<NotificationBell unseenCount={2} unseenError open={false} onToggle={() => {}} />);
    expect(getByRole("button").getAttribute("aria-label")).toBe("Notifications, 2 unseen");
    expect(container.querySelector(".notification-bell-dot")?.className).toContain("is-error");
  });
});

describe("plugin-supplied kinds", () => {
  it("accepts the four kinds and drops anything else", () => {
    for (const k of ["info", "success", "warning", "error"]) expect(coerceToastKind(k)).toBe(k);
    expect(coerceToastKind("critical")).toBeUndefined();
    expect(coerceToastKind(undefined)).toBeUndefined();
    expect(coerceToastKind(3)).toBeUndefined();
  });
});
