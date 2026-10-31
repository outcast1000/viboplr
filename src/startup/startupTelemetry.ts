// The startup heartbeat + one-time install event (anonymous usage telemetry;
// see telemetry.ts). Fire-and-forget: never blocks startup. All props are
// anonymous and low-cardinality (bucketed library size, small counts, release
// channel).
import { invoke } from "@tauri-apps/api/core";
import { store } from "../store";
import { track, bucketCount } from "../telemetry";
import { probeEngineCapabilities } from "../playback/nativeEngine";
import type { Collection } from "../types";

export async function reportStartupTelemetry(betaChannel: boolean): Promise<void> {
  // `probeEngineCapabilities()` is cached (the restore's own probe shares this
  // promise), so this costs no second `engine_capabilities` round-trip.
  // Each read is optional: a failed one only drops its prop from the event.
  const [trackCount, cols, enabledPlugins, installReported, caps] = await Promise.all([
    invoke<number>("get_track_count").catch(() => null),
    invoke<Collection[]>("get_collections").catch(() => null),
    store.get<string[]>("enabledPlugins").catch(() => null),
    store.get<boolean>("telemetryInstallReported").catch(() => null),
    probeEngineCapabilities(),
  ]);
  // There is one build and it always bundles libmpv, so there is no flavor to
  // report — `mpv_capable` is the only thing that actually varies per machine.
  track("app_started", {
    channel: betaChannel ? "beta" : "stable",
    mpv_capable: caps.mpv ? "yes" : "no",
    mpv_video: caps.video ? "yes" : "no",
    ...(trackCount != null ? { tracks_bucket: bucketCount(trackCount) } : {}),
    ...(cols ? { collections: cols.length } : {}),
    ...(enabledPlugins ? { plugins_enabled: enabledPlugins.length } : {}),
  });
  if (!installReported) {
    track("app_installed");
    store.set("telemetryInstallReported", true).catch((e) =>
      console.error("Failed to persist telemetryInstallReported:", e));
  }
}
