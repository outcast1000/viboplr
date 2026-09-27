import { describe, it, expect } from "vitest";
import {
  bitPerfectBlockers,
  isBitPerfect,
  resolveBitPerfectState,
  describeBitPerfectState,
  formatSampleRate,
  isOutputSettling,
  handoverDeviceVolume,
  type EngineOutput,
} from "../utils/bitPerfect";
import { serializeBitPerfect } from "../utils/controlApi";

const clean = { exclusive: true, eqEnabled: false, rgMode: "off" as const, volume: 1.0 };

describe("bitPerfect", () => {
  it("is bit-perfect with exclusive on, EQ/RG off, full volume", () => {
    expect(isBitPerfect(clean)).toBe(true);
    expect(bitPerfectBlockers(clean)).toEqual([]);
  });

  it("tolerates float volume that rounds to 100%", () => {
    expect(isBitPerfect({ ...clean, volume: 0.9995 })).toBe(true);
  });

  it("flags each blocker independently", () => {
    expect(bitPerfectBlockers({ ...clean, exclusive: false })).toEqual(["exclusive off"]);
    expect(bitPerfectBlockers({ ...clean, eqEnabled: true })).toEqual(["EQ"]);
    expect(bitPerfectBlockers({ ...clean, rgMode: "track" })).toEqual(["ReplayGain"]);
    expect(bitPerfectBlockers({ ...clean, rgMode: "album" })).toEqual(["ReplayGain"]);
    expect(bitPerfectBlockers({ ...clean, volume: 0.57 })).toEqual(["volume 57%"]);
  });

  it("lists multiple blockers in display order", () => {
    expect(
      bitPerfectBlockers({ exclusive: true, eqEnabled: true, rgMode: "track", volume: 0.57 }),
    ).toEqual(["EQ", "ReplayGain", "volume 57%"]);
  });

  it("never reports bit-perfect without exclusive access", () => {
    expect(isBitPerfect({ ...clean, exclusive: false })).toBe(false);
  });
});

describe("bitPerfect speed blocker", () => {
  it("treats any speed but 1x as a blocker (it resamples)", () => {
    expect(bitPerfectBlockers({ ...clean, speed: 1 })).toEqual([]);
    expect(bitPerfectBlockers({ ...clean, speed: 1.35 })).toEqual(["speed 1.35x"]);
  });
});

/** A verified-good report: hogged by us, 96k end to end, playing q:1. */
const good: EngineOutput = {
  deviceUid: "BuiltInSpeakerDevice",
  deviceName: "MacBook Pro Speakers",
  devicePresent: true,
  hoggedByUs: true,
  holderPid: null,
  holderName: null,
  trackKey: "q:1",
  srcRate: 96000,
  outRate: 96000,
  deviceRate: 96000,
  deviceMaxRate: 96000,
  rateSupported: true,
  deviceVolume: 0.5,
};
const playingQ1 = { playing: true, currentKey: "q:1" };

describe("resolveBitPerfectState", () => {
  it("is bit-perfect only on verified evidence", () => {
    expect(resolveBitPerfectState(good, playingQ1)).toEqual({ kind: "bit-perfect", rate: 96000 });
  });

  it("is pending before the first report", () => {
    expect(resolveBitPerfectState(null, playingQ1)).toEqual({ kind: "pending" });
  });

  it("reports a missing device as gone, before anything else", () => {
    expect(resolveBitPerfectState({ ...good, devicePresent: false, hoggedByUs: false }, playingQ1).kind).toBe("gone");
  });

  it("is idle when nothing plays, and not-native when the app plays but the engine doesn't", () => {
    const stopped = { ...good, trackKey: null, srcRate: null, outRate: null };
    expect(resolveBitPerfectState(stopped, { playing: false, currentKey: null }).kind).toBe("idle");
    expect(resolveBitPerfectState(stopped, playingQ1).kind).toBe("not-native");
  });

  it("treats a report about another track as stale, not a verdict", () => {
    expect(resolveBitPerfectState({ ...good, trackKey: "q:0" }, playingQ1).kind).toBe("pending");
  });

  it("waits, naming the holder, when another process holds the device (mpv stalls silently)", () => {
    const busy = { ...good, hoggedByUs: false, holderPid: 17942, holderName: "Audirvana", outRate: 44100, deviceRate: 44100 };
    expect(resolveBitPerfectState(busy, playingQ1)).toEqual({ kind: "waiting", holderName: "Audirvana" });
  });

  it("flags exclusive not granted while playing, but not while paused", () => {
    const shared = { ...good, hoggedByUs: false };
    expect(resolveBitPerfectState(shared, playingQ1).kind).toBe("no-exclusive");
    expect(resolveBitPerfectState(shared, { ...playingQ1, playing: false }).kind).toBe("idle");
  });

  it("names a device that can't reach the source rate", () => {
    const jabra = { ...good, rateSupported: false, outRate: 48000, deviceRate: 48000, deviceMaxRate: 48000 };
    expect(resolveBitPerfectState(jabra, playingQ1)).toEqual({ kind: "device-limit", maxRate: 48000 });
  });

  it("catches the gapless=yes failure: output held at the first track's rate", () => {
    const stuck = { ...good, outRate: 44100, deviceRate: 44100 };
    expect(resolveBitPerfectState(stuck, playingQ1)).toEqual({
      kind: "resampled", srcRate: 96000, outRate: 44100, deviceRate: 44100,
    });
  });

  it("catches a device that didn't follow the output rate", () => {
    expect(resolveBitPerfectState({ ...good, deviceRate: 48000 }, playingQ1).kind).toBe("resampled");
  });

  it("is pending while the rates aren't known yet", () => {
    expect(resolveBitPerfectState({ ...good, outRate: null }, playingQ1).kind).toBe("pending");
  });
});

