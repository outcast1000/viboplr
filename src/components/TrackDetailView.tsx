import { useState, useEffect, useRef, useCallback } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Track, Tag } from "../types";
import LyricsPanel from "./LyricsPanel";

function formatCount(n: number): string {
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    if (v >= 100) return `${Math.round(v)}M`;
    if (v >= 10) return `${v.toFixed(1).replace(/\.0$/, "")}M`;
    return `${v.toFixed(2).replace(/\.?0+$/, "")}M`;
  }
  if (n >= 1_000) {
    const v = n / 1_000;
    if (v >= 100) return `${Math.round(v)}K`;
    if (v >= 10) return `${v.toFixed(1).replace(/\.0$/, "")}K`;
    return `${v.toFixed(2).replace(/\.?0+$/, "")}K`;
  }
  return String(n);
}

function formatDuration(secs: number | null): string {
  if (secs == null || secs <= 0) return "";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) +
    " " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function relativeTime(ts: number): string {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)}d ago`;
  return formatTimestamp(ts);
}

interface TrackPlayStats {
  play_count: number;
  first_played_at: number | null;
  last_played_at: number | null;
}

interface TrackDetailViewProps {
  trackId: number;
  track: Track;
  albumImagePath: string | null;
  positionSecs: number;
  playing: boolean;
  isCurrentTrack: boolean;
  sections: Record<string, boolean>;
  onToggleSection: (key: string) => void;
  onArtistClick: (artistId: number) => void;
  onAlbumClick: (albumId: number, artistId?: number | null) => void;
  onTagClick: (tagId: number) => void;
  onPlay: () => void;
  onEnqueue: () => void;
  libraryTags: Tag[];
  addLog: (msg: string) => void;
}

export function TrackDetailView({
  trackId, track, albumImagePath,
  positionSecs, isCurrentTrack,
  sections, onArtistClick, onAlbumClick, onTagClick,
  onPlay, onEnqueue, addLog,
}: TrackDetailViewProps) {
  const [lyrics, setLyrics] = useState<{ text: string; kind: string; provider: string } | null>(null);
  const [lyricsLoading, setLyricsLoading] = useState(false);
  const [trackTags, setTrackTags] = useState<Array<{ id: number; name: string }>>([]);
  const [communityTags, setCommunityTags] = useState<Array<{ name: string; count?: number }>>([]);
  const [playStats, setPlayStats] = useState<TrackPlayStats | null>(null);
  const [playHistory, setPlayHistory] = useState<Array<{ played_at: number }>>([]);
  const [similarTracks, setSimilarTracks] = useState<Array<{ name: string; artist: { name: string }; match?: string }>>([]);
  const trackIdRef = useRef(trackId);

  useEffect(() => { trackIdRef.current = trackId; }, [trackId]);

  // Fetch all data when trackId changes
  useEffect(() => {
    // Reset state
    setLyrics(null);
    setLyricsLoading(true);
    setTrackTags([]);
    setCommunityTags([]);
    setPlayStats(null);
    setPlayHistory([]);
    setSimilarTracks([]);

    // Lyrics
    invoke("fetch_lyrics", { trackId, force: false }).catch(() => setLyricsLoading(false));

    // Library tags for this track
    invoke<Array<{ id: number; name: string }>>("get_tags_for_track", { trackId }).then(setTrackTags).catch(() => {});

    // Play stats & history
    invoke<TrackPlayStats | null>("get_track_play_stats", { trackId }).then(s => { if (s) setPlayStats(s); }).catch(() => {});
    invoke<Array<{ played_at: number }>>("get_track_play_history", { trackId, limit: 50 }).then(setPlayHistory).catch(() => {});

    // Last.fm data (track tags + similar tracks)
    if (track.artist_name) {
      invoke("lastfm_get_track_tags", { artistName: track.artist_name, trackTitle: track.title }).catch(() => {});
      invoke("lastfm_get_similar_tracks", { artistName: track.artist_name, trackTitle: track.title }).catch(() => {});
    }
  }, [trackId, track.artist_name, track.title]);

  // Event listeners for async results
  useEffect(() => {
    const unlistenLyrics = listen<{ track_id: number; text: string; kind: string; provider: string }>("lyrics-loaded", (event) => {
      if (event.payload.track_id === trackIdRef.current) {
        setLyrics({ text: event.payload.text, kind: event.payload.kind, provider: event.payload.provider });
        setLyricsLoading(false);
      }
    });
    const unlistenLyricsErr = listen<{ track_id: number }>("lyrics-error", (event) => {
      if (event.payload.track_id === trackIdRef.current) setLyricsLoading(false);
    });
    const unlistenSimilar = listen<any>("lastfm-similar-tracks", (event) => {
      const tracks = event.payload?.similartracks?.track;
      if (Array.isArray(tracks)) setSimilarTracks(tracks);
    });
    const unlistenTags = listen<any>("lastfm-track-tags", (event) => {
      const tags = event.payload?.toptags?.tag;
      if (Array.isArray(tags)) setCommunityTags(tags);
    });
    return () => {
      unlistenLyrics.then(f => f());
      unlistenLyricsErr.then(f => f());
      unlistenSimilar.then(f => f());
      unlistenTags.then(f => f());
    };
  }, []);

  const handleSaveLyrics = useCallback(async (text: string, kind: string) => {
    try {
      const result = await invoke<{ text: string; kind: string; provider: string }>("save_manual_lyrics", { trackId, text, kind });
      setLyrics(result);
    } catch (e) { console.error("Failed to save lyrics:", e); }
  }, [trackId]);

  const handleResetLyrics = useCallback(() => {
    setLyrics(null);
    setLyricsLoading(true);
    invoke("reset_lyrics", { trackId }).catch(() => setLyricsLoading(false));
  }, [trackId]);

  const handleForceRefreshLyrics = useCallback(() => {
    setLyrics(null);
    setLyricsLoading(true);
    invoke("fetch_lyrics", { trackId, force: true }).catch(() => setLyricsLoading(false));
  }, [trackId]);

  const handleApplyTag = useCallback(async (tagName: string) => {
    try {
      const result = await invoke<Array<[number, string]>>("lastfm_apply_community_tags", { trackId, tagNames: [tagName] });
      if (result.length > 0) {
        setTrackTags(prev => [...prev, ...result.map(([id, name]) => ({ id, name }))]);
        setCommunityTags(prev => prev.filter(t => t.name.toLowerCase() !== tagName.toLowerCase()));
        addLog(`Applied tag "${tagName}"`);
      }
    } catch (e) { console.error("Failed to apply tag:", e); }
  }, [trackId, addLog]);

  const assignedTagNames = new Set(trackTags.map(t => t.name.toLowerCase()));
  const filteredCommunityTags = communityTags.filter(t => !assignedTagNames.has(t.name.toLowerCase()));

  return (
    <div className="track-detail">
      <div className="track-detail-top">
        <div className="track-detail-header">
          <div className="track-detail-art">
            {albumImagePath ? (
              <img className="track-detail-art-img" src={convertFileSrc(albumImagePath)} alt={track.album_title ?? ""} />
            ) : (
              <svg className="track-detail-art-placeholder" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            )}
          </div>
          <div className="track-detail-info">
            <h2>{track.title}</h2>
            <div className="track-detail-meta">
              {track.artist_name && (
                <span className="track-detail-link" onClick={() => track.artist_id && onArtistClick(track.artist_id)}>
                  {track.artist_name}
                </span>
              )}
              {track.album_title && (
                <>
                  <span className="track-detail-sep"> — </span>
                  <span className="track-detail-link" onClick={() => track.album_id && onAlbumClick(track.album_id, track.artist_id)}>
                    {track.album_title}
                  </span>
                </>
              )}
              {track.year && <span className="track-detail-sep"> ({track.year})</span>}
            </div>
            <div className="track-detail-stats">
              {formatDuration(track.duration_secs)}
              {track.format && <> &middot; {track.format.toUpperCase()}</>}
            </div>
            {playStats && (
              <div className="track-detail-stats">
                {formatCount(playStats.play_count)} plays
                {playStats.last_played_at && <> &middot; Last played {relativeTime(playStats.last_played_at)}</>}
              </div>
            )}
            <div className="track-detail-actions">
              <button className="action-btn" onClick={onPlay}>Play</button>
              <button className="action-btn action-btn-secondary" onClick={onEnqueue}>Enqueue</button>
            </div>
          </div>
        </div>
      </div>

      <div className="track-detail-sections">
        {sections.lyrics !== false && (
          <div className="track-detail-lyrics">
            <div className="track-detail-section-title">Lyrics</div>
            <LyricsPanel
              trackId={trackId}
              positionSecs={isCurrentTrack ? positionSecs : 0}
              lyrics={lyrics}
              loading={lyricsLoading}
              onSave={handleSaveLyrics}
              onReset={handleResetLyrics}
              onForceRefresh={handleForceRefreshLyrics}
            />
          </div>
        )}

        {sections.tags !== false && (
          <div className="track-detail-tags">
            <div className="track-detail-section-title">Tags</div>
            {trackTags.length > 0 && (
              <div className="track-tag-chips">
                {trackTags.map(tag => (
                  <span key={tag.id} className="track-tag-chip" onClick={() => onTagClick(tag.id)}>{tag.name}</span>
                ))}
              </div>
            )}
            {filteredCommunityTags.length > 0 && (
              <>
                <div className="track-detail-sublabel">Suggested</div>
                <div className="track-tag-chips">
                  {filteredCommunityTags.slice(0, 15).map(tag => (
                    <span key={tag.name} className="track-tag-chip track-tag-suggestion" onClick={() => handleApplyTag(tag.name)}>
                      + {tag.name}
                    </span>
                  ))}
                </div>
              </>
            )}
            {trackTags.length === 0 && filteredCommunityTags.length === 0 && !track.artist_name && (
              <div className="track-detail-empty">No tags</div>
            )}
          </div>
        )}

        {sections.scrobbleHistory !== false && (
          <div className="track-detail-scrobbles">
            <div className="track-detail-section-title">
              Play History
              {playStats && <span className="track-detail-count"> ({formatCount(playStats.play_count)})</span>}
            </div>
            {playHistory.length > 0 ? (
              <div className="scrobble-list">
                {playHistory.map((entry, i) => (
                  <div key={i} className="scrobble-entry">
                    {formatTimestamp(entry.played_at)}
                  </div>
                ))}
              </div>
            ) : (
              <div className="track-detail-empty">No play history</div>
            )}
          </div>
        )}

        {sections.similar !== false && (
          <div className="track-detail-similar">
            <div className="track-detail-section-title">Similar Tracks</div>
            {similarTracks.length > 0 ? (
              <div className="similar-tracks-list">
                {similarTracks.slice(0, 20).map((st, i) => {
                  const matchPct = st.match ? Math.round(parseFloat(st.match) * 100) : null;
                  return (
                    <div key={i} className="similar-track-row">
                      <div className="similar-track-info">
                        <span className="similar-track-name">{st.name}</span>
                        <span className="similar-track-artist">{st.artist.name}</span>
                      </div>
                      {matchPct != null && <span className="similar-track-match">{matchPct}%</span>}
                      <button className="similar-track-yt" title="Watch on YouTube" onClick={async () => {
                        const q = encodeURIComponent(`${st.name} ${st.artist.name}`);
                        await openUrl(`https://www.youtube.com/results?search_query=${q}`);
                      }}>&#9654;</button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="track-detail-empty">No similar tracks found</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
