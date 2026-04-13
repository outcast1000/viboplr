import { useState, useEffect, useRef, useCallback } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";

import { openUrl } from "@tauri-apps/plugin-opener";
import type { Track, Collection } from "../types";
import type { InfoEntity, InfoFetchResult } from "../types/informationTypes";
import { IconFolder, IconLastfm, IconYoutube } from "./Icons";
import { store } from "../store";

import { InformationSections } from "./InformationSections";
import "./TrackDetailView.css";

const DEFAULT_TAB_ORDER = ["song_meaning", "lyrics", "song_bio", "similar_tracks", "details", "play-history"];

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

// --- TrackDetailView ---

interface TrackDetailViewProps {
  trackId: number;
  track: Track;
  albumImagePath: string | null;
  artistImagePath: string | null;
  positionSecs: number;
  isCurrentTrack: boolean;
  onArtistClick: (artistId: number) => void;
  onAlbumClick: (albumId: number, artistId?: number | null) => void;
  onTagClick: (tagId: number) => void;
  onPlay: () => void;
  onShowInFolder: () => void;
  onPlayTrack: (track: Track) => void;
  onWatchOnYoutube: () => void;
  onToggleLike: () => void;
  onToggleHate: () => void;
  collections: Collection[];
  addLog: (msg: string) => void;
  onUpdateTrack: (update: Partial<Track>) => void;
  invokeInfoFetch: (pluginId: string, infoTypeId: string, entity: InfoEntity, onFetchUrl?: (url: string) => void) => Promise<InfoFetchResult>;
  pluginNames?: Map<string, string>;
  onInfoTrackContextMenu?: (e: React.MouseEvent, trackInfo: { trackId?: number; title: string; artistName: string | null }) => void;
}

