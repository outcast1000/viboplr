import { useState, useEffect, useRef, useCallback } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";

import { openUrl } from "@tauri-apps/plugin-opener";
import type { Track, Collection } from "../types";
import type { InfoEntity, InfoFetchResult } from "../types/informationTypes";
import type { SearchProviderConfig } from "../searchProviders";
import { getProvidersForContext, buildSearchUrl } from "../searchProviders";
import { IconPlay, IconEnqueue, IconFolder, IconGlobe, IconLastfm, IconYoutube } from "./Icons";

import { InformationSections } from "./InformationSections";
import "./TrackDetailView.css";

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

// --- TrackActions dropdown (modeled after ImageActions) ---

function TrackActions({
  track, providers,
  onPlay, onEnqueue, onPlayNext, onShowInFolder,
  onYoutubeFound, onSetYoutubeUrl,
}: {
  track: Track;
  providers: SearchProviderConfig[];
  onPlay: () => void;
  onEnqueue: () => void;
  onPlayNext: () => void;
  onShowInFolder: () => void;
  onYoutubeFound: (url: string, videoTitle: string) => void;
  onSetYoutubeUrl: () => void;
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
              <IconFolder size={14} /><span>Open Containing Folder</span>
            </button>
          )}
          <button onClick={async () => {
            setOpenMenu(false);
            if (track.youtube_url) {
              await openUrl(track.youtube_url);
            } else {
              try {
                const result = await invoke<{ url: string; video_title: string | null }>(
                  "search_youtube", { title: track.title, artistName: track.artist_name }
                );
                await openUrl(result.url);
                onYoutubeFound(result.url, result.video_title ?? track.title);
              } catch {
                const q = encodeURIComponent(`${track.title} ${track.artist_name ?? ""}`);
                await openUrl(`https://www.youtube.com/results?search_query=${q}`);
              }
            }
          }}>
            <IconYoutube size={14} /><span>Find in YouTube</span>
          </button>
          <button onClick={() => { setOpenMenu(false); onSetYoutubeUrl(); }}>
            <IconYoutube size={14} /><span>Set YouTube URL</span>
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
  onArtistClick: (artistId: number) => void;
  onAlbumClick: (albumId: number, artistId?: number | null) => void;
  onTagClick: (tagId: number) => void;
  onPlay: () => void;
  onEnqueue: () => void;
  onPlayNext: () => void;
  onShowInFolder: () => void;
  onPlayTrack: (track: Track) => void;
  collections: Collection[];
  providers: SearchProviderConfig[];
  addLog: (msg: string) => void;
  onUpdateTrack: (update: Partial<Track>) => void;
  invokeInfoFetch: (pluginId: string, infoTypeId: string, entity: InfoEntity, onFetchUrl?: (url: string) => void) => Promise<InfoFetchResult>;
  pluginNames?: Map<string, string>;
}

