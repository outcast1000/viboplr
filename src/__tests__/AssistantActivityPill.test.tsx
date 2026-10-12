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

  it("counts the session and pauses in one click", () => {
    const activity = state({ entries: [entry({ id: 2 }), entry({ id: 1, status: "ok", startedMs: Date.now() - 300, durationMs: 50 })] });
    pill(activity);
    expect(screen.getByText("Assistant working · 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pause assistant" }));
    expect(activity.setPaused).toHaveBeenCalledWith(true);
  });

  it("keeps Pause after the session ends, with the change count", () => {
    const activity = state({ entries: [entry({ status: "ok", startedMs: Date.now() - 10_000, durationMs: 100 })] });
    pill(activity);
    expect(screen.getByText("Assistant · 1 change")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pause assistant" })).toBeTruthy();
  });

  it("opens Settings → AI control from its label — there is no popover", () => {
    const onOpenLog = vi.fn();
    pill(state({ entries: [entry({})] }), { onOpenLog });
    fireEvent.click(screen.getByTitle("Open Settings → AI control"));
    expect(onOpenLog).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("stays up while paused, even with nothing running, and resumes from the same button", () => {
    const activity = state({ paused: true });
    pill(activity);
    expect(screen.getByText("Assistant paused")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Resume assistant" }));
    expect(activity.setPaused).toHaveBeenCalledWith(false);
  });

  it("does not show a standing paused segment when the control API is off", () => {
    expect(pill(state({ paused: true }), { enabled: false }).container.innerHTML).toBe("");
  });

  it("stays up after a failure until the log has been looked at", () => {
    const failed = [entry({ id: 4, status: "failed", error: "track not found", startedMs: 0 })];
    pill(state({ entries: failed }));
    expect(screen.getByText("Assistant · a call failed")).toBeTruthy();
    cleanup();
    expect(pill(state({ entries: failed, dismissedBefore: 4 })).container.innerHTML).toBe("");
  });
});
