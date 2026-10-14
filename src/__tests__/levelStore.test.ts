import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const engineMock = vi.hoisted(() => ({ setMeter: vi.fn(() => Promise.resolve()) }));
vi.mock("../playback/nativeEngine", () => ({ nativeEngine: engineMock }));

import {
  METER_RELEASE_GRACE_MS,
  clearPlaybackLevel,
  getPlaybackLevel,
  resetLevelStoreForTests,
  setPlaybackLevel,
  watchPlaybackLevel,
} from "../playback/levelStore";

const reading = { peakDb: [-6, -12], rmsDb: [-9, -15] };

beforeEach(() => {
  vi.useFakeTimers();
  resetLevelStoreForTests();
  engineMock.setMeter.mockClear();
});
afterEach(() => vi.useRealTimers());

describe("level meter ref count", () => {
  it("nothing is measured until someone watches", () => {
    setPlaybackLevel(reading);
    expect(engineMock.setMeter).not.toHaveBeenCalled();
  });

  it("two consumers share one meter: on once, off once after the last leaves", () => {
    const a = watchPlaybackLevel(() => {});
    const b = watchPlaybackLevel(() => {});
    expect(engineMock.setMeter.mock.calls).toEqual([[true]]);

    a();
    vi.advanceTimersByTime(METER_RELEASE_GRACE_MS * 2);
    expect(engineMock.setMeter.mock.calls).toEqual([[true]]); // b still holds it

    b();
    vi.advanceTimersByTime(METER_RELEASE_GRACE_MS - 1);
    expect(engineMock.setMeter.mock.calls).toEqual([[true]]); // still in the grace window
    vi.advanceTimersByTime(1);
    expect(engineMock.setMeter.mock.calls).toEqual([[true], [false]]);
  });

  it("a consumer arriving inside the grace window keeps the meter on without a toggle", () => {
    const a = watchPlaybackLevel(() => {});
    a();
    vi.advanceTimersByTime(METER_RELEASE_GRACE_MS / 2);
    const b = watchPlaybackLevel(() => {});
    vi.advanceTimersByTime(METER_RELEASE_GRACE_MS * 2);
    expect(engineMock.setMeter.mock.calls).toEqual([[true]]);
    b();
    vi.advanceTimersByTime(METER_RELEASE_GRACE_MS);
    expect(engineMock.setMeter.mock.calls).toEqual([[true], [false]]);
  });

  it("releasing twice counts once", () => {
    const a = watchPlaybackLevel(() => {});
    const b = watchPlaybackLevel(() => {});
    a();
    a();
    vi.advanceTimersByTime(METER_RELEASE_GRACE_MS);
    expect(engineMock.setMeter.mock.calls).toEqual([[true]]); // b is not released by a's second call
    b();
    vi.advanceTimersByTime(METER_RELEASE_GRACE_MS);
    expect(engineMock.setMeter.mock.calls).toEqual([[true], [false]]);
  });

  it("a rejected turn-on is logged, and the next consumer asks again", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    engineMock.setMeter.mockImplementationOnce(() => Promise.reject(new Error("filter rejected")));
    watchPlaybackLevel(() => {});
    await vi.waitFor(() => expect(err).toHaveBeenCalled());
    watchPlaybackLevel(() => {});
    expect(engineMock.setMeter.mock.calls).toEqual([[true], [true]]);
    err.mockRestore();
  });
});

describe("readings", () => {
  it("every watcher gets each reading, and a released one stops", () => {
    const a = vi.fn();
    const b = vi.fn();
    const stopA = watchPlaybackLevel(a);
    watchPlaybackLevel(b);
    setPlaybackLevel(reading);
    expect(a).toHaveBeenCalledWith(reading);
    expect(b).toHaveBeenCalledWith(reading);
    stopA();
    setPlaybackLevel({ peakDb: [-1], rmsDb: [-4] });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it("clearing announces null once, and only when there was a reading", () => {
    const fn = vi.fn();
    watchPlaybackLevel(fn);
    clearPlaybackLevel();
    expect(fn).not.toHaveBeenCalled();
    setPlaybackLevel(reading);
    clearPlaybackLevel();
    clearPlaybackLevel();
    expect(fn.mock.calls).toEqual([[reading], [null]]);
    expect(getPlaybackLevel()).toBeNull();
  });
});