export function TrackDetailView({
  trackId, track, albumImagePath,
  positionSecs, isCurrentTrack,
  onArtistClick, onAlbumClick, onTagClick,
  onPlay, onEnqueue, onPlayNext, onShowInFolder, onPlayTrack,
  collections: _collections, providers, addLog, onUpdateTrack, invokeInfoFetch, pluginNames,
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
  const [youtubeFeedback, setYoutubeFeedback] = useState<{ url: string; videoTitle: string } | null>(null);
  const [youtubeUrlEdit, setYoutubeUrlEdit] = useState<string | null>(null);
  const trackIdRef = useRef(trackId);

  useEffect(() => { trackIdRef.current = trackId; }, [trackId]);

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
    setYoutubeFeedback(null);
    setYoutubeUrlEdit(null);

    invoke<Array<{ id: number; name: string }>>("get_tags_for_track", { trackId }).then(setTrackTags).catch(() => {});
    invoke<TrackPlayStats | null>("get_track_play_stats", { trackId }).then(s => { if (s) setPlayStats(s); }).catch(() => {});
    invoke<Array<{ played_at: number }>>("get_track_play_history", { trackId, limit: 50 }).then(setPlayHistory).catch(() => {});
    invoke<{ sample_rate?: number; bit_depth?: number; channels?: number; bitrate?: number }>("get_track_audio_properties", { trackId })
      .then(setAudioProps).catch(() => {});

    if (track.artist_name) {
      const trackEntity: InfoEntity = { kind: "track", name: track.title, id: trackId, artistName: track.artist_name };
      // Fetch track tags + artist tags (combined in one info type)
      invokeInfoFetch("lastfm", "track_tags", trackEntity).then(result => {
        if (result.status !== "ok") return;
        const val = result.value as any;
        if (val?.tags?.length) setCommunityTags(val.tags);
        if (val?.artistTags?.length) setArtistTags(val.artistTags);
      }).catch(() => {});
      // Fetch track info (listeners, playcount, tags, url)
      invokeInfoFetch("lastfm", "track_info", trackEntity).then(result => {
        if (result.status !== "ok") return;
        const val = result.value as any;
        if (!val) return;
        const items = val.items as Array<{ label: string; value: number }> | undefined;
        const info: { listeners?: string; playcount?: string; toptags?: Array<{ name: string }>; url?: string } = {};
        if (items) {
          for (const item of items) {
            if (item.label === "listeners") info.listeners = String(item.value);
            if (item.label === "scrobbles") info.playcount = String(item.value);
          }
        }
        if (val.toptags) info.toptags = val.toptags;
        if (val.url) info.url = val.url;
        setTrackInfo(info);
      }).catch(() => {});
    }
  }, [trackId, track.artist_name, track.title, invokeInfoFetch]);

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
              {track.youtube_url && (
                <button className="artist-play-btn youtube-btn" title="Watch on YouTube" onClick={() => openUrl(track.youtube_url!)}>
                  <IconYoutube size={16} />
                </button>
              )}
              <TrackActions
                track={track}
                providers={providers}
                onPlay={onPlay}
                onEnqueue={onEnqueue}
                onPlayNext={onPlayNext}
                onShowInFolder={onShowInFolder}
                onYoutubeFound={(url, videoTitle) => setYoutubeFeedback({ url, videoTitle })}
                onSetYoutubeUrl={() => setYoutubeUrlEdit(track.youtube_url ?? "")}
              />
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
        </div>
        <InformationSections
          placement="right"
          entity={track.artist_name ? { kind: "track", name: track.title, id: trackId, artistName: track.artist_name, albumTitle: track.album_title ?? undefined } : null}
          exclude={["track_tags"]}
          invokeInfoFetch={invokeInfoFetch}
          pluginNames={pluginNames}
          positionSecs={isCurrentTrack ? positionSecs : 0}
          onEntityClick={(kind, id) => {
            if (kind === "artist" && id) onArtistClick(id);
            if (kind === "album" && id) onAlbumClick(id);
            if (kind === "tag" && id) onTagClick(id);
          }}
          onAction={handleInfoAction}
        />
      </div>
      <div className="section-wide">
        <InformationSections
          placement="below"
          entity={track.artist_name ? { kind: "track", name: track.title, id: trackId, artistName: track.artist_name, albumTitle: track.album_title ?? undefined } : null}
          exclude={["track_tags"]}
          invokeInfoFetch={invokeInfoFetch}
          pluginNames={pluginNames}
          tabOrder={["genius_song_explanation", "lyrics"]}
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
        />
      </div>

      {youtubeFeedback && (
        <div className="youtube-modal-overlay" onClick={() => setYoutubeFeedback(null)}>
          <div className="youtube-modal" onClick={e => e.stopPropagation()}>
            <div className="youtube-modal-icon"><IconYoutube size={24} /></div>
            <div className="youtube-modal-text">
              Is this the right video for "<strong>{track.title}</strong>"?<br />
              Save this link for future use?
            </div>
            <a className="youtube-modal-link" onClick={() => openUrl(youtubeFeedback.url)}>{youtubeFeedback.url}</a>
            <div className="youtube-modal-actions">
              <button className="youtube-modal-btn" onClick={() => setYoutubeFeedback(null)}>No</button>
              <button className="youtube-modal-btn yes" onClick={async () => {
                await invoke("set_track_youtube_url", { trackId, url: youtubeFeedback.url });
                onUpdateTrack({ youtube_url: youtubeFeedback.url });
                addLog("Saved YouTube link");
                setYoutubeFeedback(null);
              }}>Yes</button>
            </div>
          </div>
        </div>
      )}

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
