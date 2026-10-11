import { describe, it, expect } from "vitest";
import {
  buildScrobblerList,
  coerceScrobbleReport,
  coerceScrobbleSettings,
  coerceScrobblerStatuses,
  DEFAULT_SCROBBLE_SETTINGS,
  describeScrobblerStatus,
  LOCAL_HISTORY_SCROBBLER,
  SCROBBLE_MESSAGE_MAX,
  scrobbleDefaultsFromPlugins,
  scrobbleMediaFor,
  scrobblerAccepts,
  settleScrobbleResult,
  statusAccepts,
  type ScrobblerStatus,
  videoOnForAll,
  withScrobbleMedia,
  withScrobblerStatus,
  withVideoForAll,
} from "../utils/scrobblers";

describe("scrobblers that start off", () => {
  const defaults = scrobbleDefaultsFromPlugins([
    { id: "community", manifest: { contributes: { scrobbler: { defaultEnabled: false } } } },
    { id: "lastfm", manifest: { contributes: {} } },
    { id: "explicit-on", manifest: { contributes: { scrobbler: { defaultEnabled: true } } } },
  ]);

  it("only a plugin declaring defaultEnabled: false is listed", () => {
    expect(Object.keys(defaults)).toEqual(["community"]);
  });

  it("stays off until the user turns it on, while others follow the default", () => {
    const s = DEFAULT_SCROBBLE_SETTINGS;
    expect(scrobblerAccepts(s, "community", false, defaults)).toBe(false);
    expect(scrobblerAccepts(s, "community", true, defaults)).toBe(false);
    expect(scrobblerAccepts(s, "lastfm", false, defaults)).toBe(true);
    const on = withScrobbleMedia(s, "community", { audio: true }, defaults);
    expect(on.byId.community).toEqual({ audio: true, video: false });
    expect(scrobblerAccepts(on, "community", false, defaults)).toBe(true);
  });

  // Onboarding's "Track video history" is not consent to send plays off the machine.
  it("is not switched on by video-for-all, and doesn't read that switch as off", () => {
    const s = withVideoForAll(DEFAULT_SCROBBLE_SETTINGS, true);
    expect(scrobbleMediaFor(s, "community", defaults)).toEqual({ audio: false, video: false });
    expect(videoOnForAll(s, [LOCAL_HISTORY_SCROBBLER, "community"], defaults)).toBe(true);
  });

  it("prototype-named ids don't read Object.prototype from the defaults", () => {
    expect(scrobbleMediaFor(DEFAULT_SCROBBLE_SETTINGS, "constructor", defaults)).toEqual(DEFAULT_SCROBBLE_SETTINGS.default);
  });
});

describe("scrobble reports", () => {
  it("accepts the four statuses and drops everything else", () => {
    expect(coerceScrobbleReport({ status: "sent", extra: 1 })).toEqual({ status: "sent" });
    expect(coerceScrobbleReport({ status: "queued", pending: 3.7 })).toEqual({ status: "queued", pending: 3 });
    expect(coerceScrobbleReport({ status: "failed", message: "  boom \n here " })).toEqual({ status: "failed", message: "boom here" });
    expect(coerceScrobbleReport(undefined)).toBeNull();
    expect(coerceScrobbleReport({ status: "delivered" })).toBeNull();
    expect(coerceScrobbleReport({ status: "skipped", pending: -1, message: 42 })).toEqual({ status: "skipped" });
  });

  it("caps the message", () => {
    const r = coerceScrobbleReport({ status: "failed", message: "x".repeat(500) });
    expect(r?.message?.length).toBe(SCROBBLE_MESSAGE_MAX);
  });

  it("only sent, queued and handed-over count for the checkmark", () => {
    expect(["sent", "queued", "delivered"].every((s) => statusAccepts(s as never))).toBe(true);
    expect(statusAccepts("skipped")).toBe(false);
    expect(statusAccepts("failed")).toBe(false);
  });
});

