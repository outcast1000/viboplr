import { useState, useEffect, useRef, useCallback } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";

import { openUrl } from "@tauri-apps/plugin-opener";
import type { Track } from "../types";
import type { InfoEntity } from "../types/informationTypes";
import { getProvidersForContext } from "../searchProviders";
import { formatDuration } from "../utils";
import { isLocalTrack } from "../queueEntry";
import { useDetailActions } from "../contexts/DetailViewContext";
import { IconFolder, IconLastfm, IconYoutube } from "./Icons";
import { LikeDislikeButtons } from "./LikeDislikeButtons";
import { ImageActions } from "./ImageActions";
import { store } from "../store";

import { InformationSections } from "./InformationSections";
import { useVideoFrames } from "../hooks/useVideoFrames";
import { isVideoTrack } from "../utils";
import { VideoFilmstrip } from "./VideoFilmstrip";
import { VideoFrameCard } from "./VideoFrameCard";
import { DetailHeroBackground } from "./DetailHeroBackground";
import { useDetailHeroImages } from "../hooks/useDetailHeroImages";
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
  trackId: number | null;
  track: Track;
  albumImagePath: string | null;
  artistImagePath: string | null;
  positionSecs: number;
  isCurrentTrack: boolean;
  onPlay: () => void;
  onPlayAt: (secs: number) => void;
  onShowInFolder: () => void;
  onWatchOnYoutube?: () => void;
  onToggleLike: () => void;
  onToggleDislike: () => void;
  onUpdateTrack: (update: Partial<Track>) => void;
  onTagsChanged?: () => void;
}