export function TrackDetailView({
  trackId, track, albumImagePath, artistImagePath,
  positionSecs, isCurrentTrack,
  onArtistClick, onAlbumClick, onTagClick,
  onPlay, onShowInFolder, onPlayTrack, onWatchOnYoutube,
  onToggleLike, onToggleHate,
  collections: _collections, addLog, onUpdateTrack, invokeInfoFetch, pluginNames,
  onInfoTrackContextMenu,
}: TrackDetailViewProps) {
  const [trackTags, setTrackTags] = useState<Array<{ id: number; name: string }>>([]);
  const [communityTags, setCommunityTags] = useState<Array<{ name: string; count?: number }>>([]);
  const [artistTags, setArtistTags] = useState<Array<{ name: string; count?: number }>>([]);
  const [editingTags, setEditingTags] = useState(false);
  const [tagInput, setTagInput] = useState("");
  const [playStats, setPlayStats] = useState<TrackPlayStats | null>(null);
  const [playHistory, setPlayHistory] = useState<Array<{ played_at: number }>>([]);
  const [audioProps, setAudioProps] = useState<{ sample_rate?: number; bit_depth?: number; channels?: number; bitrate?: number } | null>(null);
  const [trackInfo, setTrackInfo] = useState<{ listeners?: string; playcount?: string; toptags?: Array<{ name: string }>; url?: string } | null>(null);
  const [youtubeUrlEdit, setYoutubeUrlEdit] = useState<string | null>(null);
  const [tabOrder, setTabOrder] = useState<string[]>(DEFAULT_TAB_ORDER);
  const trackIdRef = useRef(trackId);

  useEffect(() => { trackIdRef.current = trackId; }, [trackId]);

  // Load persisted tab order on mount
  useEffect(() => {
    store.get<string[]>("trackDetailTabOrder").then(saved => {
      if (saved && saved.length > 0) setTabOrder(saved);
    });
  }, []);

  const handleTabOrderChange = useCallback((order: string[]) => {
    setTabOrder(order);
    store.set("trackDetailTabOrder", order);
  }, []);

  // Fetch all data when trackId changes
  useEffect(() => {
    setTrackTags([]);
    setCommunityTags([]);
    setArtistTags([]);
    setEditingTags(false);
    setPlayStats(null);
    setPlayHistory([]);
    setAudioProps(null);
    setTrackInfo(null);
    setYoutubeUrlEdit(null);

    invoke<Array<{ id: number; name: string }>>("get_tags_for_track", { trackId }).then(setTrackTags).catch(e => console.error("Failed to load track tags:", e));
    invoke<TrackPlayStats | null>("get_track_play_stats", { trackId }).then(s => { if (s) setPlayStats(s); }).catch(e => console.error("Failed to load play stats:", e));
    invoke<Array<{ played_at: number }>>("get_track_play_history", { trackId, limit: 50 }).then(setPlayHistory).catch(e => console.error("Failed to load play history:", e));
    invoke<{ sample_rate?: number; bit_depth?: number; channels?: number; bitrate?: number }>("get_track_audio_properties", { trackId })
      .then(setAudioProps).catch(e => console.error("Failed to load audio properties:", e));

    if (track.artist_name) {
      const trackEntity: InfoEntity = { kind: "track", name: track.title, id: trackId, artistName: track.artist_name };
      // Fetch track tags + artist tags (combined in one info type)
      invokeInfoFetch("lastfm", "track_tags", trackEntity).then(result => {
        if (result.status !== "ok") return;
        const val = result.value as any;
        if (val?.tags?.length) setCommunityTags(val.tags);
        if (val?.artistTags?.length) setArtistTags(val.artistTags);
      }).catch(e => console.error("Failed to load community/artist tags:", e));
    }
  }, [trackId, track.artist_name, track.title, invokeInfoFetch]);

  // Receive track_info data from InformationSections (via onTitleData callback)
  const handleTitleData = useCallback((typeId: string, data: unknown) => {
    if (typeId !== "track_info") return;
    const val = data as Record<string, unknown>;
    if (!val) return;
    const items = val.items as Array<{ label: string; value: number }> | undefined;
    const info: { listeners?: string; playcount?: string; toptags?: Array<{ name: string }>; url?: string } = {};
    if (items) {
      for (const item of items) {
        if (item.label === "listeners") info.listeners = String(item.value);
        if (item.label === "scrobbles") info.playcount = String(item.value);
      }
    }
    if (val.toptags) info.toptags = val.toptags as Array<{ name: string }>;
    if (val.url) info.url = val.url as string;
    if (info.listeners || info.playcount) setTrackInfo(info);
  }, []);

  const handleApplyTag = useCallback(async (tagName: string) => {
    try {
      const result = await invoke<Array<[number, string]>>("plugin_apply_tags", { trackId, tagNames: [tagName] });
      if (result.length > 0) {
        setTrackTags(prev => [...prev, ...result.map(([id, name]) => ({ id, name }))]);
        setCommunityTags(prev => prev.filter(t => t.name.toLowerCase() !== tagName.toLowerCase()));
        addLog(`Applied tag "${tagName}"`);
      }
    } catch (e) { console.error("Failed to apply tag:", e); }
  }, [trackId, addLog]);

  const handleRemoveTag = useCallback(async (tagToRemove: { id: number; name: string }) => {
    const remaining = trackTags.filter(t => t.id !== tagToRemove.id).map(t => t.name);
    try {
      const result = await invoke<Array<[number, string]>>("replace_track_tags", { trackId, tagNames: remaining });
      setTrackTags(result.map(([id, name]) => ({ id, name })));
      addLog(`Removed tag "${tagToRemove.name}"`);
    } catch (e) { console.error("Failed to remove tag:", e); }
  }, [trackId, trackTags, addLog]);

  const handleStartEditTags = useCallback(() => {
    setTagInput(trackTags.map(t => t.name).join(", "));
    setEditingTags(true);
  }, [trackTags]);

  const handleSaveTags = useCallback(async () => {
    const tagNames = tagInput.split(",").map(s => s.trim()).filter(Boolean);
    try {
      const result = await invoke<Array<[number, string]>>("replace_track_tags", { trackId, tagNames });
      setTrackTags(result.map(([id, name]) => ({ id, name })));
      setEditingTags(false);
      addLog(`Updated tags`);
    } catch (e) { console.error("Failed to save tags:", e); }
  }, [trackId, tagInput, addLog]);

  const handleInfoAction = useCallback((actionId: string, payload?: unknown) => {
    if (actionId === "play-track") {
      const t = payload as Track | undefined;
      if (t) onPlayTrack(t);
    }
  }, [onPlayTrack]);

  const assignedTagNames = new Set(trackTags.map(t => t.name.toLowerCase()));

  const allCommunityTags = (() => {
    const seen = new Set<string>();
    const merged: Array<{ name: string }> = [];
    for (const t of communityTags) {
      const key = t.name.toLowerCase();
      if (!seen.has(key)) { seen.add(key); merged.push(t); }
    }
    for (const t of (trackInfo?.toptags ?? [])) {
      const key = t.name.toLowerCase();
      if (!seen.has(key)) { seen.add(key); merged.push(t); }
    }
    // Fall back to artist tags if no track-level community tags
    if (merged.length === 0) {
      for (const t of artistTags) {
        const key = t.name.toLowerCase();
        if (!seen.has(key)) { seen.add(key); merged.push(t); }
      }
    }
    return merged;
  })();

  return (
    <div className="track-detail">
      {/* Header — art + info + play button + options menu */}
      <div className="track-detail-top">
        <div className="track-detail-header">
          <div className="track-detail-art">
            {(albumImagePath || artistImagePath) ? (
              <img className="track-detail-art-img" src={convertFileSrc((albumImagePath ?? artistImagePath)!)} alt={track.album_title ?? track.artist_name ?? ""} />
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
              <button
                className={`detail-love-btn${track.liked === 1 ? " liked" : ""}`}
                title={track.liked === 1 ? "Unlike" : "Love"}
                onClick={onToggleLike}
              >
                {track.liked === 1
                  ? <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
                  : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>}
              </button>
              <button
                className={`detail-hate-btn${track.liked === -1 ? " hated" : ""}`}
                title={track.liked === -1 ? "Remove hate" : "Hate"}
                onClick={onToggleHate}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/></svg>
              </button>
            </h2>
            <div className="track-detail-meta">
              {track.artist_name && (
                <span className="track-detail-link" onClick={() => onArtistClick(track.artist_id!)}>
                  {track.artist_name}
                </span>
              )}
              {track.album_title && (
                <>
                  <span className="track-detail-sep"> — </span>
                  <span className="track-detail-link" onClick={() => onAlbumClick(track.album_id!, track.artist_id)}>
                    {track.album_title}
                  </span>
                </>
              )}
              {track.year && <span className="track-detail-sep"> ({track.year})</span>}
            </div>
            {trackInfo && (trackInfo.listeners || trackInfo.playcount) && (
              <div className="track-detail-stats">
                {trackInfo.listeners && <>{parseInt(trackInfo.listeners).toLocaleString()} listeners</>}
                {trackInfo.playcount && <>{trackInfo.listeners ? <> &middot; </> : null}{parseInt(trackInfo.playcount).toLocaleString()} scrobbles</>}
                {trackInfo.url && (
                  <> &middot; <a className="track-detail-lastfm-link" onClick={() => openUrl(trackInfo.url!)} title="View on Last.fm"><IconLastfm size={12} /></a></>
                )}
              </div>
            )}
            <div className="track-detail-youtube-row">
              {track.youtube_url ? (
                <>
                  <button className="track-detail-youtube-btn" onClick={onWatchOnYoutube} title="Find in YouTube">
                    <IconYoutube size={32} />
                  </button>
                  <button className="track-detail-youtube-action" onClick={() => setYoutubeUrlEdit(track.youtube_url ?? "")}>Edit</button>
                  <button className="track-detail-youtube-action" onClick={async () => {
                    await invoke("clear_track_youtube_url", { trackId });
                    onUpdateTrack({ youtube_url: null });
                    addLog("Cleared YouTube URL");
                  }}>Remove</button>
                </>
              ) : (
                <>
                  <button className="track-detail-youtube-action" onClick={onWatchOnYoutube}>Find in YouTube</button>
                  <button className="track-detail-youtube-action" onClick={() => setYoutubeUrlEdit("")}>Set YouTube URL</button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
      <div className="section-wide">
        <InformationSections
          entity={track.artist_name ? { kind: "track", name: track.title, id: trackId, artistName: track.artist_name, albumTitle: track.album_title ?? undefined } : null}
          exclude={["track_tags"]}
          invokeInfoFetch={invokeInfoFetch}
          pluginNames={pluginNames}
          tabOrder={tabOrder}
          onTabOrderChange={handleTabOrderChange}
          onTitleData={handleTitleData}
          positionSecs={isCurrentTrack ? positionSecs : 0}
          customTabs={[
            {
              id: "details",
              name: "Details",
              content: (
                <div className="track-details-section">
                  {playStats && (
                    <div className="track-details-row">
                      <span className="track-details-label">Plays</span>
                      <span className="track-details-value">
                        {playStats.play_count}
                        {playStats.last_played_at && <> &middot; last {relativeTime(playStats.last_played_at)}</>}
                      </span>
                    </div>
                  )}
                  {track.duration_secs != null && (
                    <div className="track-details-row">
                      <span className="track-details-label">Duration</span>
                      <span className="track-details-value">{formatDuration(track.duration_secs)}</span>
                    </div>
                  )}
                  {track.format && (
                    <div className="track-details-row">
                      <span className="track-details-label">Format</span>
                      <span className="track-details-value">
                        {track.format.toUpperCase()}
                        {audioProps?.bitrate ? ` · ${audioProps.bitrate} kbps` : ""}
                        {audioProps?.sample_rate ? ` · ${(audioProps.sample_rate / 1000).toFixed(1)} kHz` : ""}
                        {audioProps?.bit_depth ? ` · ${audioProps.bit_depth}-bit` : ""}
                      </span>
                    </div>
                  )}
                  {track.file_size != null && (
                    <div className="track-details-row">
                      <span className="track-details-label">Size</span>
                      <span className="track-details-value">
                        {track.file_size >= 1048576
                          ? `${(track.file_size / 1048576).toFixed(1)} MB`
                          : `${Math.round(track.file_size / 1024)} KB`}
                      </span>
                    </div>
                  )}
                  {track.path && (
                    <div className="track-details-row">
                      <span className="track-details-label">Path</span>
                      <span className="track-details-value track-details-path">
                        <span className="track-detail-path-text">{track.path}</span>
                        {!track.path.startsWith("subsonic://") && !track.path.startsWith("tidal://") && (
                          <button className="track-detail-path-btn" onClick={onShowInFolder} title="Show in folder">
                            <IconFolder size={12} />
                          </button>
                        )}
                        <button className="track-detail-path-btn" onClick={() => { navigator.clipboard.writeText(track.path); addLog("Copied path"); }} title="Copy path">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                        </button>
                      </span>
                    </div>
                  )}
                  {track.added_at && (
                    <div className="track-details-row">
                      <span className="track-details-label">Added</span>
                      <span className="track-details-value">{formatTimestamp(track.added_at)}</span>
                    </div>
                  )}
                  {editingTags ? (
                    <div className="track-tags-edit">
                      <span className="track-detail-label">Tags</span>
                      <input
                        className="track-tags-edit-input"
                        value={tagInput}
                        onChange={e => setTagInput(e.target.value)}
                        onKeyDown={e => { if (e.key === "Enter") handleSaveTags(); if (e.key === "Escape") setEditingTags(false); }}
                        placeholder="tag1, tag2, tag3..."
                        autoFocus
                      />
                      <button className="track-tags-edit-btn save" onClick={handleSaveTags}>Save</button>
                      <button className="track-tags-edit-btn" onClick={() => setEditingTags(false)}>Cancel</button>
                    </div>
                  ) : (
                    <div className="track-detail-tags-inline">
                      <span className="track-detail-label">Tags</span>
                      {trackTags.map(tag => (
                        <span key={tag.id} className="track-tag-chip track-tag-assigned">
                          <span className="track-tag-name" onClick={() => onTagClick(tag.id)}>{tag.name}</span>
                          <span className="track-tag-remove" onClick={() => handleRemoveTag(tag)} title="Remove tag">&times;</span>
                        </span>
                      ))}
                      {allCommunityTags.filter(t => !assignedTagNames.has(t.name.toLowerCase())).slice(0, 15).map(tag => (
                        <span key={tag.name} className="track-tag-chip track-tag-suggestion" onClick={() => handleApplyTag(tag.name)}>
                          + {tag.name}
                        </span>
                      ))}
                      <button className="track-tags-edit-btn" onClick={handleStartEditTags} title="Edit tags">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
                      </button>
                    </div>
                  )}
                </div>
              ),
            },
            {
              id: "play-history",
              name: `Play History${playStats ? ` (${formatCount(playStats.play_count)})` : ""}`,
              content: playHistory.length > 0 ? (
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
              ),
            },
          ]}
          onEntityClick={(kind, id) => {
            if (kind === "artist" && id) onArtistClick(id);
            if (kind === "album" && id) onAlbumClick(id);
            if (kind === "tag" && id) onTagClick(id);
          }}
          onAction={handleInfoAction}
          onTrackContextMenu={onInfoTrackContextMenu}
        />
      </div>

      {youtubeUrlEdit !== null && (
        <div className="youtube-modal-overlay">
          <div className="youtube-modal" onClick={e => e.stopPropagation()}>
            <div className="youtube-modal-icon"><IconYoutube size={24} /></div>
            <div className="youtube-modal-text">Set YouTube URL for "<strong>{track.title}</strong>"</div>
            <input
              className="youtube-modal-input"
              value={youtubeUrlEdit}
              onChange={e => setYoutubeUrlEdit(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter") {
                  const url = youtubeUrlEdit.trim();
                  if (url) {
                    invoke("set_track_youtube_url", { trackId, url });
                    onUpdateTrack({ youtube_url: url });
                    addLog("Saved YouTube URL");
                  } else {
                    invoke("clear_track_youtube_url", { trackId });
                    onUpdateTrack({ youtube_url: null });
                    addLog("Cleared YouTube URL");
                  }
                  setYoutubeUrlEdit(null);
                }
                if (e.key === "Escape") setYoutubeUrlEdit(null);
              }}
              placeholder="https://www.youtube.com/watch?v=..."
              autoFocus
            />
            <div className="youtube-modal-actions">
              <button className="youtube-modal-btn" onClick={() => setYoutubeUrlEdit(null)}>Cancel</button>
              {track.youtube_url && (
                <button className="youtube-modal-btn" onClick={async () => {
                  await invoke("clear_track_youtube_url", { trackId });
                  onUpdateTrack({ youtube_url: null });
                  addLog("Cleared YouTube URL");
                  setYoutubeUrlEdit(null);
                }}>Clear</button>
              )}
              <button className="youtube-modal-btn yes" onClick={async () => {
                const url = youtubeUrlEdit.trim();
                if (url) {
                  await invoke("set_track_youtube_url", { trackId, url });
                  onUpdateTrack({ youtube_url: url });
                  addLog("Saved YouTube URL");
                }
                setYoutubeUrlEdit(null);
              }}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
