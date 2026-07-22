import { invoke } from "@tauri-apps/api/core";

/**
 * Anonymous usage telemetry.
 *
 * Events are sent by the self-hosted Aptabase instance via the
 * `tauri-plugin-aptabase` Rust command (`plugin:aptabase|track_event`). We call
 * that command directly with the app's own Tauri v2 `invoke` rather than the
 * `@aptabase/tauri` npm package — that package is Tauri v1 (it imports `invoke`
 * from the old top-level `@tauri-apps/api` and its v1 IPC transport cannot reach
 * a v2 backend). System props (OS name/version, app version, locale, ephemeral
 * session id) are attached in Rust; the payload here is just an event name plus
 * optional string/number props. Never pass PII (titles, paths, ids that map to
 * a person, free text) — enum-like values and counts only.
 *
 * Consent: telemetry defaults on (opt-out) and is gated by the user's
 * `telemetryEnabled` setting. App.tsx mirrors that setting into this module via
 * `setTelemetryEnabled` on startup and whenever the Settings toggle changes, so
 * individual call sites stay ignorant of the store.
 */

type TelemetryProps = Record<string, string | number>;

// Mirror of the user's `telemetryEnabled` setting (default on / opt-out).
let enabled = true;

export function setTelemetryEnabled(value: boolean): void {
  enabled = value;
}

let warnedOnce = false;

export function track(event: string, props?: TelemetryProps): void {
  if (!enabled) return;
  // Fire-and-forget: telemetry failures — opt-out mid-flight, no APTABASE_APP_KEY
  // baked in (command unregistered), a missing capability grant, offline, or the
  // self-hosted instance being down — must never surface to the user or break a
  // flow. But log the FIRST failure once (never per-event): a fully silent catch
  // here previously masked a denied `aptabase:allow-track-event` capability for
  // a long time.
  invoke("plugin:aptabase|track_event", { name: event, props: props ?? null }).catch((e) => {
    if (!warnedOnce) {
      warnedOnce = true;
      console.error("Telemetry send failed (further errors suppressed):", e);
    }
  });
}

/**
 * Bucket a count into a coarse, low-cardinality label. Keeps telemetry
 * anonymous (exact library sizes could be near-identifying) and keeps the
 * ClickHouse column low-cardinality. Used for library size, scan deltas, etc.
 */
export function bucketCount(n: number): string {
  if (n <= 0) return "0";
  if (n < 100) return "1-99";
  if (n < 1000) return "100-999";
  if (n < 10000) return "1k-10k";
  if (n < 50000) return "10k-50k";
  return "50k+";
}

/**
 * Classify a track path into a coarse source type (low-cardinality, no PII).
 * `file://` → "local", `http(s)://` → "web", other schemes pass through by
 * name (subsonic, custom plugin schemes). Used for track_played / error events.
 */
export function sourceClass(path: string | null): string {
  if (!path) return "none";
  const scheme = path.split("://")[0] || "none";
  if (scheme === "file") return "local";
  if (scheme === "http" || scheme === "https") return "web";
  return scheme;
}