export function TrackDetailView({
  trackId, track, albumImagePath, artistImagePath,
  positionSecs, isCurrentTrack,
  onPlay, onPlayAt, onShowInFolder, onWatchOnYoutube,
  onToggleLike, onToggleDislike,
  onUpdateTrack,
  onTagsChanged,
}: TrackDetailViewProps) {
  const actions = useDetailActions();
  const isLibrary = trackId != null;

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
  const videoFrames = useVideoFrames(isVideoTrack(track) ? track : null);

  const requestArtistImage = useCallback(
    (n: string) => actions.requestFetchImage("artist", n),
    [actions.requestFetchImage],
  );
  const artistHeroImages = useDetailHeroImages.singleArtist(
    track.artist_name,
    actions.getArtistImage,
    requestArtistImage,
  );
  const heroImages: string[] = videoFrames.frames && videoFrames.frames.length > 0
    ? videoFrames.frames.slice(0, 4)
    : artistHeroImages;

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

    if (isLibrary) {
      invoke<Array<{ id: number; name: string }>>("get_tags_for_track", { trackId }).then(setTrackTags).catch(e => console.error("Failed to load track tags:", e));
      invoke<{ sample_rate?: number; bit_depth?: number; channels?: number; bitrate?: number }>("get_track_audio_properties", { trackId })
        .then(setAudioProps).catch(e => console.error("Failed to load audio properties:", e));
    }
    invoke<TrackPlayStats | null>("get_track_play_stats", { title: track.title, artistName: track.artist_name }).then(s => { if (s) setPlayStats(s); }).catch(e => console.error("Failed to load play stats:", e));
    invoke<Array<{ played_at: number }>>("get_track_play_history", { title: track.title, artistName: track.artist_name, limit: 50 }).then(setPlayHistory).catch(e => console.error("Failed to load play history:", e));

    if (track.artist_name) {
      const trackEntity: InfoEntity = { kind: "track", name: track.title, id: trackId ?? 0, artistName: track.artist_name };
      // Fetch track tags + artist tags (combined in one info type)
      actions.invokeInfoFetch("lastfm", "track_tags", trackEntity).then(result => {
        if (result.status !== "ok") return;
        const val = result.value as any;
        if (val?.tags?.length) setCommunityTags(val.tags);
        if (val?.artistTags?.length) setArtistTags(val.artistTags);
      }).catch(e => console.error("Failed to load community/artist tags:", e));
    }
  }, [trackId, isLibrary, track.artist_name, track.title, actions.invokeInfoFetch]);

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
        onTagsChanged?.();
      }
    } catch (e) { console.error("Failed to apply tag:", e); }
  }, [trackId, onTagsChanged]);

  const handleRemoveTag = useCallback(async (tagToRemove: { id: number; name: string }) => {
    const remaining = trackTags.filter(t => t.id !== tagToRemove.id).map(t => t.name);
    try {
      const result = await invoke<Array<[number, string]>>("replace_track_tags", { trackId, tagNames: remaining });
      setTrackTags(result.map(([id, name]) => ({ id, name })));
      onTagsChanged?.();
    } catch (e) { console.error("Failed to remove tag:", e); }
  }, [trackId, trackTags, onTagsChanged]);

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
      onTagsChanged?.();
    } catch (e) { console.error("Failed to save tags:", e); }
  }, [trackId, tagInput, onTagsChanged]);

  const handleInfoAction = useCallback((actionId: string, payload?: unknown) => {
    if (actionId === "play-track") {
      const t = payload as Track | undefined;
      if (t) actions.playTracks([t], 0);
    }
  }, [actions.playTracks]);

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
        <DetailHeroBackground images={heroImages} className="track-detail-bg" />
        <div className="track-detail-header">
          <div className="track-detail-art">
            {videoFrames.frames ? (
              <VideoFrameCard frames={videoFrames.frames} alt={track.title} className="track-detail-art-frames" timestamps={videoFrames.timestamps} onFrameClick={onPlayAt} />
            ) : (albumImagePath || artistImagePath) ? (
              <>
                <img className="track-detail-art-img" src={convertFileSrc((albumImagePath ?? artistImagePath)!)} alt={track.album_title ?? track.artist_name ?? ""} />
                <span className="track-detail-art-label">{albumImagePath ? "Album" : "Artist"}</span>
              </>
            ) : (
              <svg className="track-detail-art-placeholder" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            )}
            <button
              className="detail-art-play"
              title="Play"
              onClick={onPlay}
            >
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 6.82v10.36c0 .79.87 1.27 1.54.84l8.14-5.18a1 1 0 0 0 0-1.69L9.54 5.98A.998.998 0 0 0 8 6.82z"/></svg>
            </button>
            {isLibrary && albumImagePath && track.album_title ? (
              <ImageActions
                entityType="album"
                entityName={track.album_title}
                artistName={track.artist_name ?? undefined}
                imagePath={albumImagePath}
                providers={getProvidersForContext(actions.searchProviders, "album")}
                onImageChanged={() => actions.invalidateImage("album", track.album_title!, track.artist_name ?? undefined)}
                onRefresh={() => actions.requestFetchImage("album", track.album_title!, track.artist_name ?? undefined)}
              />
            ) : isLibrary && track.artist_name ? (
              <ImageActions
                entityType="artist"
                entityName={track.artist_name}
                imagePath={artistImagePath}
                providers={getProvidersForContext(actions.searchProviders, "artist")}
                onImageChanged={() => actions.invalidateImage("artist", track.artist_name!)}
                onRefresh={() => actions.requestFetchImage("artist", track.artist_name!)}
              />
            ) : null}
          </div>
          <div className="track-detail-info">
            <h2>
              {track.title}
              <LikeDislikeButtons
                liked={track.liked}
                onToggleLike={onToggleLike}
                onToggleDislike={onToggleDislike}
                size={16}
                variant="glass"
                disabled={!isLibrary}
              />
            </h2>
            <div className="track-detail-meta">
              {track.artist_name && (
                <span className="track-detail-link" onClick={() => actions.navigateToArtist(track.artist_id ?? 0, track.artist_name!)}>
                  {track.artist_name}
                </span>
              )}
              {track.album_title && (
                <>
                  <span className="track-detail-sep"> — </span>
                  <span className="track-detail-link" onClick={() => actions.navigateToAlbum(track.album_id ?? 0, track.artist_id, track.album_title!, track.artist_name ?? undefined)}>
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
                  {isLibrary && (
                    <>
                      <button className="track-detail-youtube-action" onClick={() => setYoutubeUrlEdit(track.youtube_url ?? "")}>Edit</button>
                      <button className="track-detail-youtube-action" onClick={async () => {
                        await invoke("clear_track_youtube_url", { trackId });
                        onUpdateTrack({ youtube_url: null });
                      }}>Remove</button>
                    </>
                  )}
                </>
              ) : (
                <>
                  <button className="track-detail-youtube-action" onClick={onWatchOnYoutube}>Find in YouTube</button>
                  {isLibrary && (
                    <button className="track-detail-youtube-action" onClick={() => setYoutubeUrlEdit("")}>Set YouTube URL</button>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
      {isVideoTrack(track) && (
        <div className="section-wide">
          <VideoFilmstrip framesState={videoFrames} onFrameClick={onPlayAt} />
        </div>
      )}
      <div className="section-wide">
        <InformationSections
          entity={track.artist_name ? { kind: "track", name: track.title, id: trackId ?? 0, artistName: track.artist_name, albumTitle: track.album_title ?? undefined } : null}
          exclude={["track_tags"]}
          invokeInfoFetch={actions.invokeInfoFetch}
          pluginNames={actions.pluginNames}
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
                  {isLibrary && track.format && (
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
                  {isLibrary && track.file_size != null && (
                    <div className="track-details-row">
                      <span className="track-details-label">Size</span>
                      <span className="track-details-value">
                        {track.file_size >= 1048576
                          ? `${(track.file_size / 1048576).toFixed(1)} MB`
                          : `${Math.round(track.file_size / 1024)} KB`}
                      </span>
                    </div>
                  )}
                  {isLibrary && track.path && (
                    <div className="track-details-row">
                      <span className="track-details-label">Path</span>
                      <span className="track-details-value track-details-path">
                        <span className="track-detail-path-text">{track.path}</span>
                        {isLocalTrack(track) && (
                          <button className="track-detail-path-btn" onClick={onShowInFolder} title="Show in folder">
                            <IconFolder size={12} />
                          </button>
                        )}
                        <button className="track-detail-path-btn" onClick={() => { navigator.clipboard.writeText(track.path ?? ""); }} title="Copy path">
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
                  {isLibrary && (editingTags ? (
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
                          <span className="track-tag-name" onClick={() => actions.navigateToTag(tag.id)}>{tag.name}</span>
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
                  ))}
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
          onEntityClick={(kind, id, name) => {
            if (kind === "artist") actions.navigateToArtist(id ?? 0, name);
            else if (kind === "album") actions.navigateToAlbum(id ?? 0, undefined, name);
            else if (kind === "tag" && id) actions.navigateToTag(id);
          }}
          onAction={handleInfoAction}
          onTrackContextMenu={actions.handleInfoTrackContextMenu}
          onEntityContextMenu={actions.handleEntityContextMenu}
        />
      </div>

      {isLibrary && youtubeUrlEdit !== null && (
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
                  } else {
                    invoke("clear_track_youtube_url", { trackId });
                    onUpdateTrack({ youtube_url: null });
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
                  setYoutubeUrlEdit(null);
                }}>Clear</button>
              )}
              <button className="youtube-modal-btn yes" onClick={async () => {
                const url = youtubeUrlEdit.trim();
                if (url) {
                  await invoke("set_track_youtube_url", { trackId, url });
                  onUpdateTrack({ youtube_url: url });
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
