import { describe, it, expect } from "vitest";
import { describeFileQuality, formatLength, judgeUpgrade, numberedPath, isLossless, type FileAudioFacts } from "../utils/downloadCompare";
import { rememberQuality, rememberedQuality, coerceQualityMemory } from "../utils/downloadQualityMemory";

const flac: FileAudioFacts = { sample_rate: 44100, bit_depth: 16, channels: 2, bitrate: 1012, duration_secs: 341.2 };
const opus: FileAudioFacts = { sample_rate: 48000, bit_depth: null, channels: 2, bitrate: 130, duration_secs: 362 };

describe("the upgrade compare", () => {
  it("describes lossless by depth and rate, lossy by bitrate", () => {
    expect(describeFileQuality("flac", flac)).toBe("16-bit · 44.1 kHz");
    expect(describeFileQuality("ogg", opus)).toBe("130 kbps");
    expect(describeFileQuality("ogg", null)).toBeNull();
    expect(isLossless("m4a", { ...flac, bit_depth: 24 })).toBe(true);
    expect(isLossless("m4a", opus)).toBe(false);
  });

  it("warns about a downgrade and a different length", () => {
    const v = judgeUpgrade("flac", flac, "ogg", opus);
    expect(v.downgrade).toBe(true);
    expect(v.lengthDiffSecs).toBe(21);
    expect(v.warning).toBe("This is lower quality than your file, and 21 s longer, so it may be a different version.");
  });

  it("says nothing for a real upgrade, or when facts are missing", () => {
    expect(judgeUpgrade("mp3", { ...opus, bitrate: 128, duration_secs: 341 }, "flac", flac).warning).toBeNull();
    expect(judgeUpgrade("flac", null, "ogg", opus)).toMatchObject({ downgrade: false, warning: null });
  });

  it("flags only a clearly lower lossy bitrate", () => {
    const at = (bitrate: number): FileAudioFacts => ({ ...opus, bitrate, duration_secs: 200 });
    expect(judgeUpgrade("mp3", at(320), "ogg", at(130)).downgrade).toBe(true);
    expect(judgeUpgrade("mp3", at(140), "ogg", at(130)).downgrade).toBe(false);
  });

  it("names a length-only difference on its own", () => {
    expect(judgeUpgrade("flac", flac, "flac", { ...flac, duration_secs: 300 }).warning)
      .toBe("It is 41 s shorter, so it may be a different version.");
  });

  it("formats lengths and numbered names", () => {
    expect(formatLength(341.2)).toBe("5:41");
    expect(formatLength(null)).toBeNull();
    expect(numberedPath("D:\\Music\\Pearl Jam - Alive.flac", 3)).toBe("D:\\Music\\Pearl Jam - Alive (3).flac");
    expect(numberedPath("/m/v1.0/noext", 2)).toBe("/m/v1.0/noext (2)");
  });
});

describe("the remembered download quality", () => {
  const options = [{ value: "original", label: "o" }, { value: "video-720", label: "v", video: true }];

  it("is kept per provider and per kind, and only used while offered", () => {
    let m = rememberQuality({}, "ytdlp:dl", true, "video-720");
    m = rememberQuality(m, "ytdlp:dl", false, "original");
    expect(rememberedQuality(m, "ytdlp:dl", true, options)).toBe("video-720");
    expect(rememberedQuality(m, "ytdlp:dl", false, options)).toBe("original");
    expect(rememberedQuality(m, "other", true, options)).toBeNull();
    expect(rememberedQuality(m, "ytdlp:dl", true, [{ value: "video", label: "best" }])).toBeNull();
  });

  it("returns the same object when nothing changed, and coerces junk", () => {
    const m = rememberQuality({}, "p", false, "mp3");
    expect(rememberQuality(m, "p", false, "mp3")).toBe(m);
    expect(coerceQualityMemory({ p: { audio: "mp3", video: 4 }, q: "x", r: {} })).toEqual({ p: { audio: "mp3" } });
    expect(coerceQualityMemory(null)).toEqual({});
  });
});
