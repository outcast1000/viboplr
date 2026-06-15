import { useState, useEffect, useRef, useCallback } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Track, QueueTrack } from "../types";
import type { InfoEntity } from "../types/informationTypes";
import { buildSearchUrl, getProvidersForContext } from "../searchProviders";
import { formatDuration } from "../utils";
import { isLocalTrack } from "../queueEntry";
import { useDetailActions } from "../contexts/DetailViewContext";
import { IconFolder, IconLastfm, IconYoutube } from "./Icons";
import { store } from "../store";

import { InformationSections } from "./InformationSections";
import { useVideoFrames } from "../hooks/useVideoFrames";
import { isVideoTrack } from "../utils";
import { VideoFilmstrip } from "./VideoFilmstrip";
import { VideoFrameCard } from "./VideoFrameCard";
import { useDetailHeroImages } from "../hooks/useDetailHeroImages";
import { resolveImageUrl } from "../utils/resolveImageUrl";
import { DetailHero } from "./DetailHero";
import { buildHeroOverflowItems, type HeroOverflowItem } from "../utils/heroOverflow";
import TagEditor from "./TagEditor";
import { buildTagSuggestionPool } from "../utils/tagSuggestions";
import { useTagActions } from "../hooks/useTagActions";
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
  const [allLibraryTags, setAllLibraryTags] = useState<Array<{ name: string; track_count: number }>>([]);
  const tagActions = useTagActions();
  const [playStats, setPlayStats] = useState<TrackPlayStats | null>(null);
  const [playHistory, setPlayHistory] = useState<Array<{ played_at: number }>>([]);
  const [audioProps, setAudioProps] = useState<{ sample_rate?: number; bit_depth?: number; channels?: number; bitrate?: number } | null>(null);
  const [trackInfo, setTrackInfo] = useState<{ listeners?: string; playcount?: string; url?: string } | null>(null);
  const [youtubeUrlEdit, setYoutubeUrlEdit] = useState<string | null>(null);
  const [tabOrder, setTabOrder] = useState<string[]>(DEFAULT_TAB_ORDER);
  const trackIdRef = useRef(trackId);
  const videoFrames = useVideoFrames(isVideoTrack(track) ? track : null);

  const requestArtistImage = useCallback(
    (n: string) => actions.autoFetchImage("artist", n),
    [actions.autoFetchImage],
  );
  const artistHeroImages = useDetailHeroImages.singleArtist(
    track.artist_name,
    actions.getArtistImage,
    requestArtistImage,
  );
  // Hero background fallback chain: video frames -> album image -> artist image.
  const albumHeroUrl = resolveImageUrl(albumImagePath);
  const heroImages: string[] =
    videoFrames.frames && videoFrames.frames.length > 0 ? videoFrames.frames.slice(0, 4)
    : albumHeroUrl ? [albumHeroUrl]
    : artistHeroImages;

  useEffect(() => { trackIdRef.current = trackId; }, [trackId]);

  // Load persisted tab order on mount
  useEffect(() => {
    store.get<string[]>("trackDetailTabOrder").then(saved => {
      if (saved && saved.length > 0) setTabOrder(saved);
    });
  }, []);

  // Load all library tags once for suggestion ranking
  useEffect(() => {
    invoke<Array<{ id: number; name: string; track_count: number; liked: number }>>("get_tags")
      .then((tags) => setAllLibraryTags(tags.map((t) => ({ name: t.name, track_count: t.track_count }))))
      .catch((e) => console.error("Failed to load library tags:", e));
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
    const info: { listeners?: string; playcount?: string; url?: string } = {};
    if (items) {
      for (const item of items) {
        if (item.label === "listeners") info.listeners = String(item.value);
        if (item.label === "scrobbles") info.playcount = String(item.value);
      }
    }
    if (val.url) info.url = val.url as string;
    if (info.listeners || info.playcount) setTrackInfo(info);
  }, []);

  const handleAddTag = useCallback(async (tagName: string) => {
    if (trackId == null) return;
    setTrackTags((prev) => [...prev, { id: -1, name: tagName }]);
    setCommunityTags((prev) => prev.filter((t) => t.name.toLowerCase() !== tagName.toLowerCase()));
    const names = await tagActions.add(trackId, tagName);
    if (names == null) {
      setTrackTags((prev) => prev.filter((t) => t.name.toLowerCase() !== tagName.toLowerCase()));
      return;
    }
    invoke<Array<{ id: number; name: string }>>("get_tags_for_track", { trackId })
      .then(setTrackTags)
      .catch((e) => console.error("Failed to reload track tags:", e));
    onTagsChanged?.();
  }, [trackId, tagActions, onTagsChanged]);

  const handleRemoveTagByName = useCallback(async (tagName: string) => {
    if (trackId == null) return;
    const before = trackTags;
    setTrackTags((prev) => prev.filter((t) => t.name.toLowerCase() !== tagName.toLowerCase()));
    const names = await tagActions.remove(trackId, before.map((t) => t.name), tagName);
    if (names == null) {
      setTrackTags(before);
      return;
    }
    invoke<Array<{ id: number; name: string }>>("get_tags_for_track", { trackId })
      .then(setTrackTags)
      .catch((e) => console.error("Failed to reload track tags:", e));
    onTagsChanged?.();
  }, [trackId, trackTags, tagActions, onTagsChanged]);

  const handleInfoAction = useCallback((actionId: string, payload?: unknown) => {
    if (actionId === "play-track") {
      const t = payload as QueueTrack | undefined;
      if (t) actions.playExternal([t]);
    } else if (actionId === "enqueue-track") {
      const t = payload as QueueTrack | undefined;
      if (t) actions.enqueueExternal([t]);
    }
  }, [actions.playExternal, actions.enqueueExternal]);

  const suggestionPool = buildTagSuggestionPool(
    allLibraryTags,
    [...communityTags, ...artistTags],
  );

  const heroImageKind: "album" | "artist" | null =
    isLibrary && albumImagePath && track.album_title ? "album"
    : isLibrary && track.artist_name ? "artist"
    : null;

  const heroImageEntityName =
    heroImageKind === "album" ? track.album_title!
    : heroImageKind === "artist" ? track.artist_name!
    : null;

  const heroImageArtistArg =
    heroImageKind === "album" ? (track.artist_name ?? undefined) : undefined;

  const handleRefreshImage = useCallback(() => {
    if (!heroImageKind || !heroImageEntityName) return;
    actions.requestFetchImage(heroImageKind, heroImageEntityName, heroImageArtistArg);
  }, [actions.requestFetchImage, heroImageKind, heroImageEntityName, heroImageArtistArg]);

  const handleSetImageFromFile = useCallback(async () => {
    if (!heroImageKind || !heroImageEntityName) return;
    const selected = await openFileDialog({
      multiple: false,
      filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png"] }],
    });
    if (!selected || typeof selected !== "string") return;
    try {
      await invoke("set_entity_image", {
        kind: heroImageKind,
        name: heroImageEntityName,
        artistName: heroImageKind === "album" ? (track.artist_name ?? null) : null,
        sourcePath: selected,
      });
      actions.invalidateImage(heroImageKind, heroImageEntityName, heroImageArtistArg);
    } catch (e) { console.error("Failed to set track-related image:", e); }
  }, [actions.invalidateImage, heroImageKind, heroImageEntityName, heroImageArtistArg, track.artist_name]);

  const handlePasteImage = useCallback(async () => {
    if (!heroImageKind || !heroImageEntityName) return;
    try {
      await invoke("paste_entity_image_from_clipboard", {
        kind: heroImageKind,
        name: heroImageEntityName,
        artistName: heroImageKind === "album" ? (track.artist_name ?? null) : null,
      });
      actions.invalidateImage(heroImageKind, heroImageEntityName, heroImageArtistArg);
    } catch (e) { console.error("Failed to paste track-related image:", e); }
  }, [actions.invalidateImage, heroImageKind, heroImageEntityName, heroImageArtistArg, track.artist_name]);

  const handleRemoveImage = useCallback(async () => {
    if (!heroImageKind || !heroImageEntityName) return;
    try {
      await invoke("remove_entity_image", {
        kind: heroImageKind,
        name: heroImageEntityName,
        artistName: heroImageKind === "album" ? (track.artist_name ?? null) : null,
      });
      actions.invalidateImage(heroImageKind, heroImageEntityName, heroImageArtistArg);
    } catch (e) { console.error("Failed to remove track-related image:", e); }
  }, [actions.invalidateImage, heroImageKind, heroImageEntityName, heroImageArtistArg, track.artist_name]);

  const handleSearchImageGoogle = useCallback(() => {
    if (!heroImageKind || !heroImageEntityName) return;
    const q = heroImageKind === "album" && track.artist_name
      ? `${track.artist_name} ${heroImageEntityName}`
      : heroImageEntityName;
    openUrl(`https://www.google.com/search?tbm=isch&q=${encodeURIComponent(q)}`)
      .catch(e => console.error("Failed to open image search:", e));
  }, [heroImageKind, heroImageEntityName, track.artist_name]);

  const trackProviders = getProvidersForContext(actions.searchProviders, "track");

  const overflowItems: HeroOverflowItem[] = buildHeroOverflowItems({
    entityKind: "track",
    imageActions: heroImageKind ? {
      onRefresh: handleRefreshImage,
      onSetFromFile: handleSetImageFromFile,
      onPasteFromClipboard: handlePasteImage,
      onRemove: (heroImageKind === "album" ? !!albumImagePath : !!artistImagePath) ? handleRemoveImage : undefined,
      onSearchImage: handleSearchImageGoogle,
      webSearches: trackProviders
        .filter(p => p.trackUrl)
        .map(p => ({
          id: p.id,
          label: p.name,
          onClick: () => {
            const url = buildSearchUrl(p.trackUrl!, { artist: track.artist_name ?? "", title: track.title });
            if (url) openUrl(url).catch(e => console.error("Failed to open search URL:", e));
          },
        })),
    } : {},
    youtube: {
      url: track.youtube_url,
      onFind: () => onWatchOnYoutube?.(),
      onSetUrl: () => setYoutubeUrlEdit(track.youtube_url ?? ""),
      onClear: track.youtube_url && isLibrary ? async () => {
        try {
          await invoke("clear_track_youtube_url", { trackId });
          onUpdateTrack({ youtube_url: null });
        } catch (e) { console.error("Failed to clear YouTube URL:", e); }
      } : undefined,
    },
    pluginItems: [],
  });

  const eyebrow = track.album_title ? `Track · ${track.album_title}` : "Track";

  const heroMeta: Array<string | { label: string; onClick: () => void }> = [];
  if (track.artist_name) {
    heroMeta.push({ label: track.artist_name, onClick: () => actions.navigateToArtist(track.artist_id ?? 0, track.artist_name!) });
  }
  if (track.album_title) {
    heroMeta.push({ label: track.album_title, onClick: () => actions.navigateToAlbum(track.album_id ?? 0, track.artist_id, track.album_title!, track.artist_name ?? undefined) });
  }
  if (track.year) heroMeta.push(String(track.year));
  if (track.format) heroMeta.push(`${track.format.toUpperCase()}${audioProps?.bitrate ? ` · ${audioProps.bitrate} kbps` : ""}`);

  const titleLine = trackInfo && (trackInfo.listeners || trackInfo.playcount) ? (
    <span>
      {trackInfo.listeners && <>{parseInt(trackInfo.listeners).toLocaleString()} listeners</>}
      {trackInfo.playcount && (
        <>{trackInfo.listeners ? <> &middot; </> : null}{parseInt(trackInfo.playcount).toLocaleString()} scrobbles</>
      )}
      {trackInfo.url && (
        <> &middot; <a className="track-detail-lastfm-link" onClick={() => openUrl(trackInfo.url!)} title="View on Last.fm"><IconLastfm size={12} /></a></>
      )}
    </span>
  ) : undefined;

  const handleEnqueueTrack = useCallback(() => {
    actions.enqueueTracks([track]);
  }, [actions.enqueueTracks, track]);

  return (
    <div className="track-detail">
      <DetailHero
        bgImages={heroImages}
        bgClassName="detail-hero-bg"
        art={
          videoFrames.frames ? (
            <VideoFrameCard
              frames={videoFrames.frames}
              alt={track.title}
              className="track-detail-art-frames"
              timestamps={videoFrames.timestamps}
              onFrameClick={onPlayAt}
            />
          ) : (albumImagePath || artistImagePath) ? (
            <img src={convertFileSrc((albumImagePath ?? artistImagePath)!)} alt={track.album_title ?? track.artist_name ?? ""} />
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: 48, height: 48, opacity: 0.5 }}>
              <circle cx="12" cy="12" r="10" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          )
        }
        artShape="square"
        eyebrow={eyebrow}
        title={track.title}
        liked={track.liked}
        onToggleLike={onToggleLike}
        onToggleDislike={onToggleDislike}
        likeDisabled={!isLibrary}
        entityLabel="track"
        meta={heroMeta}
        onPlay={onPlay}
        onEnqueue={handleEnqueueTrack}
        overflowItems={overflowItems}
        titleLine={titleLine}
      />
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
          retrieve={actions.retrieve}
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
                  {isLibrary && (
                    <div className="track-detail-tags-inline">
                      <span className="track-detail-label">Tags</span>
                      <TagEditor
                        tags={trackTags.map((t) => t.name)}
                        suggestions={suggestionPool}
                        onAdd={handleAddTag}
                        onRemove={handleRemoveTagByName}
                        variant="inline"
                      />
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