describe("describeBitPerfectState", () => {
  it("is green only for bit-perfect", () => {
    expect(describeBitPerfectState({ kind: "bit-perfect", rate: 44100 }, "DAC")).toEqual({
      tone: "ok", text: "Bit-perfect · 44.1 kHz · DAC",
    });
    expect(describeBitPerfectState({ kind: "waiting", holderName: null }, "DAC").tone).toBe("warn");
    expect(describeBitPerfectState({ kind: "idle" }, "DAC").tone).toBe("neutral");
  });

  it("names the holder and the escape hatch while waiting", () => {
    const { text } = describeBitPerfectState({ kind: "waiting", holderName: "Audirvana" }, "DAC");
    expect(text).toContain("in use by Audirvana");
    expect(text).toContain("play shared instead");
  });
});

describe("formatSampleRate", () => {
  it("formats integer and fractional kHz", () => {
    expect(formatSampleRate(44100)).toBe("44.1 kHz");
    expect(formatSampleRate(96000)).toBe("96 kHz");
    expect(formatSampleRate(null)).toBe("?");
  });
});

describe("serializeBitPerfect (control API)", () => {
  it("reports on/state/device/rates", () => {
    const out = serializeBitPerfect({
      pin: { uid: good.deviceUid, name: good.deviceName },
      state: { kind: "bit-perfect", rate: 96000 },
      output: good,
    });
    expect(out).toEqual({
      on: true, state: "bit-perfect", device: "MacBook Pro Speakers",
      heldExclusively: true, heldBy: null, sourceRate: 96000, outputRate: 96000, deviceRate: 96000,
      deviceVolume: 0.5,
    });
  });

  it("is off with nulls when the mode isn't on", () => {
    expect(serializeBitPerfect({ pin: null, state: null, output: null })).toMatchObject({ on: false, state: null, device: null });
  });
});

describe("settling grace window", () => {
  it("recognises the two transient shapes of a reopening output", () => {
    expect(isOutputSettling({ ...good, hoggedByUs: false })).toBe(true); // exclusive not granted yet
    expect(isOutputSettling({ ...good, deviceRate: 44100 })).toBe(true); // device not switched yet
    expect(isOutputSettling(good)).toBe(false);
  });

  it("never treats a busy device, a device limit or an idle engine as transient", () => {
    expect(isOutputSettling({ ...good, hoggedByUs: false, holderPid: 7 })).toBe(false);
    expect(isOutputSettling({ ...good, rateSupported: false, outRate: 48000 })).toBe(false);
    expect(isOutputSettling({ ...good, trackKey: null })).toBe(false);
  });

  it("reads a transient mismatch as pending while settling, and reports it after", () => {
    const reopening = { ...good, deviceRate: 44100 };
    expect(resolveBitPerfectState(reopening, { ...playingQ1, settling: true }).kind).toBe("pending");
    expect(resolveBitPerfectState(reopening, playingQ1).kind).toBe("resampled");
    const noHog = { ...good, hoggedByUs: false };
    expect(resolveBitPerfectState(noHog, { ...playingQ1, settling: true }).kind).toBe("pending");
    expect(resolveBitPerfectState(noHog, playingQ1).kind).toBe("no-exclusive");
  });

  it("still reports a busy device at once while settling", () => {
    const busy = { ...good, hoggedByUs: false, holderPid: 7, holderName: "Audirvana" };
    expect(resolveBitPerfectState(busy, { ...playingQ1, settling: true }).kind).toBe("waiting");
  });
});

describe("handoverDeviceVolume", () => {
  it("lowers the device by the player's volume so loudness drops, never jumps", () => {
    expect(handoverDeviceVolume(0.5, 0.4)).toBeCloseTo(0.2);
    expect(handoverDeviceVolume(0.8, 0)).toBe(0);
  });

  it("leaves the device alone at full player volume or without a device volume", () => {
    expect(handoverDeviceVolume(0.5, 1)).toBeNull();
    expect(handoverDeviceVolume(null, 0.4)).toBeNull();
  });
});
