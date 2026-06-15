import { useEffect, useMemo, useState } from "react";
import type { InfoEntity, InfoFetchResult } from "../types/informationTypes";
import { rankCommunityTags, type CommunityTagLike } from "../utils/tagSuggestions";

/** Cap on distinct-artist Last.fm fetches for a multi-track community lookup. */
const MAX_COMMUNITY_ARTISTS = 8;

export type InvokeInfoFetch = (
  pluginId: string,
  infoTypeId: string,
  entity: InfoEntity,
) => Promise<InfoFetchResult>;

interface TrackTagsValue {
  tags?: CommunityTagLike[];
  artistTags?: CommunityTagLike[];
}

/**
 * Fetches Last.fm community tags for a track via the `track_tags` information
 * type — the same fetch TrackDetailView uses — so every tag-editing surface
 * can suggest community tags, not just library tags.
 *
 * Returns the merged track-level + artist-level tag names (track tags first,
 * which are more specific). De-duplication against the surface's existing pool
 * is left to `appendCommunityTags` at the call site.
 *
 * - `enabled` gates the network call (e.g. only while a popover is open).
 * - `includeTrackTags = false` returns artist-level tags only — used by
 *   multi-track bulk edits where a single track's tags don't represent the
 *   whole selection, but a shared artist's tags do.
 *
 * Degrades gracefully to `[]` when the Last.fm plugin is absent, when
 * `invokeInfoFetch` is undefined, or when there is no artist to query.
 */
export function useCommunityTags(opts: {
  title: string | null | undefined;
  artistName: string | null | undefined;
  invokeInfoFetch: InvokeInfoFetch | undefined;
  enabled?: boolean;
  includeTrackTags?: boolean;
}): CommunityTagLike[] {
  const {
    title,
    artistName,
    invokeInfoFetch,
    enabled = true,
    includeTrackTags = true,
  } = opts;
  const [tags, setTags] = useState<CommunityTagLike[]>([]);

  useEffect(() => {
    if (!enabled || !invokeInfoFetch || !title || !artistName) {
      setTags([]);
      return;
    }
    let cancelled = false;
    const entity: InfoEntity = { kind: "track", name: title, id: 0, artistName };
    invokeInfoFetch("lastfm", "track_tags", entity)
      .then((result) => {
        if (cancelled) return;
        if (result.status !== "ok") {
          setTags([]);
          return;
        }
        const val = result.value as TrackTagsValue;
        const trackTags = includeTrackTags ? val.tags ?? [] : [];
        const artistTags = val.artistTags ?? [];
        setTags([...trackTags, ...artistTags]);
      })
      .catch((e) => {
        if (cancelled) return;
        console.error("Failed to load community tags:", e);
        setTags([]);
      });
    return () => {
      cancelled = true;
    };
  }, [title, artistName, invokeInfoFetch, enabled, includeTrackTags]);

  return tags;
}

interface TrackLike {
  title?: string | null;
  artist_name?: string | null;
}

/**
 * Community tags for a *set* of tracks (e.g. a Bulk Edit selection). Fetches
 * `track_tags` once per distinct artist (capped at MAX_COMMUNITY_ARTISTS, using
 * the first track seen for each artist as the representative) and aggregates the
 * artist-level tags, ranked by how many of the selection's artists share each
 * tag — so common genres surface for mixed-artist selections instead of showing
 * nothing. For a single-track selection, that track's track-level tags are
 * included too. Degrades to `[]` when the Last.fm plugin / `invokeInfoFetch`
 * is absent or no track carries an artist.
 */
export function useCommunityTagsForTracks(opts: {
  tracks: TrackLike[];
  invokeInfoFetch: InvokeInfoFetch | undefined;
  enabled?: boolean;
}): CommunityTagLike[] {
  const { tracks, invokeInfoFetch, enabled = true } = opts;
  const singleTrack = tracks.length === 1;

  // First track per distinct artist, capped — these are the representatives we
  // query Last.fm with (track.getTopTags needs a title; we keep its artistTags).
  const reps = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ title: string; artistName: string }> = [];
    for (const t of tracks) {
      const artistName = (t.artist_name ?? "").trim();
      const title = (t.title ?? "").trim();
      if (!artistName || !title) continue;
      const key = artistName.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ title, artistName });
      if (out.length >= MAX_COMMUNITY_ARTISTS) break;
    }
    return out;
  }, [tracks]);
  // Stable primitive dependency so the effect doesn't re-fire on array identity.
  const repsKey = reps.map((r) => r.artistName.toLowerCase()).join("|");

  const [tags, setTags] = useState<CommunityTagLike[]>([]);

  useEffect(() => {
    if (!enabled || !invokeInfoFetch || reps.length === 0) {
      setTags([]);
      return;
    }
    let cancelled = false;
    Promise.all(
      reps.map((r) =>
        invokeInfoFetch("lastfm", "track_tags", {
          kind: "track",
          name: r.title,
          id: 0,
          artistName: r.artistName,
        })
          .then((res) => (res.status === "ok" ? (res.value as TrackTagsValue) : null))
          .catch((e) => {
            console.error("Failed to load community tags:", e);
            return null;
          }),
      ),
    ).then((results) => {
      if (cancelled) return;
      const lists: CommunityTagLike[][] = [];
      for (const val of results) {
        if (!val) continue;
        const artistTags = val.artistTags ?? [];
        lists.push(singleTrack ? [...(val.tags ?? []), ...artistTags] : artistTags);
      }
      setTags(rankCommunityTags(lists));
    });
    return () => {
      cancelled = true;
    };
    // repsKey captures the representative set; singleTrack changes the merge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repsKey, singleTrack, invokeInfoFetch, enabled]);

  return tags;
}
