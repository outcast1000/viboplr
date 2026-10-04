import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { QueueTrack } from "../types";
import { sameCueSong, type CueSheetRow } from "../utils/cueSheet";
import { subscribe } from "../utils/tauriEvents";

/**
 * The cue sheet for the playing track (`cue_sheets.rs`), or null. Reads
 * once per song and again whenever `cue-sheet-changed` names it — which is how
 * a sheet an assistant writes mid-song lands on screen without a replay.
 * `enabled` gates the read to while a Now Playing surface is up.
 */
export function useCueSheet(track: QueueTrack | null, enabled: boolean): CueSheetRow | null {
  const title = enabled ? track?.title ?? "" : "";
  const artistName = enabled ? track?.artist_name ?? null : null;
  // The result is stamped with the song it describes, so the one render after
  // a track change can't show the previous song's cues (no reset effect).
  const [loaded, setLoaded] = useState<{ song: string; row: CueSheetRow | null } | null>(null);
  const [revision, setRevision] = useState(0);
  const songKey = title ? `${artistName ?? ""}\u0000${title}` : "";

  useEffect(() => {
    if (!title) return;
    return subscribe<{ title: string; artistName: string | null }>("cue-sheet-changed", (e) => {
      if (sameCueSong(e.payload, { title, artistName })) setRevision((r) => r + 1);
    });
  }, [title, artistName]);

  useEffect(() => {
    if (!title) return;
    let cancelled = false;
    invoke<CueSheetRow | null>("cue_sheet_get", { title, artistName })
      .then((row) => { if (!cancelled) setLoaded({ song: songKey, row }); })
      .catch((e) => console.error("Failed to load cue sheet:", e));
    return () => { cancelled = true; };
  }, [title, artistName, songKey, revision]);

  return loaded && loaded.song === songKey ? loaded.row : null;
}
