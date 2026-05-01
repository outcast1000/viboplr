import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeHoverController } from "../hooks/useMiniMode";

describe("makeHoverController", () => {
  let onExpand: () => void;
  let onCollapse: () => void;
  let expanded: boolean;

  const make = () =>
    makeHoverController({
      expandDelayMs: 500,
      collapseDelayMs: 300,
      onExpand,
      onCollapse,
      isExpanded: () => expanded,
    });

  beforeEach(() => {
    vi.useFakeTimers();
    onExpand = vi.fn(() => { expanded = true; });
    onCollapse = vi.fn(() => { expanded = false; });
    expanded = false;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("expands after 500ms of hover", () => {
    const c = make();
    c.handleEnter();
    vi.advanceTimersByTime(499);
    expect(onExpand).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  it("does not expand if mouse leaves before 500ms", () => {
    const c = make();
    c.handleEnter();
    vi.advanceTimersByTime(400);
    c.handleLeave();
    vi.advanceTimersByTime(1000);
    expect(onExpand).not.toHaveBeenCalled();
    expect(onCollapse).not.toHaveBeenCalled();
  });

  it("collapses 300ms after mouse leaves while expanded", () => {
    const c = make();
    c.handleEnter();
    vi.advanceTimersByTime(500);
    c.handleLeave();
    vi.advanceTimersByTime(299);
    expect(onCollapse).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onCollapse).toHaveBeenCalledTimes(1);
  });

  it("cancels pending collapse if mouse re-enters within 300ms", () => {
    const c = make();
    c.handleEnter();
    vi.advanceTimersByTime(500);
    c.handleLeave();
    vi.advanceTimersByTime(200);
    c.handleEnter();
    vi.advanceTimersByTime(1000);
    expect(onCollapse).not.toHaveBeenCalled();
  });

  it("re-entering while already expanded does not schedule a second expand", () => {
    const c = make();
    c.handleEnter();
    vi.advanceTimersByTime(500);
    expect(onExpand).toHaveBeenCalledTimes(1);
    c.handleEnter();
    vi.advanceTimersByTime(1000);
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  it("leaving while already collapsed does not schedule a collapse", () => {
    const c = make();
    c.handleLeave();
    vi.advanceTimersByTime(1000);
    expect(onCollapse).not.toHaveBeenCalled();
  });

  it("rapid enter/leave/enter within expand delay eventually expands", () => {
    const c = make();
    c.handleEnter();
    vi.advanceTimersByTime(100);
    c.handleLeave();
    vi.advanceTimersByTime(50);
    c.handleEnter();
    vi.advanceTimersByTime(499);
    expect(onExpand).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  it("cancel() clears both pending timers", () => {
    const c = make();
    c.handleEnter();
    c.cancel();
    vi.advanceTimersByTime(1000);
    expect(onExpand).not.toHaveBeenCalled();

    c.handleEnter();
    vi.advanceTimersByTime(500);
    c.handleLeave();
    c.cancel();
    vi.advanceTimersByTime(1000);
    expect(onCollapse).not.toHaveBeenCalled();
  });
});
