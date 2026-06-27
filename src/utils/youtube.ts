import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

/**
 * Canonical "Find in YouTube" action (see conventions.md → "Find in YouTube").
 * Resolves a video via the backend `search_youtube` matcher and opens it; on
 * failure, falls back to opening the manual YouTube search-results page.
 *
 * Every entry point must call this — do NOT reimplement the search/open logic.
 * There is no per-track YouTube URL storage; every invocation searches fresh.
 */
export async function watchOnYoutube(
  title: string,
  artistName: string | null,
  durationSecs: number | null = null,
): Promise<void> {
  try {
    const result = await invoke<{ url: string; video_title: string | null }>(
      "search_youtube",
      { title, artistName, durationSecs },
    );
    await openUrl(result.url);
  } catch (e) {
    console.error("YouTube search failed, falling back to search page:", e);
    const q = encodeURIComponent(`${title} ${artistName ?? ""}`);
    await openUrl(`https://www.youtube.com/results?search_query=${q}`);
  }
}
