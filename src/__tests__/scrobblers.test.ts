import { describe, it, expect } from "vitest";
import {
  buildScrobblerList,
  coerceScrobbleSettings,
  DEFAULT_SCROBBLE_SETTINGS,
  LOCAL_HISTORY_SCROBBLER,
  scrobblerAccepts,
  videoOnForAll,
  withScrobbleMedia,
  withVideoForAll,
} from "../utils/scrobblers";

describe("coerceScrobbleSettings", () => {
  it("defaults to audio + video for everyone", () => {
    expect(coerceScrobbleSettings(undefined)).toEqual(DEFAULT_SCROBBLE_SETTINGS);
  });

  // The old switch gated every scrobbler at once (usePlayback skipped the
  // threshold for video), so it migrates into the default, not into one row.
  it("migrates the legacy trackVideoHistory switch into the default", () => {
    const s = coerceScrobbleSettings(undefined, false);
    expect(s.default).toEqual({ audio: true, video: false });
    expect(scrobblerAccepts(s, LOCAL_HISTORY_SCROBBLER, true)).toBe(false);
    expect(scrobblerAccepts(s, "lastfm", true)).toBe(false);
    expect(scrobblerAccepts(s, "lastfm", false)).toBe(true);
  });

  it("ignores the legacy key once the new one exists", () => {
    const s = coerceScrobbleSettings({ default: { audio: true, video: true }, byId: {} }, false);
    expect(s.default.video).toBe(true);
  });

  it("repairs fields one by one", () => {
    const s = coerceScrobbleSettings({ default: { audio: false }, byId: { lastfm: { video: false }, bad: "x" } });
    expect(s.default).toEqual({ audio: false, video: true });
    expect(s.byId.lastfm).toEqual({ audio: false, video: false });
    expect(s.byId.bad).toEqual({ audio: false, video: true });
  });
});

describe("per-scrobbler media", () => {
  it("an untouched scrobbler follows the default", () => {
    const s = withScrobbleMedia(DEFAULT_SCROBBLE_SETTINGS, LOCAL_HISTORY_SCROBBLER, { video: false });
    expect(scrobblerAccepts(s, LOCAL_HISTORY_SCROBBLER, true)).toBe(false);
    expect(scrobblerAccepts(s, LOCAL_HISTORY_SCROBBLER, false)).toBe(true);
    expect(scrobblerAccepts(s, "community", true)).toBe(true);
  });

  it("withVideoForAll covers known rows and future plugins", () => {
    const s = withVideoForAll(withScrobbleMedia(DEFAULT_SCROBBLE_SETTINGS, "lastfm", { audio: false }), false);
    expect(s.byId.lastfm).toEqual({ audio: false, video: false });
    expect(scrobblerAccepts(s, "not-installed-yet", true)).toBe(false);
    expect(videoOnForAll(s, [LOCAL_HISTORY_SCROBBLER, "lastfm"])).toBe(false);
    expect(videoOnForAll(withVideoForAll(s, true), [LOCAL_HISTORY_SCROBBLER, "lastfm"])).toBe(true);
  });

  it("videoOnForAll ignores entries for scrobblers no longer listed", () => {
    const s = withScrobbleMedia(DEFAULT_SCROBBLE_SETTINGS, "uninstalled", { video: false });
    expect(videoOnForAll(s, [LOCAL_HISTORY_SCROBBLER, "lastfm"])).toBe(true);
    expect(videoOnForAll(s, [LOCAL_HISTORY_SCROBBLER, "uninstalled"])).toBe(false);
  });
});

// byId is a plain object: an id that names an Object.prototype member must
// still fall back to the default instead of reading the prototype's value.
describe("prototype-named scrobbler ids", () => {
  it("fall back to the default", () => {
    const s = coerceScrobbleSettings({ default: { audio: true, video: false }, byId: {} });
    for (const id of ["constructor", "toString", "hasOwnProperty"]) {
      expect(scrobblerAccepts(s, id, false)).toBe(true);
      expect(scrobblerAccepts(s, id, true)).toBe(false);
    }
  });

  it("keep a stored __proto__ entry as data", () => {
    const raw = JSON.parse('{"default":{"audio":true,"video":true},"byId":{"__proto__":{"audio":false,"video":false}}}');
    const s = coerceScrobbleSettings(raw);
    expect(Object.getPrototypeOf(s.byId)).toBe(Object.prototype);
    expect(scrobblerAccepts(s, "__proto__", false)).toBe(false);
    expect(scrobblerAccepts(s, "lastfm", false)).toBe(true);
  });
});

describe("buildScrobblerList", () => {
  it("puts local history first and plugins by name", () => {
    const list = buildScrobblerList(["lastfm", "community", "gone"], [
      { id: "lastfm", manifest: { name: "Last.fm" } },
      { id: "community", manifest: { name: "Community", description: "Share" } },
    ]);
    expect(list.map((e) => e.id)).toEqual([LOCAL_HISTORY_SCROBBLER, "community", "gone", "lastfm"]);
    expect(list[0].builtin).toBe(true);
    expect(list.find((e) => e.id === "gone")?.name).toBe("gone");
  });
});
