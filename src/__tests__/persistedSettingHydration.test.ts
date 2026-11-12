import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const storeSet = vi.fn(async () => {});
vi.mock("../store", () => ({ store: { set: (...a: unknown[]) => storeSet(...(a as [])) } }));

import { usePersistedSetting, hydratePersistedSettings, sameShape } from "../hooks/usePersistedSetting";
import {
  restoreQueueWidth, restoreSidebarWidth, restoreSearchViewModes, restoreOneOf, restoreNonEmptyString, restoreStringList,
} from "../startup/settingRestorers";

beforeEach(() => storeSet.mockClear());

describe("sameShape (default restore)", () => {
  it("accepts a value of the default's type", () => {
    expect(sameShape(true, false)).toBe(true);
    expect(sameShape(false, true)).toBe(false);
    expect(sameShape(2.5, 1)).toBe(2.5);
    expect(sameShape("cards", "list")).toBe("cards");
    expect(sameShape([1, 2], [])).toEqual([1, 2]);
    expect(sameShape({ a: 1 }, {})).toEqual({ a: 1 });
  });
  it("rejects anything else, so the default stands", () => {
    expect(sameShape("yes", false)).toBeUndefined();
    expect(sameShape(Number.NaN, 1)).toBeUndefined();
    expect(sameShape({}, [])).toBeUndefined();
    expect(sameShape([], {})).toBeUndefined();
    expect(sameShape(null, {})).toBeUndefined();
    // A null default has no shape: such a setting must pass its own restore.
    expect(sameShape("x", null)).toBeUndefined();
  });
});

describe("usePersistedSetting hydration", () => {
  it("takes its saved value from the snapshot without writing it back", () => {
    const restoredRef = { current: false };
    const { result } = renderHook(() => usePersistedSetting("hydrateFlag", false, restoredRef));
    storeSet.mockClear();
    act(() => hydratePersistedSettings(new Map([["hydrateFlag", true]])));
    expect(result.current[0]).toBe(true);
    // restoredRef is still false: restore never persists.
    expect(storeSet).not.toHaveBeenCalled();
  });

  it("keeps the default for an absent key or a value of the wrong shape", () => {
    const restoredRef = { current: false };
    const { result } = renderHook(() => usePersistedSetting("hydrateWidth", 300, restoredRef));
    act(() => hydratePersistedSettings(new Map()));
    expect(result.current[0]).toBe(300);
    act(() => hydratePersistedSettings(new Map([["hydrateWidth", "wide"]])));
    expect(result.current[0]).toBe(300);
  });

  it("runs the setting's own restore rule", () => {
    const restoredRef = { current: false };
    const { result } = renderHook(() =>
      usePersistedSetting("hydrateQueueWidth", 300, restoredRef, { restore: restoreQueueWidth }));
    act(() => hydratePersistedSettings(new Map([["hydrateQueueWidth", 900]])));
    expect(result.current[0]).toBe(300);
    act(() => hydratePersistedSettings(new Map([["hydrateQueueWidth", 420]])));
    expect(result.current[0]).toBe(420);
  });

  it("persists changes once restore is over", () => {
    const restoredRef = { current: false };
    const { result } = renderHook(() => usePersistedSetting("hydratePersist", false, restoredRef));
    restoredRef.current = true;
    act(() => result.current[1](true));
    expect(storeSet).toHaveBeenCalledWith("hydratePersist", true);
  });

  it("a remount under the same key takes over; the old instance's cleanup doesn't unregister it", () => {
    const restoredRef = { current: false };
    const first = renderHook(() => usePersistedSetting("hydrateRemount", false, restoredRef));
    const second = renderHook(() => usePersistedSetting("hydrateRemount", false, restoredRef));
    first.unmount();
    act(() => hydratePersistedSettings(new Map([["hydrateRemount", true]])));
    expect(second.result.current[0]).toBe(true);
  });
});

describe("restore rules", () => {
  it("queue width stays inside the resizable range", () => {
    expect(restoreQueueWidth(199)).toBeUndefined();
    expect(restoreQueueWidth(200)).toBe(200);
    expect(restoreQueueWidth(600)).toBe(600);
    expect(restoreQueueWidth(601)).toBeUndefined();
    expect(restoreQueueWidth("300")).toBeUndefined();
  });

  it("sidebar width stays inside the resizable range", () => {
    expect(restoreSidebarWidth(159)).toBeUndefined();
    expect(restoreSidebarWidth(160)).toBe(160);
    expect(restoreSidebarWidth(320)).toBe(320);
    expect(restoreSidebarWidth(321)).toBeUndefined();
  });

  it("search view modes need tracks/albums/artists; tags falls back to tiles", () => {
    expect(restoreSearchViewModes({ tracks: "list", albums: "tiles", artists: "basic" }))
      .toEqual({ tracks: "list", albums: "tiles", artists: "basic", tags: "tiles" });
    expect(restoreSearchViewModes({ tracks: "list", albums: "tiles", artists: "basic", tags: "list" })?.tags).toBe("list");
    expect(restoreSearchViewModes({ tracks: "grid", albums: "tiles", artists: "basic" })).toBeUndefined();
    expect(restoreSearchViewModes(null)).toBeUndefined();
  });

  it("one-of, non-empty string and string list", () => {
    const mode = restoreOneOf(["cards", "list"] as const);
    expect(mode("cards")).toBe("cards");
    expect(mode("grid")).toBeUndefined();
    expect(restoreNonEmptyString("/dev/plugins")).toBe("/dev/plugins");
    expect(restoreNonEmptyString("")).toBeUndefined();
    expect(restoreNonEmptyString(null)).toBeUndefined();
    expect(restoreStringList(["a", 1, "b"])).toEqual(["a", "b"]);
    expect(restoreStringList("a")).toBeUndefined();
  });
});
