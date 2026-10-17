/** What the upgrade compare knows about one file (`get_audio_properties_by_path`). */
export interface FileAudioFacts {
  sample_rate: number | null;
  bit_depth: number | null;
  channels: number | null;
  bitrate: number | null;
  duration_secs: number | null;
}

const LOSSLESS = new Set(["flac", "wav", "aiff", "aif", "aifc", "ape", "wv", "tta", "dsf", "dff", "alac"]);

/** Lossless by container, or an .m4a that reports a bit depth (ALAC; AAC has none). */
export function isLossless(format: string | null | undefined, facts: FileAudioFacts | null): boolean {
  const f = (format ?? "").toLowerCase().replace(/^\./, "");
  if (LOSSLESS.has(f)) return true;
  return f === "m4a" && facts?.bit_depth != null;
}

/** One line for a file's audio quality: "16-bit · 44.1 kHz" for lossless,
 *  "320 kbps" for lossy, null when nothing is known. */
export function describeFileQuality(format: string | null | undefined, facts: FileAudioFacts | null): string | null {
  if (!facts) return null;
  const khz = facts.sample_rate ? `${(facts.sample_rate / 1000).toFixed(facts.sample_rate % 1000 === 0 ? 0 : 1)} kHz` : null;
  if (isLossless(format, facts)) {
    return [facts.bit_depth ? `${facts.bit_depth}-bit` : null, khz].filter(Boolean).join(" · ") || null;
  }
  return facts.bitrate ? `${facts.bitrate} kbps` : khz;
}

/** Length as m:ss, or null. */
export function formatLength(secs: number | null | undefined): string | null {
  if (secs == null || !isFinite(secs) || secs <= 0) return null;
  const s = Math.round(secs);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Lengths further apart than this are probably different recordings or edits. */
export const LENGTH_MISMATCH_SECS = 5;

export interface UpgradeVerdict {
  /** The new file is lower quality than the current one. */
  downgrade: boolean;
  /** New minus old length in seconds, when both are known and they differ
   *  by more than `LENGTH_MISMATCH_SECS`; else null. */
  lengthDiffSecs: number | null;
  /** One sentence for the compare's warning, or null when there is nothing to say. */
  warning: string | null;
}

/** Is replacing `oldFile` with `newFile` an upgrade? Conservative: unknown
 *  facts never produce a warning. */
export function judgeUpgrade(
  oldFormat: string | null | undefined,
  oldFacts: FileAudioFacts | null,
  newFormat: string | null | undefined,
  newFacts: FileAudioFacts | null,
): UpgradeVerdict {
  const oldLossless = isLossless(oldFormat, oldFacts);
  const newLossless = isLossless(newFormat, newFacts);
  let downgrade = false;
  if (oldFacts && newFacts) {
    if (oldLossless && !newLossless) downgrade = true;
    else if (!oldLossless && !newLossless && oldFacts.bitrate && newFacts.bitrate) {
      downgrade = newFacts.bitrate < oldFacts.bitrate * 0.85;
    }
  }
  let lengthDiffSecs: number | null = null;
  if (oldFacts?.duration_secs && newFacts?.duration_secs) {
    const diff = newFacts.duration_secs - oldFacts.duration_secs;
    if (Math.abs(diff) > LENGTH_MISMATCH_SECS) lengthDiffSecs = Math.round(diff);
  }
  const parts: string[] = [];
  if (downgrade) parts.push("This is lower quality than your file");
  if (lengthDiffSecs != null) {
    const n = Math.abs(lengthDiffSecs);
    const len = `${n} s ${lengthDiffSecs > 0 ? "longer" : "shorter"}, so it may be a different version`;
    parts.push(parts.length ? `and ${len}` : `It is ${len}`);
  }
  return { downgrade, lengthDiffSecs, warning: parts.length ? `${parts.join(", ")}.` : null };
}

/** `D:\Music\A - B (2).flac` for `D:\Music\A - B.flac` and n = 2. */
export function numberedPath(path: string, n: number): string {
  const sep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const dot = path.lastIndexOf(".");
  if (dot > sep + 1) return `${path.slice(0, dot)} (${n})${path.slice(dot)}`;
  return `${path} (${n})`;
}
