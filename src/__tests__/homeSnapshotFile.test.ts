import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../store", () => ({ store: { get: vi.fn(), delete: vi.fn() } }));

import {
  readHomeSnapshot, writeHomeSnapshot, homeSnapshotBackgroundWork,
  LEGACY_SNAPSHOT_KEY, type HomeSnapshotDeps,
} from "../utils/homeSnapshotFile";

const bytes = (v: unknown) => new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v)).buffer;

function makeDeps(opts: { file?: unknown; rawFile?: string; legacy?: unknown; readFails?: boolean; writeFails?: boolean } = {}) {
  // The backend hands back raw bytes; an empty buffer means "no file".
  let file: ArrayBuffer = opts.rawFile !== undefined ? bytes(opts.rawFile) : opts.file !== undefined ? bytes(opts.file) : new ArrayBuffer(0);
  const writes: unknown[] = [];
  const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "home_snapshot_read") {
      if (opts.readFails) throw new Error("read home snapshot: permission denied");
      return file;
    }
    if (cmd === "home_snapshot_write") {
      if (opts.writeFails) throw new Error("disk full");
      writes.push(args?.snapshot);
      file = bytes(args?.snapshot);
      return null;
    }
    throw new Error(`unexpected ${cmd}`);
  });
  const get = vi.fn(async (key: string) => (key === LEGACY_SNAPSHOT_KEY ? opts.legacy : undefined));
  const del = vi.fn(async () => true);
  const deps = { invoke, store: { get, delete: del } } as unknown as HomeSnapshotDeps;
  return { deps, invoke, get, del, writes };
}

describe("home snapshot file", () => {
  it("prefers the file and leaves the store alone when no legacy key is left", async () => {
    const { deps, del } = makeDeps({ file: { savedAt: 2 } });
    expect(await readHomeSnapshot(deps)).toEqual({ savedAt: 2 });
    await homeSnapshotBackgroundWork();
    expect(del).not.toHaveBeenCalled();
  });

  it("reads the file and the legacy key in parallel", async () => {
    let releaseFile!: () => void;
    const fileGate = new Promise<void>((r) => { releaseFile = r; });
    const { deps, get } = makeDeps({ file: { savedAt: 2 } });
    const realInvoke = deps.invoke;
    deps.invoke = (async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "home_snapshot_read") await fileGate;
      return realInvoke(cmd, args);
    }) as HomeSnapshotDeps["invoke"];
    const p = readHomeSnapshot(deps);
    await Promise.resolve();
    expect(get).toHaveBeenCalledWith(LEGACY_SNAPSHOT_KEY); // asked before the file answered
    releaseFile();
    expect(await p).toEqual({ savedAt: 2 });
  });

  it("drops a legacy key still sitting next to the file, without rewriting the file", async () => {
    const { deps, del, writes } = makeDeps({ file: { savedAt: 2 }, legacy: { savedAt: 1 } });
    expect(await readHomeSnapshot(deps)).toEqual({ savedAt: 2 });
    await homeSnapshotBackgroundWork();
    expect(del).toHaveBeenCalledWith(LEGACY_SNAPSHOT_KEY);
    expect(writes).toEqual([]);
  });

  it("on a read error, shows the legacy copy but never writes it over the file", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps, del, writes } = makeDeps({ legacy: { savedAt: 1 }, readFails: true });
    expect(await readHomeSnapshot(deps)).toEqual({ savedAt: 1 });
    await homeSnapshotBackgroundWork();
    expect(writes).toEqual([]);
    expect(del).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it("migrates the legacy key in the background, then drops it", async () => {
    const { deps, del, writes } = makeDeps({ legacy: { savedAt: 1, shelves: [] } });
    expect(await readHomeSnapshot(deps)).toEqual({ savedAt: 1, shelves: [] });
    await homeSnapshotBackgroundWork();
    expect(writes).toEqual([{ savedAt: 1, shelves: [] }]);
    expect(del).toHaveBeenCalledWith(LEGACY_SNAPSHOT_KEY);
  });

  it("an unparseable file counts as missing, so the legacy copy replaces it", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps, writes } = makeDeps({ rawFile: "{not json", legacy: { savedAt: 1 } });
    expect(await readHomeSnapshot(deps)).toEqual({ savedAt: 1 });
    await homeSnapshotBackgroundWork();
    expect(writes).toEqual([{ savedAt: 1 }]);
    err.mockRestore();
  });

  it("keeps the legacy key when the migration write fails, so the next launch retries", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps, del } = makeDeps({ legacy: { savedAt: 1 }, writeFails: true });
    expect(await readHomeSnapshot(deps)).toEqual({ savedAt: 1 });
    await homeSnapshotBackgroundWork();
    expect(del).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it("returns null when there is neither (and the e2e mock's null reads as missing)", async () => {
    const { deps } = makeDeps();
    expect(await readHomeSnapshot(deps)).toBeNull();
    const nullDeps = { invoke: vi.fn(async () => null), store: { get: vi.fn(async () => undefined), delete: vi.fn() } } as unknown as HomeSnapshotDeps;
    expect(await readHomeSnapshot(nullDeps)).toBeNull();
  });

  it("serializes writes and survives a failed one", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let n = 0;
    const invoke = vi.fn(async (_cmd: string, args?: Record<string, unknown>) => {
      const id = (args?.snapshot as { id: string }).id;
      n += 1;
      if (n === 1) { await gate; throw new Error("first fails"); }
      order.push(id);
      return null;
    });
    const deps = { invoke, store: { get: vi.fn(), delete: vi.fn() } } as unknown as HomeSnapshotDeps;
    const a = writeHomeSnapshot({ id: "a" }, deps);
    const b = writeHomeSnapshot({ id: "b" }, deps);
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledTimes(1); // b waits for a
    release();
    await expect(a).rejects.toThrow("first fails");
    await b;
    expect(order).toEqual(["b"]);
    // The chain itself stays quiet: the caller of `a` is the one that logs.
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });
});
