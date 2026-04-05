import { useState, useEffect, useRef, useCallback } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Track } from "../types";
import type { SearchProviderConfig } from "../searchProviders";
import { getProvidersForContext, buildSearchUrl } from "../searchProviders";
import { IconPlay, IconEnqueue, IconFolder, IconInfo, IconGlobe } from "./Icons";
import LyricsPanel from "./LyricsPanel";

function displayPath(path: string): string {
  if (path.startsWith("subsonic://") || path.startsWith("tidal://")) return path;
  const sep = path.includes("\\") ? "\\" : "/";
  return path.split(sep).pop() ?? path;
}

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

interface SectionToggle {
  key: string;
  label: string;
  visible: boolean;
}

// --- TrackActions dropdown (modeled after ImageActions) ---

function TrackActions({
  track, providers, sectionToggles,
  onPlay, onEnqueue, onPlayNext, onShowInFolder, onShowProperties, onToggleSection,
}: {
  track: Track;
  providers: SearchProviderConfig[];
  sectionToggles: SectionToggle[];
  onPlay: () => void;
  onEnqueue: () => void;
  onPlayNext: () => void;
  onShowInFolder: () => void;
  onShowProperties: () => void;
  onToggleSection: (key: string) => void;
}) {
  const [open_menu, setOpenMenu] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open_menu) return;
    const handleClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpenMenu(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open_menu]);

  const trackProviders = getProvidersForContext(providers, "track");

  return (
    <div className="artist-image-menu-wrapper" ref={wrapperRef}>
      <button
        className="artist-image-menu-trigger"
        onClick={(e) => { e.stopPropagation(); setOpenMenu(v => !v); }}
        title="Options"
      >
        &#x22EF;
      </button>
      {open_menu && (
        <div className="artist-image-menu-dropdown">
          <button onClick={() => { setOpenMenu(false); onPlay(); }}>
            <IconPlay size={14} /><span>Play</span>
          </button>
          <button onClick={() => { setOpenMenu(false); onEnqueue(); }}>
            <IconEnqueue size={14} /><span>Add to Queue</span>
          </button>
          <button onClick={() => { setOpenMenu(false); onPlayNext(); }}>
            <IconEnqueue size={14} /><span>Play Next</span>
          </button>
          <div className="artist-image-menu-separator" />
          {!track.path.startsWith("subsonic://") && !track.path.startsWith("tidal://") && (
            <button onClick={() => { setOpenMenu(false); onShowInFolder(); }}>
              <IconFolder size={14} /><span>Show in Folder</span>
            </button>
          )}
          <button onClick={() => { setOpenMenu(false); onShowProperties(); }}>
            <IconInfo size={14} /><span>Properties</span>
          </button>
          {trackProviders.length > 0 && (
            <>
              <div className="artist-image-menu-separator" />
              <div className="artist-image-menu-submenu">
                <button className="artist-image-menu-submenu-trigger">
                  <IconGlobe size={14} /><span>Web Search</span><span className="artist-image-menu-chevron">{"\u203A"}</span>
                </button>
                <div className="artist-image-menu-submenu-list">
                  {trackProviders.map((provider) => {
                    const template = provider.trackUrl!;
                    const url = buildSearchUrl(template, { title: track.title, artist: track.artist_name ?? undefined });
                    return (
                      <button key={provider.id} onClick={() => { setOpenMenu(false); openUrl(url); }}>
                        <span>{provider.name}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </>
          )}
          {sectionToggles.length > 0 && (
            <>
              <div className="artist-image-menu-separator" />
              <div className="artist-image-menu-submenu">
                <button className="artist-image-menu-submenu-trigger">
                  <span>Sections</span><span className="artist-image-menu-chevron">{"\u203A"}</span>
                </button>
                <div className="artist-image-menu-submenu-list">
                  {sectionToggles.map((toggle) => (
                    <button key={toggle.key} onClick={() => onToggleSection(toggle.key)}>
                      <span className="section-toggle-check">{toggle.visible ? "\u2713" : ""}</span>
                      <span>{toggle.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// --- TrackDetailView ---

interface TrackDetailViewProps {
  trackId: number;
  track: Track;
  albumImagePath: string | null;
  positionSecs: number;
  isCurrentTrack: boolean;
  sections: Record<string, boolean>;
  onToggleSection: (key: string) => void;
  onArtistClick: (artistId: number) => void;
  onAlbumClick: (albumId: number, artistId?: number | null) => void;
  onTagClick: (tagId: number) => void;
  onPlay: () => void;
  onEnqueue: () => void;
  onPlayNext: () => void;
  onShowInFolder: () => void;
  onShowProperties: () => void;
  providers: SearchProviderConfig[];
  addLog: (msg: string) => void;
}

export function TrackDetailView({
  trackId, track, albumImagePath,
  positionSecs, isCurrentTrack,
  sections, onToggleSection, onArtistClick, onAlbumClick, onTagClick,
  onPlay, onEnqueue, onPlayNext, onShowInFolder, onShowProperties,
  providers, addLog,
}: TrackDetailViewProps) {
  const [lyrics, setLyrics] = useState<{ text: string; kind: string; provider: string } | null>(null);
  const [lyricsLoading, setLyricsLoading] = useState(false);
  const [trackTags, setTrackTags] = useState<Array<{ id: number; name: string }>>([]);
  const [communityTags, setCommunityTags] = useState<Array<{ name: string; count?: number }>>([]);
  const [playStats, setPlayStats] = useState<TrackPlayStats | null>(null);
  const [playHistory, setPlayHistory] = useState<Array<{ played_at: number }>>([]);
  const [similarTracks, setSimilarTracks] = useState<Array<{ name: string; artist: { name: string }; match?: string }>>([]);
  const [audioProps, setAudioProps] = useState<{ sample_rate?: number; bit_depth?: number; channels?: number; bitrate?: number } | null>(null);
  const [trackInfo, setTrackInfo] = useState<{ listeners?: string; playcount?: string; toptags?: Array<{ name: string }> } | null>(null);
  const [geniusExplanation, setGeniusExplanation] = useState<{
    about?: string;
    annotations: { fragment: string; explanation: string }[];
    song_url: string;
  } | null>(null);
  const [geniusLoading, setGeniusLoading] = useState(false);
  const trackIdRef = useRef(trackId);

  useEffect(() => { trackIdRef.current = trackId; }, [trackId]);

  // Fetch all data when trackId changes
  useEffect(() => {
    setLyrics(null);
    setLyricsLoading(true);
    setTrackTags([]);
    setCommunityTags([]);
    setPlayStats(null);
    setPlayHistory([]);
    setSimilarTracks([]);
    setAudioProps(null);
    setTrackInfo(null);
    setGeniusExplanation(null);
    setGeniusLoading(false);

    invoke<{ track_id: number; text: string; kind: string; provider: string } | null>("get_lyrics", { trackId }).then(cached => {
      if (cached) {
        setLyrics({ text: cached.text, kind: cached.kind, provider: cached.provider });
        setLyricsLoading(false);
      } else {
        invoke("fetch_lyrics", { trackId, force: false }).catch(() => setLyricsLoading(false));
      }
    }).catch(() => {
      invoke("fetch_lyrics", { trackId, force: false }).catch(() => setLyricsLoading(false));
    });
    invoke<Array<{ id: number; name: string }>>("get_tags_for_track", { trackId }).then(setTrackTags).catch(() => {});
    invoke<TrackPlayStats | null>("get_track_play_stats", { trackId }).then(s => { if (s) setPlayStats(s); }).catch(() => {});
    invoke<Array<{ played_at: number }>>("get_track_play_history", { trackId, limit: 50 }).then(setPlayHistory).catch(() => {});
    invoke<{ sample_rate?: number; bit_depth?: number; channels?: number; bitrate?: number }>("get_track_audio_properties", { trackId })
      .then(setAudioProps).catch(() => {});

    if (track.artist_name) {
      invoke("lastfm_get_track_tags", { artistName: track.artist_name, trackTitle: track.title }).catch(() => {});
      invoke("lastfm_get_similar_tracks", { artistName: track.artist_name, trackTitle: track.title }).catch(() => {});
      if (sections.geniusExplanations !== false) {
        setGeniusLoading(true);
        invoke<any>("get_genius_explanation", { artistName: track.artist_name, trackTitle: track.title })
          .then(cached => {
            if (cached) {
              setGeniusExplanation(cached);
              setGeniusLoading(false);
            } else {
              // No cache — backend spawns async fetch. Fallback timeout in case
              // the event is missed (listener race) or backend errors silently.
              setTimeout(() => setGeniusLoading(false), 15000);
            }
          })
          .catch(() => setGeniusLoading(false));
      }
      const parseTrackInfo = (resp: any) => {
        const t = resp?.track;
        if (!t) return;
        setTrackInfo({
          listeners: t.listeners,
          playcount: t.playcount,
          toptags: Array.isArray(t.toptags?.tag) ? t.toptags.tag : [],
        });
      };
      invoke<any>("lastfm_get_track_info", { artistName: track.artist_name, trackTitle: track.title })
        .then(resp => { if (resp) parseTrackInfo(resp); })
        .catch(() => {});
    }
  }, [trackId, track.artist_name, track.title]);

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
    const unlistenTrackInfo = listen<any>("lastfm-track-info", (event) => {
      const t = event.payload?.track;
      if (!t) return;
      setTrackInfo({
        listeners: t.listeners,
        playcount: t.playcount,
        toptags: Array.isArray(t.toptags?.tag) ? t.toptags.tag : [],
      });
    });
    const unlistenGenius = listen<any>("genius-explanation", (event) => {
      if (event.payload) {
        setGeniusExplanation(event.payload);
        setGeniusLoading(false);
      }
    });
    return () => {
      unlistenLyrics.then(f => f());
      unlistenLyricsErr.then(f => f());
      unlistenSimilar.then(f => f());
      unlistenTags.then(f => f());
      unlistenTrackInfo.then(f => f());
      unlistenGenius.then(f => f());
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
      {/* Header — art + info + play button + options menu */}
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
            <h2>
              {track.title}
              <button className="artist-play-btn" title="Play" onClick={onPlay}>&#9654;</button>
              <TrackActions
                track={track}
                providers={providers}
                sectionToggles={[
                  { key: "lyrics", label: "Lyrics", visible: sections.lyrics !== false },
                  { key: "tags", label: "Tags", visible: sections.tags !== false },
                  { key: "scrobbleHistory", label: "Play History", visible: sections.scrobbleHistory !== false },
                  { key: "similar", label: "Similar Tracks", visible: sections.similar !== false },
                  { key: "geniusExplanations", label: "Song Explanation", visible: sections.geniusExplanations !== false },
                ]}
                onPlay={onPlay}
                onEnqueue={onEnqueue}
                onPlayNext={onPlayNext}
                onShowInFolder={onShowInFolder}
                onShowProperties={onShowProperties}
                onToggleSection={onToggleSection}
              />
            </h2>
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
              {audioProps?.bitrate && <> &middot; {audioProps.bitrate} kbps</>}
              {audioProps?.sample_rate && <> &middot; {(audioProps.sample_rate / 1000).toFixed(1)} kHz</>}
              {audioProps?.bit_depth && <> &middot; {audioProps.bit_depth}-bit</>}
            </div>
            {(playStats || trackInfo) && (
              <div className="track-detail-stats">
                {playStats && <>{formatCount(playStats.play_count)} plays</>}
                {playStats?.last_played_at && <> &middot; Last played {relativeTime(playStats.last_played_at)}</>}
                {trackInfo?.listeners && <>{playStats ? <> &middot; </> : null}{parseInt(trackInfo.listeners).toLocaleString()} listeners</>}
                {trackInfo?.playcount && <> &middot; {parseInt(trackInfo.playcount).toLocaleString()} scrobbles</>}
              </div>
            )}
            <div className="track-detail-path" title={track.path}>{displayPath(track.path)}</div>
            {sections.tags !== false && (trackTags.length > 0 || filteredCommunityTags.length > 0 || (trackInfo?.toptags && trackInfo.toptags.length > 0)) && (
              <div className="track-detail-tags-inline">
                {trackTags.map(tag => (
                  <span key={tag.id} className="track-tag-chip" onClick={() => onTagClick(tag.id)}>{tag.name}</span>
                ))}
                {filteredCommunityTags.slice(0, 15).map(tag => (
                  <span key={tag.name} className="track-tag-chip track-tag-suggestion" onClick={() => handleApplyTag(tag.name)}>
                    + {tag.name}
                  </span>
                ))}
                {trackInfo?.toptags?.filter(t => !assignedTagNames.has(t.name.toLowerCase()) && !filteredCommunityTags.some(c => c.name.toLowerCase() === t.name.toLowerCase())).slice(0, 10).map(tag => (
                  <span key={`lfm-${tag.name}`} className="track-tag-chip track-tag-lastfm">{tag.name}</span>
                ))}
              </div>
            )}
          </div>
        </div>

        {sections.geniusExplanations !== false && (
          <div className="track-detail-genius">
            <div className="track-detail-section-title">
              Song Explanation
              {geniusExplanation?.song_url && (
                <a className="genius-link" onClick={() => openUrl(geniusExplanation.song_url)} title="View on Genius">
                  View on Genius &#x2197;
                </a>
              )}
            </div>
            {geniusLoading ? (
              <div className="track-detail-empty">Loading...</div>
            ) : geniusExplanation ? (
              <div className="genius-content">
                {geniusExplanation.about && (
                  <div className="genius-about">
                    <p>{geniusExplanation.about}</p>
                  </div>
                )}
                {geniusExplanation.annotations.length > 0 && (
                  <div className="genius-annotations">
                    {geniusExplanation.annotations.map((ann, i) => (
                      <div key={i} className="genius-annotation">
                        <div className="genius-annotation-fragment">{ann.fragment}</div>
                        <div className="genius-annotation-explanation">{ann.explanation}</div>
                      </div>
                    ))}
                  </div>
                )}
                {!geniusExplanation.about && geniusExplanation.annotations.length === 0 && (
                  <div className="track-detail-empty">No explanations available</div>
                )}
              </div>
            ) : (
              <div className="track-detail-empty">No Genius explanation found</div>
            )}
          </div>
        )}

        {sections.lyrics !== false && (
          <div className="track-detail-lyrics-section">
            <LyricsPanel
              trackId={trackId}
              artistName={track.artist_name ?? ""}
              title={track.title}
              positionSecs={isCurrentTrack ? positionSecs : 0}
              lyrics={lyrics}
              loading={lyricsLoading}
              onSave={handleSaveLyrics}
              onReset={handleResetLyrics}
              onForceRefresh={handleForceRefreshLyrics}
            />
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

        {sections.scrobbleHistory !== false && (
          <div className="track-detail-scrobbles">
            <div className="track-detail-section-title">
              Play History
              {playStats && <span className="track-detail-count"> ({formatCount(playStats.play_count)})</span>}
            </div>
            {playHistory.length > 0 ? (
              <div className="scrobble-list">
                {(() => {
                  const groups: { year: number; entries: typeof playHistory }[] = [];
                  for (const entry of playHistory) {
                    const year = new Date(entry.played_at * 1000).getFullYear();
                    const last = groups[groups.length - 1];
                    if (last && last.year === year) {
                      last.entries.push(entry);
                    } else {
                      groups.push({ year, entries: [entry] });
                    }
                  }
                  return groups.map(({ year, entries }) => (
                    <div key={year} className="scrobble-year-group">
                      <div className="scrobble-year-label">{year}</div>
                      {entries.map((entry, i) => (
                        <div key={i} className="scrobble-entry">
                          {formatTimestamp(entry.played_at)}
                        </div>
                      ))}
                    </div>
                  ));
                })()}
              </div>
            ) : (
              <div className="track-detail-empty">No play history</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