describe("settleScrobbleResult", () => {
  function run(result: { value?: unknown; error?: unknown }, current?: ScrobblerStatus) {
    const recorded: unknown[] = [];
    const settled = settleScrobbleResult(result, {
      dispatchedAt: 100,
      current: () => current,
      record: (r) => recorded.push(r),
      describeError: (e) => (e instanceof Error ? e.message : String(e)),
    });
    return settled.then((took) => ({ took, recorded }));
  }

  it("uses the handler's report, sync or async", async () => {
    expect(await run({ value: { status: "sent" } })).toEqual({ took: true, recorded: [{ status: "sent" }] });
    expect(await run({ value: Promise.resolve({ status: "skipped", message: "Signed out" }) }))
      .toEqual({ took: false, recorded: [{ status: "skipped", message: "Signed out" }] });
  });

  it("a throw or a rejection is a failure with its message", async () => {
    expect(await run({ error: new Error("boom") })).toEqual({ took: false, recorded: [{ status: "failed", message: "boom" }] });
    expect(await run({ value: Promise.reject(new Error("503")) })).toEqual({ took: false, recorded: [{ status: "failed", message: "503" }] });
  });

  it("a bare return is 'handed over' — unless the plugin reported during the handler", async () => {
    expect(await run({ value: undefined })).toEqual({ took: true, recorded: [{ status: "delivered" }] });
    expect(await run({ value: undefined }, { status: "failed", at: 50 })).toEqual({ took: true, recorded: [{ status: "delivered" }] });
    expect(await run({ value: undefined }, { status: "failed", at: 150 })).toEqual({ took: false, recorded: [] });
  });
});

describe("scrobbler statuses", () => {
  it("a report without a track keeps the play last recorded", () => {
    let s = withScrobblerStatus({}, "community", { status: "queued", pending: 2 }, { title: "Seemann", artist: "Rammstein" }, 1000);
    s = withScrobblerStatus(s, "community", { status: "sent", pending: 0 }, null, 2000);
    expect(s.community).toEqual({ status: "sent", at: 2000, title: "Seemann", artist: "Rammstein", pending: 0 });
  });

  it("restores defensively, entry by entry", () => {
    const raw = JSON.parse('{"core:history":{"status":"sent","at":5,"title":"A"},"bad":{"status":"nope","at":1},"noat":{"status":"sent"},"__proto__":{"status":"failed","at":2}}');
    const s = coerceScrobblerStatuses(raw);
    expect(Object.keys(s).sort()).toEqual(["__proto__", "core:history"]);
    expect(Object.getPrototypeOf(s)).toBe(Object.prototype);
    expect(coerceScrobblerStatuses("x")).toEqual({});
  });

  it("describes each outcome", () => {
    const ago = () => "2 min ago";
    const song = { title: "Seemann", artist: "Rammstein", at: 0 };
    expect(describeScrobblerStatus(undefined, ago)).toEqual({ tone: "muted", text: "No plays yet" });
    expect(describeScrobblerStatus({ ...song, status: "sent" }, ago).text).toBe("Sent “Seemann” – Rammstein · 2 min ago");
    expect(describeScrobblerStatus({ ...song, status: "queued", pending: 3 }, ago).text)
      .toBe("Queued “Seemann” – Rammstein · 2 min ago · 3 plays waiting to send");
    expect(describeScrobblerStatus({ ...song, status: "skipped", message: "Sign in to send plays" }, ago))
      .toEqual({ tone: "warning", text: "Not sent: Sign in to send plays · 2 min ago" });
    expect(describeScrobblerStatus({ ...song, status: "failed", message: "Server returned 503" }, ago))
      .toEqual({ tone: "error", text: "Failed to send “Seemann” – Rammstein: Server returned 503 · 2 min ago" });
    expect(describeScrobblerStatus({ status: "delivered", at: 0 }, ago).text).toBe("Handed the last play to the plugin · 2 min ago");
  });
});

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
