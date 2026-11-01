import { describe, it, expect, vi } from "vitest";
import { TrackLikeStore } from "../utils/trackLikeStore";
import { trackLikeKey } from "../likeKeys";

const JOGA = trackLikeKey("Jóga", "Björk");
const CREEP = trackLikeKey("Creep", "Radiohead");

describe("TrackLikeStore", () => {
  it("answers each caller's fallback until the first load lands", async () => {
    const store = new TrackLikeStore();
    expect(store.isLoaded()).toBe(false);
    expect(store.lookupKey(JOGA, 1)).toBe(1);
    expect(store.lookupKey(JOGA, 0)).toBe(0);
    expect(store.lookupKey(JOGA)).toBe(0);

    await store.load(async () => [{ key: JOGA, liked: -1 }]);
    expect(store.isLoaded()).toBe(true);
    // Loaded: the store wins over whatever the copy says.
    expect(store.lookupKey(JOGA, 1)).toBe(-1);
    expect(store.lookupKey(CREEP, 1)).toBe(0);
  });

  it("looks a song up by its metadata with the backend's fold", async () => {
    const store = new TrackLikeStore();
    await store.load(async () => [{ key: "track:bjork:joga", liked: 1 }]);
    expect(store.lookup(" JOGA ", "Bjork")).toBe(1);
    expect(store.lookup("Jóga", "Björk")).toBe(1);
  });

  it("set records a state, and 0 clears it", async () => {
    const store = new TrackLikeStore();
    await store.load(async () => []);
    store.set(JOGA, 1);
    expect(store.lookupKey(JOGA)).toBe(1);
    store.set(JOGA, 0);
    expect(store.lookupKey(JOGA, 1)).toBe(0);
  });

  it("notifies only the song that changed, and nothing for a no-op", async () => {
    const store = new TrackLikeStore();
    await store.load(async () => []);
    const joga = vi.fn();
    const creep = vi.fn();
    const any = vi.fn();
    store.subscribeKey(JOGA, joga);
    store.subscribeKey(CREEP, creep);
    store.subscribe(any);

    store.set(JOGA, 1);
    expect(joga).toHaveBeenCalledTimes(1);
    expect(creep).not.toHaveBeenCalled();
    expect(any).toHaveBeenCalledTimes(1);

    store.set(JOGA, 1);
    expect(joga).toHaveBeenCalledTimes(1);
  });

  it("the first load wakes every subscriber; a reload only the keys that moved", async () => {
    const store = new TrackLikeStore();
    const joga = vi.fn();
    const creep = vi.fn();
    store.subscribeKey(JOGA, joga);
    store.subscribeKey(CREEP, creep);

    await store.load(async () => [{ key: JOGA, liked: 1 }]);
    expect(joga).toHaveBeenCalledTimes(1);
    expect(creep).toHaveBeenCalledTimes(1);

    await store.load(async () => [{ key: JOGA, liked: 1 }, { key: CREEP, liked: -1 }]);
    expect(joga).toHaveBeenCalledTimes(1);
    expect(creep).toHaveBeenCalledTimes(2);

    await store.load(async () => [{ key: CREEP, liked: -1 }]);
    expect(joga).toHaveBeenCalledTimes(2);
    expect(store.lookupKey(JOGA)).toBe(0);
  });

  it("a write made while a load is in flight survives that load's older answer", async () => {
    const store = new TrackLikeStore();
    let answer!: (v: { key: string; liked: number }[]) => void;
    const loading = store.load(() => new Promise((r) => { answer = r; }));
    store.set(JOGA, 1);
    store.set(CREEP, 0);
    answer([{ key: CREEP, liked: -1 }]);
    await loading;
    expect(store.lookupKey(JOGA)).toBe(1);
    expect(store.lookupKey(CREEP)).toBe(0);
  });

  it("a failed load leaves the store unloaded, so callers keep their fallback", async () => {
    const store = new TrackLikeStore();
    await expect(store.load(async () => { throw new Error("db"); })).rejects.toThrow("db");
    expect(store.isLoaded()).toBe(false);
    expect(store.lookupKey(JOGA, 1)).toBe(1);
  });

  it("ignores anything that isn't -1 / 0 / 1", async () => {
    const store = new TrackLikeStore();
    await store.load(async () => [{ key: JOGA, liked: 7 }]);
    expect(store.lookupKey(JOGA)).toBe(0);
    store.set(CREEP, 2);
    expect(store.lookupKey(CREEP)).toBe(0);
  });
});
