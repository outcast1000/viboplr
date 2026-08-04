// Coarse, low-cardinality classification of an error into a telemetry-safe
// bucket.
//
// Error *rates* are already tracked (playback_error, stream_resolve_failed,
// download_failed, …) but every one of them is a bare count, so a spike in a
// release tells you something broke without telling you what kind of thing.
// `classifyErrorKind` maps an arbitrary error onto a fixed enum so the reason
// can ride along as a telemetry prop without ever sending the raw message.
//
// The output set is CLOSED and must stay small — these become ClickHouse
// column values, and the telemetry contract (see telemetry.ts) is enum-like
// values only, never free text. Adding a bucket is fine; passing a message
// through is not.

export type ErrorKind =
  | "network"
  | "timeout"
  | "not_found"
  | "permission"
  | "auth"
  | "rate_limit"
  | "server"
  | "format"
  | "disk_full"
  | "cancelled"
  | "dependency"
  | "parse"
  | "unknown";

/** Ordered most-specific first — the first matching pattern wins. */
const PATTERNS: Array<[ErrorKind, RegExp]> = [
  // Deliberate stops. Checked first so an aborted request isn't counted as a
  // network failure — user-cancelled work is not a reliability signal.
  ["cancelled", /\b(abort(ed)?|cancell?ed|user cancelled|operation was cancelled)\b/],
  // Missing companion binaries (yt-dlp / ffmpeg) have their own remedy in the
  // app, so they must not be lumped in with generic "not found".
  ["dependency", /\b(yt-dlp|ffmpeg|ffprobe)\b|\bnot (installed|on path)\b|\benoent.*\b(yt-dlp|ffmpeg)\b/],
  ["rate_limit", /\b(429|rate ?limit(ed)?|too many requests|quota exceeded)\b/],
  ["auth", /\b(401|403|unauthor(ized|ised)|forbidden|invalid (api ?key|token|credentials)|authentication failed|login required)\b/],
  ["disk_full", /\b(enospc|no space left|disk (is )?full|insufficient (disk )?space)\b/],
  ["permission", /\b(eacces|eperm|permission denied|access is denied|operation not permitted|read-?only file ?system)\b/],
  ["timeout", /\b(etimedout|timed? ?out|timeout|deadline exceeded)\b/],
  ["not_found", /\b(404|enoent|not found|no such file|does not exist|missing file|unavailable|removed by)\b/],
  ["server", /\b(5\d{2}|internal server error|bad gateway|service unavailable|gateway timeout)\b/],
  // Decode / container problems. Distinct from `parse` (which is about the
  // app's own JSON/text handling) because this one is the format-support path.
  ["format", /\b(unsupported|not supported|no decoder|codec|demux|decode (error|failed)|malformed (stream|media)|src not supported|media_err_src_not_supported|no playable source)\b/],
  ["parse", /\b(json|unexpected token|syntax ?error|failed to parse|invalid (response|json|xml))\b/],
  // Broadest bucket last so a specific cause above always wins.
  ["network", /\b(network|fetch (failed|error)|econnrefused|econnreset|enotfound|eai_again|dns|offline|connection (refused|reset|closed|failed)|ssl|tls|certificate|err_internet_disconnected|load failed)\b/],
];

/**
 * Bucket an arbitrary error into a fixed enum for telemetry.
 * Never returns any part of the input — only one of the `ErrorKind` literals.
 */
export function classifyErrorKind(error: unknown): ErrorKind {
  const text = errorText(error).toLowerCase();
  if (!text) return "unknown";
  for (const [kind, pattern] of PATTERNS) {
    if (pattern.test(text)) return kind;
  }
  return "unknown";
}

/**
 * Best-effort readable text for an arbitrary thrown value. Used by the
 * classifier and by the diagnostic report's error buffer — NOT by telemetry,
 * which only ever sends the classified bucket.
 */
export function errorText(error: unknown): string {
  if (error == null) return "";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "object") {
    const obj = error as Record<string, unknown>;
    // Tauri `invoke` rejects with a plain string; DOM events and plugin
    // responses commonly carry `message` / `error` / `reason`.
    for (const key of ["message", "error", "reason", "description"]) {
      const value = obj[key];
      if (typeof value === "string" && value) return value;
    }
    try {
      return JSON.stringify(error);
    } catch {
      // Circular or otherwise non-serializable — fall through to String().
    }
  }
  return String(error);
}
