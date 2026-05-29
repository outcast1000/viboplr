import { describe, it, expect, beforeEach, vi } from "vitest";

const getMock = vi.fn();
const setMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../store", () => ({
  store: {
    get: (...args: unknown[]) => getMock(...args),
    set: (...args: unknown[]) => setMock(...args),
    init: vi.fn().mockResolvedValue(undefined),
  },
}));

import {
  getHeroEffectModeSnapshot,
  setHeroEffectMode,
  subscribeHeroEffectMode,
  loadHeroEffectModeForTest,
  __resetHeroEffectModeForTest,
} from "../heroEffectMode";

beforeEach(() => {
  getMock.mockReset();
  setMock.mockReset();
  setMock.mockResolvedValue(undefined);
  __resetHeroEffectModeForTest();
});

describe("heroEffectMode store", () => {
  it("defaults to by-artist before any load", () => {
    expect(getHeroEffectModeSnapshot()).toBe("by-artist");
  });

  it("setHeroEffectMode updates the snapshot and persists the string", () => {
    setHeroEffectMode("daydream");
    expect(getHeroEffectModeSnapshot()).toBe("daydream");
    expect(setMock).toHaveBeenCalledWith("heroEffectMode", "daydream");
  });

  it("notifies subscribers when the value changes", () => {
    const cb = vi.fn();
    const unsub = subscribeHeroEffectMode(cb);
    cb.mockClear();
    setHeroEffectMode("daydream");
    expect(cb).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("does not notify or persist when set to the current value", () => {
    const cb = vi.fn();
    const unsub = subscribeHeroEffectMode(cb);
    cb.mockClear();
    setHeroEffectMode("by-artist"); // already default
    expect(cb).not.toHaveBeenCalled();
    expect(setMock).not.toHaveBeenCalled();
    unsub();
  });

  it("loads a stored mode string and notifies", async () => {
    getMock.mockResolvedValueOnce("late-night").mockResolvedValueOnce(undefined);
    const cb = vi.fn();
    subscribeHeroEffectMode(cb);
    await loadHeroEffectModeForTest();
    expect(getHeroEffectModeSnapshot()).toBe("late-night");
    expect(cb).toHaveBeenCalled();
  });

  it("falls back to default when a removed look id is stored", async () => {
    // A user who had `worn-tape` saved before it was removed. The stored value
    // fails isValidMode, no legacy boolean is present -> default by-artist.
    getMock.mockResolvedValueOnce("worn-tape").mockResolvedValueOnce(undefined);
    await loadHeroEffectModeForTest();
    expect(getHeroEffectModeSnapshot()).toBe("by-artist");
  });

  it("migrates a legacy boolean true to by-artist and persists it", async () => {
    getMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce(true);
    await loadHeroEffectModeForTest();
    expect(getHeroEffectModeSnapshot()).toBe("by-artist");
    expect(setMock).toHaveBeenCalledWith("heroEffectMode", "by-artist");
  });

  it("migrates a legacy boolean false to disabled and persists it", async () => {
    getMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce(false);
    await loadHeroEffectModeForTest();
    expect(getHeroEffectModeSnapshot()).toBe("disabled");
    expect(setMock).toHaveBeenCalledWith("heroEffectMode", "disabled");
  });

  it("keeps default (by-artist) when nothing is stored", async () => {
    getMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
    await loadHeroEffectModeForTest();
    expect(getHeroEffectModeSnapshot()).toBe("by-artist");
  });

  it("does not persist the default on a fresh install (no stored, no legacy)", async () => {
    getMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
    await loadHeroEffectModeForTest();
    expect(setMock).not.toHaveBeenCalled();
  });
});
