import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { AssistantActivityPill } from "../components/AssistantActivityPill";
import type { AssistantActivityState } from "../hooks/useAssistantActivity";
import type { ActivityEntry } from "../utils/assistantActivity";

afterEach(cleanup);

function entry(over: Partial<ActivityEntry>): ActivityEntry {
  return {
    id: 1,
    startedMs: Date.now(),
    label: "Edit tags",
    kind: "write",
    method: "POST",
    route: "/v1/tracks/{id}/tags",
    status: "running",
    ...over,
  };
}

function state(over: Partial<AssistantActivityState> = {}): AssistantActivityState {
  return {
    entries: [],
    paused: false,
    setPaused: vi.fn().mockResolvedValue(undefined),
    dismissedBefore: 0,
    dismissFailures: vi.fn(),
    clear: vi.fn(),
    ...over,
  };
}

function pill(activity: AssistantActivityState, over: { enabled?: boolean; hidden?: boolean; onOpenLog?: () => void } = {}) {
  return render(
    <AssistantActivityPill
      activity={activity}
      enabled={over.enabled ?? true}
      hidden={over.hidden ?? false}
      onOpenLog={over.onOpenLog ?? (() => {})}
    />,
  );
}

describe("AssistantActivityPill", () => {
  it("renders nothing when idle, when the API is off, or when hidden", () => {
    expect(pill(state()).container.innerHTML).toBe("");
    cleanup();
    expect(pill(state({ entries: [entry({})] }), { enabled: false }).container.innerHTML).toBe("");
    cleanup();
    expect(pill(state({ entries: [entry({})] }), { hidden: true }).container.innerHTML).toBe("");
  });

  it("names the running call and pauses from the pill", () => {
    const activity = state({ entries: [entry({})] });
    pill(activity);
    expect(screen.getByText("Assistant · Edit tags")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(activity.setPaused).toHaveBeenCalledWith(true);
  });

  it("says what the call touched, in the pill and in the list", () => {
    const activity = state({
      entries: [entry({ label: "Add to the queue", detail: "“So What” – Miles Davis +2 more (next)", result: "added 2, skipped 1 duplicate", status: "ok", startedMs: Date.now() - 500 })],
    });
    pill(activity);
    expect(screen.getByText("Assistant · Add to the queue: “So What” – Miles Davis +2 more (next)")).toBeTruthy();
    fireEvent.click(screen.getByTitle("Show what the assistant did"));
    const dialog = screen.getByRole("dialog", { name: "Assistant activity" });
    expect(dialog.textContent).toContain("“So What” – Miles Davis +2 more (next)");
    expect(dialog.textContent).toContain("added 2, skipped 1 duplicate");
  });

  it("stays up while paused, even with nothing running, and resumes from the pill", () => {
    const activity = state({ paused: true });
    pill(activity);
    expect(screen.getByText("Assistant paused")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(activity.setPaused).toHaveBeenCalledWith(false);
  });

  it("does not show a standing paused pill when the control API is off", () => {
    expect(pill(state({ paused: true }), { enabled: false }).container.innerHTML).toBe("");
  });

  it("keeps a failure up until dismissed", () => {
    const activity = state({ entries: [entry({ status: "failed", error: "track not found", startedMs: 0 })] });
    pill(activity);
    expect(screen.getByText("Assistant · Edit tags failed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(activity.dismissFailures).toHaveBeenCalled();
  });

  it("opens a list with the error, an outward note, and a route to the full log", () => {
    const onOpenLog = vi.fn();
    const activity = state({
      entries: [
        entry({ id: 2, label: "Run a plugin tool · spotify: push_playlist", kind: "outward", status: "ok", startedMs: Date.now() - 1000 }),
        entry({ id: 1, status: "failed", error: "track not found", startedMs: Date.now() - 2000 }),
      ],
    });
    pill(activity, { onOpenLog });
    fireEvent.click(screen.getByTitle("Show what the assistant did"));
    const dialog = screen.getByRole("dialog", { name: "Assistant activity" });
    expect(dialog.textContent).toContain("spotify: push_playlist");
    expect(dialog.textContent).toContain("May leave this machine");
    expect(dialog.textContent).toContain("track not found");
    fireEvent.click(screen.getByRole("button", { name: "Open full log" }));
    expect(onOpenLog).toHaveBeenCalled();
    // Opening the log closes the list.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("pauses from the list footer", () => {
    const activity = state({ entries: [entry({})] });
    pill(activity);
    fireEvent.click(screen.getByTitle("Show what the assistant did"));
    fireEvent.click(screen.getByRole("button", { name: "Pause assistant" }));
    expect(activity.setPaused).toHaveBeenCalledWith(true);
  });

  it("closes the list on Escape", () => {
    pill(state({ entries: [entry({})] }));
    fireEvent.click(screen.getByTitle("Show what the assistant did"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
