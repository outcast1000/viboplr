// Local lyrics (issue #131): embedded tag lyrics, a sidecar `.lrc`/`.txt`
// named like the audio file, or the same inside a `Lyrics/` subfolder — read
// live by the backend (`get_local_lyrics`). This is the fetch behind the
// built-in `core:local-lyrics` provider row in the lyrics chain (answered in
// usePlugins.invokeInfoFetch), seeded ahead of the web plugins by DB
// migration #13. Its answers ride the ordinary info-value cache — which is
// what makes local lyrics reachable by the lyrics full-text search
// (`search_information_values`) — but expire after a day instead of the web
// TTL (`cacheTtlForRow` in infoFetchChain.ts), since the answer can change on
// the user's own disk.
import { invoke } from "@tauri-apps/api/core";
import type { InfoEntity } from "../types/informationTypes";

interface LocalLyricsRow {
  text: string;
  kind: "plain" | "synced";
  source: "embedded" | "sidecar" | "folder";
}

/** Provider attribution shown under the lyrics section, naming which local
 *  probe answered rather than a generic "Local". */
export function localLyricsProviderName(source: LocalLyricsRow["source"]): string {
  switch (source) {
    case "embedded": return "Embedded in file";
    case "sidecar": return "Lyrics file";
    case "folder": return "Lyrics folder";
  }
}

/** LyricsData-shaped value for the lyrics renderers, or null when the track
 *  has no local lyrics. `local: true` marks it for surfaces that treat a
 *  file-backed value differently — the in-app editor hides, because an edit
 *  saved to the cache would be overwritten by the next re-probe of the file
 *  it can't change. */
export async function fetchLocalLyrics(
  entity: Pick<InfoEntity, "kind" | "name" | "artistName" | "albumTitle">,
  path?: string | null,
): Promise<Record<string, unknown> | null> {
  if (entity.kind !== "track" || !entity.name) return null;
  try {
    const found = await invoke<LocalLyricsRow | null>("get_local_lyrics", {
      title: entity.name,
      artistName: entity.artistName || null,
      albumName: entity.albumTitle || null,
      path: path ?? null,
    });
    if (!found?.text) return null;
    return {
      text: found.text,
      kind: found.kind,
      local: true,
      _meta: { providerName: localLyricsProviderName(found.source) },
    };
  } catch (e) {
    console.error("Failed to read local lyrics:", e);
    return null;
  }
}
