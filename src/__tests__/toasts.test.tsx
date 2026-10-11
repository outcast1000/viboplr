import { afterEach, describe, it, expect, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook } from "@testing-library/react";
import { ACTION_TOAST_MS, MAX_VISIBLE_TOASTS, TOAST_EXIT_MS, coerceToastKind, useToasts } from "../hooks/useToasts";
import { Toasts } from "../components/Toasts";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Messages still on screen (a leaving toast is on its way out). */
function shown(toasts: { message: string; leaving?: boolean }[]): string[] {
  return toasts.filter((t) => !t.leaving).map((t) => t.message);
}

// A toast may carry one action ("Start slskd"), which plugins reach through
// `api.ui.showNotification(message, { action })`. The button must do its
// thing, the message must still just dismiss, and a toast with a button must
// stay up long enough to reach it.
describe("toasts with an action", () => {
  it("runs the action and dismisses; the message alone only dismisses", () => {
    const run = vi.fn();
    const onDismiss = vi.fn();
    const { getByText } = render(
      <Toasts toasts={[{ id: 1, message: "slskd isn't running.", kind: "warning", count: 1, action: { label: "Start slskd", run } }]} onDismiss={onDismiss} />,
    );
    fireEvent.click(getByText("slskd isn't running."));
    expect(onDismiss).toHaveBeenCalledWith(1);
    expect(run).not.toHaveBeenCalled();
    fireEvent.click(getByText("Start slskd"));
    expect(run).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it("stays up longer than a plain toast", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useToasts(4500));
    act(() => {
      result.current.notify("plain");
      result.current.notify("with action", { action: { label: "Do it", run: () => {} } });
    });
    act(() => {
      vi.advanceTimersByTime(4600);
    });
    expect(shown(result.current.toasts)).toEqual(["with action"]);
    act(() => {
      vi.advanceTimersByTime(ACTION_TOAST_MS + TOAST_EXIT_MS);
    });
    expect(result.current.toasts).toEqual([]);
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

describe("toast rendering", () => {
  it("has a close button that dismisses", () => {
    const onDismiss = vi.fn();
    const { getByLabelText } = render(<Toasts toasts={[{ id: 2, message: "Saved", kind: "info", count: 1 }]} onDismiss={onDismiss} />);
    fireEvent.click(getByLabelText("Dismiss"));
    expect(onDismiss).toHaveBeenCalledWith(2);
  });

  it("draws the kind as the shared notice tone, and an error as an alert", () => {
    const { container } = render(
      <Toasts
        toasts={[
          { id: 4, message: "Added", kind: "success", count: 1 },
          { id: 5, message: "Couldn't save", kind: "error", count: 1 },
        ]}
        onDismiss={() => {}}
      />,
    );
    const [ok, bad] = Array.from(container.querySelectorAll(".toast"));
    expect(ok.className).toContain("notice-tone--success");
    expect(ok.getAttribute("role")).toBeNull();
    expect(bad.className).toContain("notice-tone--error");
    expect(bad.getAttribute("role")).toBe("alert");
  });

  it("shows a repeat count only past one", () => {
    const { container, rerender } = render(<Toasts toasts={[{ id: 3, message: "Saved", kind: "info", count: 1 }]} onDismiss={() => {}} />);
    expect(container.querySelector(".toast-count")).toBeNull();
    rerender(<Toasts toasts={[{ id: 3, message: "Saved", kind: "info", count: 3 }]} onDismiss={() => {}} />);
    expect(container.querySelector(".toast-count")?.textContent).toBe("×3");
  });
});

describe("toast noise control", () => {
  it("bumps a repeated message instead of stacking a copy, and restarts its timer", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useToasts(4500));
    act(() => result.current.notify("No video found"));
    act(() => vi.advanceTimersByTime(4000));
    act(() => result.current.notify("No video found"));
    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0].count).toBe(2);
    // The original deadline (4500) has passed; the repeat pushed it out.
    act(() => vi.advanceTimersByTime(1000));
    expect(shown(result.current.toasts)).toEqual(["No video found"]);
    act(() => vi.advanceTimersByTime(4000 + TOAST_EXIT_MS));
    expect(result.current.toasts).toEqual([]);
  });

  it("does not merge the same text when the buttons differ", () => {
    const { result } = renderHook(() => useToasts());
    act(() => {
      result.current.notify("slskd isn't running.");
      result.current.notify("slskd isn't running.", { action: { label: "Start slskd", run: () => {} } });
    });
    expect(result.current.toasts).toHaveLength(2);
  });

  it(`shows at most ${MAX_VISIBLE_TOASTS}, the oldest leaving first`, () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useToasts());
    act(() => {
      for (const m of ["a", "b", "c", "d", "e"]) result.current.notify(m);
    });
    expect(shown(result.current.toasts)).toEqual(["c", "d", "e"]);
    act(() => vi.advanceTimersByTime(TOAST_EXIT_MS));
    expect(result.current.toasts.map((t) => t.message)).toEqual(["c", "d", "e"]);
  });

  it("keeps an error up until it is closed", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useToasts(4500));
    act(() => result.current.notify("Couldn't save", { kind: "error" }));
    act(() => vi.advanceTimersByTime(ACTION_TOAST_MS * 10));
    expect(shown(result.current.toasts)).toEqual(["Couldn't save"]);
    act(() => result.current.dismiss(result.current.toasts[0].id));
    act(() => vi.advanceTimersByTime(TOAST_EXIT_MS));
    expect(result.current.toasts).toEqual([]);
  });

  it("pushes out an older plain toast before an error, and always shows the new one", () => {
    const { result } = renderHook(() => useToasts());
    act(() => {
      result.current.notify("e1", { kind: "error" });
      result.current.notify("info");
      result.current.notify("e2", { kind: "error" });
      result.current.notify("new");
    });
    expect(shown(result.current.toasts)).toEqual(["e1", "e2", "new"]);
    act(() => {
      result.current.notify("e3", { kind: "error" });
      result.current.notify("newer");
    });
    // Only errors and the newest are left to choose from: the oldest error goes.
    expect(shown(result.current.toasts)).toEqual(["e2", "e3", "newer"]);
  });

  it("does not merge the same text across kinds", () => {
    const { result } = renderHook(() => useToasts());
    act(() => {
      result.current.notify("Same words");
      result.current.notify("Same words", { kind: "error" });
    });
    expect(result.current.toasts.map((t) => t.kind)).toEqual(["info", "error"]);
  });

  it("dismiss plays the exit, then removes", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useToasts());
    act(() => result.current.notify("bye"));
    const id = result.current.toasts[0].id;
    act(() => result.current.dismiss(id));
    expect(result.current.toasts[0].leaving).toBe(true);
    act(() => vi.advanceTimersByTime(TOAST_EXIT_MS));
    expect(result.current.toasts).toEqual([]);
  });
});
