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
  it("defaults to worn-tape before any load", () => {
    expect(getHeroEffectModeSnapshot()).toBe("worn-tape");
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
    setHeroEffectMode("signal-lost");
    expect(cb).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("does not notify or persist when set to the current value", () => {
    const cb = vi.fn();
    const unsub = subscribeHeroEffectMode(cb);
    cb.mockClear();
    setHeroEffectMode("worn-tape"); // already default
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

  it("migrates a legacy boolean true to worn-tape and persists it", async () => {
    getMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce(true);
    await loadHeroEffectModeForTest();
    expect(getHeroEffectModeSnapshot()).toBe("worn-tape");
    expect(setMock).toHaveBeenCalledWith("heroEffectMode", "worn-tape");
  });

  it("migrates a legacy boolean false to disabled and persists it", async () => {
    getMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce(false);
    await loadHeroEffectModeForTest();
    expect(getHeroEffectModeSnapshot()).toBe("disabled");
    expect(setMock).toHaveBeenCalledWith("heroEffectMode", "disabled");
  });

  it("keeps default when nothing is stored", async () => {
    getMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
    await loadHeroEffectModeForTest();
    expect(getHeroEffectModeSnapshot()).toBe("worn-tape");
  });

  it("does not persist the default on a fresh install (no stored, no legacy)", async () => {
    getMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
    await loadHeroEffectModeForTest();
    expect(setMock).not.toHaveBeenCalled();
  });
});
