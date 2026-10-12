import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";
import type { ActivityEvent } from "../utils/assistantActivity";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

// Capture the handlers the hook subscribes with so a test can fire events.
const handlers = new Map<string, (e: { payload: unknown }) => void>();
vi.mock("../utils/tauriEvents", () => ({
  subscribe: (event: string, handler: (e: { payload: unknown }) => void) => {
    handlers.set(event, handler);
    return () => handlers.delete(event);
  },
  safeUnlisten: () => {},
  combineUnlisten:
    (...stops: Array<() => void>) =>
    () =>
      stops.forEach((s) => s()),
}));

import { invoke } from "@tauri-apps/api/core";
import { useAssistantActivity } from "../hooks/useAssistantActivity";

afterEach(() => {
  cleanup();
  handlers.clear();
  vi.resetAllMocks();
});

function fire(event: string, payload: unknown) {
  act(() => handlers.get(event)?.({ payload }));
}

function ev(over: Partial<ActivityEvent>): ActivityEvent {
  return { id: 1, phase: "start", atMs: 1_000, method: "POST", route: "/v1/likes", label: "Change a like", kind: "write", ...over };
}

describe("useAssistantActivity", () => {
  it("reads the pause state from the backend on mount", async () => {
    vi.mocked(invoke).mockResolvedValue(true);
    const { result } = renderHook(() => useAssistantActivity(vi.fn()));
    await waitFor(() => expect(result.current.paused).toBe(true));
    expect(invoke).toHaveBeenCalledWith("assistant_pause_get");
  });

  it("folds activity events into the log and follows the pause event", async () => {
    vi.mocked(invoke).mockResolvedValue(false);
    const { result } = renderHook(() => useAssistantActivity(vi.fn()));
    await waitFor(() => expect(handlers.has("assistant-activity")).toBe(true));

    fire("assistant-activity", ev({ phase: "start" }));
    expect(result.current.entries[0].status).toBe("running");
    fire("assistant-activity", ev({ phase: "end", outcome: "failed", error: "boom" }));
    expect(result.current.entries[0]).toMatchObject({ status: "failed", error: "boom" });

    fire("assistant-paused-changed", true);
    expect(result.current.paused).toBe(true);
  });

  it("pauses through the backend and only then reflects it", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => (cmd === "assistant_pause_get" ? false : true));
    const { result } = renderHook(() => useAssistantActivity(vi.fn()));
    await act(async () => {
      await result.current.setPaused(true);
    });
    expect(invoke).toHaveBeenCalledWith("assistant_pause_set", { paused: true });
    expect(result.current.paused).toBe(true);
  });

  it("tells the user and stays unpaused when the backend refuses", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "assistant_pause_get") return false;
      throw new Error("disk full");
    });
    const notify = vi.fn();
    const { result } = renderHook(() => useAssistantActivity(notify));
    await act(async () => {
      await result.current.setPaused(true);
    });
    expect(result.current.paused).toBe(false);
    expect(notify).toHaveBeenCalledWith("Couldn't pause the assistant.", { kind: "error" });
  });

  it("turns a failed change into an error notification that leads to the log", async () => {
    vi.mocked(invoke).mockResolvedValue(false);
    const notify = vi.fn();
    const onOpenLog = vi.fn();
    const { result } = renderHook(() => useAssistantActivity(notify, onOpenLog));
    await waitFor(() => expect(handlers.has("assistant-activity")).toBe(true));

    // Reads, successes and refusals are not notifications.
    fire("assistant-activity", ev({ id: 1, phase: "end", outcome: "failed", kind: "read" }));
    fire("assistant-activity", ev({ id: 2, phase: "end", outcome: "ok" }));
    fire("assistant-activity", ev({ id: 3, phase: "end", outcome: "paused" }));
    expect(notify).not.toHaveBeenCalled();

    fire("assistant-activity", ev({ id: 6, phase: "end", outcome: "failed", label: "Edit tags", detail: "3 tracks", error: "read-only file" }));
    expect(notify).toHaveBeenCalledTimes(1);
    const [message, options] = notify.mock.calls[0];
    expect(message).toBe("Edit tags (3 tracks) failed: read-only file");
    expect(options).toMatchObject({ kind: "error", source: "Assistant", action: { label: "Open AI control" } });
    act(() => options.action.run());
    expect(onOpenLog).toHaveBeenCalled();
    expect(result.current.dismissedBefore).toBe(6);
  });

  it("dismissing failures covers what is there, not what comes later", async () => {
    vi.mocked(invoke).mockResolvedValue(false);
    const { result } = renderHook(() => useAssistantActivity(vi.fn()));
    await waitFor(() => expect(handlers.has("assistant-activity")).toBe(true));
    fire("assistant-activity", ev({ id: 4, phase: "end", outcome: "failed" }));
    act(() => result.current.dismissFailures());
    expect(result.current.dismissedBefore).toBe(4);
    fire("assistant-activity", ev({ id: 5, phase: "end", outcome: "failed" }));
    expect(result.current.dismissedBefore).toBe(4);
  });
});
