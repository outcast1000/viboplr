import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

// A library change made while Home is hidden lives only in App's in-memory
// `libraryRevision`; quit before Home is shown and it's gone. The store's
// `homeLibraryChangedAt` carries it across the restart: newer than the
// snapshot's `libraryAsOf` → Home refreshes at launch even inside the 24h window.

const storeValues: Record<string, unknown> = {};
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("../store", () => ({
  store: {
    get: vi.fn(async (key: string) => storeValues[key]),
    set: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  },
}));
const snapshotFile: { current: unknown } = { current: null };
const writeHomeSnapshot = vi.fn(async () => {});
vi.mock("../utils/homeSnapshotFile", () => ({
  readHomeSnapshot: vi.fn(async () => snapshotFile.current),
  writeHomeSnapshot: (...args: unknown[]) => writeHomeSnapshot(...(args as [])),
}));

import { useHome, DEFAULT_SHELF_ORDER } from "../hooks/useHome";

function renderHome() {
  return renderHook(() => useHome({
    isVisible: true,
    pluginShelves: [],
    invokePluginShelf: async () => ({ status: "empty" }),
    pluginsLoaded: true,
    activePluginIds: new Set(),
    visibility: {},
    shelfOrder: DEFAULT_SHELF_ORDER,
    restoredRef: { current: true },
    libraryRevision: 0,
    recentPlays: [],
  }));
}

const HOUR = 60 * 60 * 1000;

describe("Home refresh after a library change from a previous session", () => {
  beforeEach(() => {
    for (const k of Object.keys(storeValues)) delete storeValues[k];
    writeHomeSnapshot.mockClear();
  });

  it("refreshes a fresh snapshot when the library changed after it was read", async () => {
    const asOf = Date.now() - HOUR;
    snapshotFile.current = { radioStations: [], shelves: [], savedAt: asOf + 1000, libraryAsOf: asOf, attemptedKeys: DEFAULT_SHELF_ORDER };
    storeValues.homeLibraryChangedAt = asOf + 60_000;
    const { result } = renderHome();
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    await waitFor(() => expect(writeHomeSnapshot).toHaveBeenCalled());
    const written = (writeHomeSnapshot.mock.calls.at(-1) as unknown[])[0] as { libraryAsOf: number };
    expect(written.libraryAsOf).toBeGreaterThan(storeValues.homeLibraryChangedAt as number);
  });

  it("falls back to savedAt for a snapshot written before libraryAsOf existed", async () => {
    const savedAt = Date.now() - HOUR;
    snapshotFile.current = { radioStations: [], shelves: [], savedAt, attemptedKeys: DEFAULT_SHELF_ORDER };
    storeValues.homeLibraryChangedAt = savedAt + 60_000;
    const { result } = renderHome();
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    await waitFor(() => expect(writeHomeSnapshot).toHaveBeenCalled());
  });

  it("keeps a fresh snapshot when nothing changed since it was read", async () => {
    const asOf = Date.now() - HOUR;
    snapshotFile.current = { radioStations: [], shelves: [], savedAt: asOf + 1000, libraryAsOf: asOf, attemptedKeys: DEFAULT_SHELF_ORDER };
    storeValues.homeLibraryChangedAt = asOf - 60_000;
    const { result } = renderHome();
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(writeHomeSnapshot).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
  });
});
