import { afterEach, describe, it, expect, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook } from "@testing-library/react";
import { ACTION_TOAST_MS, useToasts } from "../hooks/useToasts";
import { Toasts } from "../components/Toasts";

// A toast may carry one action ("Start slskd"), which plugins reach through
// `api.ui.showNotification(message, { action })`. The button must do its
// thing, the message must still just dismiss, and a toast with a button must
// stay up long enough to reach it.
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("toasts with an action", () => {
  it("runs the action and dismisses; the message alone only dismisses", () => {
    const run = vi.fn();
    const onDismiss = vi.fn();
    const { getByText } = render(
      <Toasts toasts={[{ id: 1, message: "slskd isn't running.", action: { label: "Start slskd", run } }]} onDismiss={onDismiss} />,
    );
    fireEvent.click(getByText("slskd isn't running."));
    expect(onDismiss).toHaveBeenCalledWith(1);
    expect(run).not.toHaveBeenCalled();
    fireEvent.click(getByText("Start slskd"));
    expect(run).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it("a plain toast is still one button", () => {
    const { container } = render(<Toasts toasts={[{ id: 2, message: "Saved" }]} onDismiss={() => {}} />);
    expect(container.querySelectorAll("button").length).toBe(1);
  });

  it("stays up longer than a plain toast", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useToasts(4500));
    act(() => {
      result.current.notify("plain");
      result.current.notify("with action", { label: "Do it", run: () => {} });
    });
    act(() => {
      vi.advanceTimersByTime(4600);
    });
    expect(result.current.toasts.map((t) => t.message)).toEqual(["with action"]);
    act(() => {
      vi.advanceTimersByTime(ACTION_TOAST_MS);
    });
    expect(result.current.toasts).toEqual([]);
  });
});
