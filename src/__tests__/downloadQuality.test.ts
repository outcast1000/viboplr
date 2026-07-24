import { describe, it, expect } from "vitest";
import { defaultQualityValue } from "../utils/downloadQuality";
import type { DownloadQualityOption } from "../types/plugin";

const YTDLP_QUALITIES: DownloadQualityOption[] = [
  { value: "original", label: "Original — best quality, no re-encode" },
  { value: "opus", label: "Opus (re-encode)" },
  { value: "aac", label: "AAC (re-encode)" },
  { value: "mp3", label: "MP3 (re-encode)" },
  { value: "flac", label: "FLAC" },
  { value: "video", label: "Video (MP4)", video: true },
];

describe("defaultQualityValue", () => {
  it("defaults a video track to the first video-flagged option", () => {
    expect(defaultQualityValue(YTDLP_QUALITIES, true)).toBe("video");
  });

  it("defaults a non-video track to the first option (audio 'original')", () => {
    expect(defaultQualityValue(YTDLP_QUALITIES, false)).toBe("original");
  });

  it("falls back to the first option for a video track when no option is a video", () => {
    const audioOnly = YTDLP_QUALITIES.filter((q) => !q.video);
    expect(defaultQualityValue(audioOnly, true)).toBe("original");
  });

  it("picks the first video option when several are flagged", () => {
    const opts: DownloadQualityOption[] = [
      { value: "audio", label: "Audio" },
      { value: "video-720", label: "720p", video: true },
      { value: "video-1080", label: "1080p", video: true },
    ];
    expect(defaultQualityValue(opts, true)).toBe("video-720");
  });

  it("returns null for an empty option list (caller supplies its own fallback)", () => {
    expect(defaultQualityValue([], true)).toBeNull();
    expect(defaultQualityValue([], false)).toBeNull();
  });
});
