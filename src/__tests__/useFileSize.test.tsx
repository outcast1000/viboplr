import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

let mod: typeof import("../hooks/useFileSize");

beforeEach(async () => {
  invoke.mockReset();
  vi.resetModules(); // fresh per-session cache
  mod = await import("../hooks/useFileSize");
});

/** An invoke answer the test releases by hand. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("useFileSize", () => {
  it("looks the size up once the row is visible", async () => {
    invoke.mockResolvedValue(98765);
    const { result, rerender } = renderHook(({ on }) => mod.useFileSize("file:///m/v.mp4", on), {
      initialProps: { on: false },
    });
    expect(invoke).not.toHaveBeenCalled();
    rerender({ on: true });
    await waitFor(() => expect(result.current).toBe(98765));
    expect(invoke).toHaveBeenCalledWith("queue_entry_file_size", { path: "file:///m/v.mp4" });
  });

  it("asks for a non-local entry too (Subsonic sizes come from the library)", async () => {
    invoke.mockResolvedValue(4_000_000);
    const { result } = renderHook(() => mod.useFileSize("subsonic://srv/123", true));
    await waitFor(() => expect(result.current).toBe(4_000_000));
  });

  it("asks once per path however many rows show it", async () => {
    invoke.mockResolvedValue(5);
    const a = renderHook(() => mod.useFileSize("file:///m/x.flac", true));
    const b = renderHook(() => mod.useFileSize("file:///m/x.flac", true));
    await waitFor(() => expect(a.result.current).toBe(5));
    await waitFor(() => expect(b.result.current).toBe(5));
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("a row on screen shows the new size after a forget", async () => {
    invoke.mockResolvedValueOnce(5).mockResolvedValueOnce(9);
    const { result } = renderHook(() => mod.useFileSize("file:///m/y.flac", true));
    await waitFor(() => expect(result.current).toBe(5));
    act(() => mod.forgetFileSizes(["file:///m/y.flac"]));
    await waitFor(() => expect(result.current).toBe(9));
  });

  it("forgetting one path leaves another path's lookup in flight alone", async () => {
    const slow = deferred<number>();
    invoke.mockImplementation((_cmd: string, { path }: { path: string }) =>
      path === "file:///m/b.flac" ? slow.promise : Promise.resolve(1));
    const b = renderHook(() => mod.useFileSize("file:///m/b.flac", true));
    act(() => mod.forgetFileSizes(["file:///m/a.flac"]));
    await act(async () => slow.resolve(42));
    await waitFor(() => expect(b.result.current).toBe(42));
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("a lookup forgotten mid-flight asks again instead of being dropped", async () => {
    const first = deferred<number>();
    invoke.mockReturnValueOnce(first.promise).mockResolvedValueOnce(77);
    const { result } = renderHook(() => mod.useFileSize("file:///m/c.flac", true));
    act(() => mod.forgetFileSizes());
    await act(async () => first.resolve(11)); // the old file's answer
    await waitFor(() => expect(result.current).toBe(77));
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("asks nothing for a path-less entry, and reports a failure as unknown", async () => {
    renderHook(() => mod.useFileSize(null, true));
    expect(invoke).not.toHaveBeenCalled();
    invoke.mockRejectedValue(new Error("boom"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result } = renderHook(() => mod.useFileSize("file:///m/z.flac", true));
    await waitFor(() => expect(err).toHaveBeenCalled());
    expect(result.current).toBeNull();
    err.mockRestore();
  });
});
