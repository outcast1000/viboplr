import { useRef, useState, useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { resolveImageUrl } from "../utils/resolveImageUrl";
import { usePlaybackPosition } from "../playback/positionStore";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { QueueTrack, SearchAllResults, SearchResultItem, QueueMode, ResolvedSource } from "../types";
import type { AutoContinueWeights } from "../hooks/useAutoContinue";
import type { MiniRestingSize, MiniWidthSize } from "../hooks/useMiniMode";
import { formatDuration, isVideoTrack } from "../utils";
import { isLocalTrack } from "../queueEntry";
import { AutoContinuePopover } from "./AutoContinuePopover";
import { EqPopover } from "./EqPopover";
import { EqBarControl } from "./EqBarControl";
import type { EqMode } from "../eqPresets";
import { WaveformSeekBar } from "./WaveformSeekBar";
import { SegmentedSeekBar } from "./SegmentedSeekBar";
import { LikeDislikeButtons } from "./LikeDislikeButtons";
import { IconHeartFilled } from "./Icons";
import { SpinningDisc } from "./SpinningDisc";
import { TrackArtFallback } from "./TrackArtFallback";
import { MiniSearchPanel } from "./MiniSearchPanel";
import TagPopover from "./TagPopover";
import { NowPlayingInfoCycler, MarqueeText, initialCycleState } from "./NowPlayingInfoCycler";
import type { NowPlayingInfoResolved } from "../hooks/useNowPlayingInfo";
import type { InvokeInfoFetch } from "../hooks/useCommunityTags";
import "./NowPlayingBar.css";

const mod = navigator.platform.includes("Mac") ? "\u2318" : "Ctrl+";
const isMac = navigator.platform.includes("Mac");

/** Album art that preloads the next image and crossfades it in once decoded, so
 *  a track change never flashes a blank frame while the new art is still
 *  loading. Keying the <img> on the *loaded* src (not the requested one) means
 *  the CSS `art-in` fade only runs against an already-decoded, cached image. */
function CrossfadeArt({ src, className }: { src: string | undefined; className: string }) {
  const [loaded, setLoaded] = useState(src);
  useEffect(() => {
    if (!src || src === loaded) return;
    let cancelled = false;
    const img = new Image();
    const settle = () => { if (!cancelled) setLoaded(src); };
    img.onload = settle;
    img.onerror = settle; // swap anyway so a broken url doesn't freeze old art
    img.src = src;
    return () => { cancelled = true; };
  }, [src, loaded]);
  if (!loaded) return null;
  return <img className={className} key={loaded} src={loaded} alt="" />;
}

// Decide whether the *effective* playback source is a local file, using the winning
// resolver's classified EffectiveSource rather than the track's path scheme: a remote
// track served from a local Library copy plays locally, while a local-path track that
// fell through to a remote resolver plays remotely. Falls back to the path scheme when
// no resolver has reported yet.
function isEffectivelyLocal(track: { path?: string | null }, resolvedSource: ResolvedSource | null): boolean {
  if (resolvedSource) return resolvedSource.effectiveSource.kind === "local";
  return isLocalTrack(track);
}

function SourceIcon({ s = 11, isLocal }: { s?: number; isLocal: boolean }) {
  if (isLocal) {
    return <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 12H2"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" y1="16" x2="6.01" y2="16"/><line x1="10" y1="16" x2="10.01" y2="16"/></svg>;
  }
  return <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>;
}

function SlideText({ text, className }: { text: string; className?: string }) {
  const [key, setKey] = useState(0);
  const prevRef = useRef(text);

  useEffect(() => {
    if (text !== prevRef.current) {
      prevRef.current = text;
      setKey(k => k + 1);
    }
  }, [text]);

  return (
    <span key={key} className={`${className ?? ""} slide-text-enter`}>
      {text}
    </span>
  );
}

interface NowPlayingBarProps {
  waveformPeaks: number[] | null;
  currentTrack: QueueTrack | null;
  /** Native mpv video session active — EQ works on video there (lavfi graph),
   * unlike the browser engine where the <video> isn't in the Web Audio graph. */
  nativeVideoActive: boolean;
  playing: boolean;
  durationSecs: number;
  scrobbled: boolean;
  /** Live ICY StreamTitle for internet-radio streams (mpv engine) — shown in
   * place of the static Artist · Album line, which is empty for stations. */
  icyTitle?: string | null;
  trackRank: number | null;
  volume: number;
  muted: boolean;
  queueMode: QueueMode;
  autoContinueEnabled: boolean;
  autoContinueSameFormat: boolean;
  showAutoContinuePopover: boolean;
  autoContinueWeights: AutoContinueWeights;
  imagePath: string | null;
  miniMode: boolean;
  miniExpanded: boolean;
  miniRestingSize: MiniRestingSize;
  miniWidthSize: MiniWidthSize;
  onCancelCollapseTimer: () => void;
  onBeginMiniDrag?: () => void;
  onCycleRestingSize: () => void;
  onCycleMiniWidth: () => void;
  onToggleMiniMode: () => void;
  onClose: () => void;
  onPause: () => void;
  onStop: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onSeek: (secs: number) => void;
  onVolume: (level: number) => void;
  onMute: () => void;
  eqEnabled: boolean;
  eqMode: EqMode;
  eqPreset: string;
  eqGains: number[];
  eqPreGainDb: number;
  eqBassDb: number;
  eqTrebleDb: number;
  eqCustomPresets: { id: string; name: string; gains: number[] }[];
  onEqEnabledChange: (v: boolean) => void;
  onEqModeChange: (mode: EqMode) => void;
  onEqPresetChange: (id: string) => void;
  onEqGainChange: (bandIndex: number, gainDb: number) => void;
  onEqPreGainChange: (db: number) => void;
  onEqBassChange: (db: number) => void;
  onEqTrebleChange: (db: number) => void;
  onEqResetAll: () => void;
  onEqSaveAs: () => void;
  eqShowBarControl: boolean;
  onEqShowBarControlChange: (v: boolean) => void;
  onToggleQueueMode: () => void;
  onRandomize: () => void;
  queueLength: number;
  onToggleAutoContinue: () => void;
  onToggleAutoContinueSameFormat: () => void;
  onToggleAutoContinuePopover: () => void;
  onAdjustAutoContinueWeight: (key: keyof AutoContinueWeights, value: number) => void;
  onResetAutoContinueWeights: () => void;
  onCloseAutoContinuePopover: () => void;
  onToggleLike: () => void;
  onToggleDislike?: () => void;
  likeDisabled?: boolean;
  onTrackClick: (trackKey: string) => void;
  onNavigateToArtistByName?: (name: string) => void;
  onNavigateToAlbumByName?: (name: string, artistName?: string) => void;
  onNavigateToTagByName?: (name: string) => void;
  playbackError?: string | null;
  resolvedSource?: ResolvedSource | null;
  loadingTrack?: QueueTrack | null;
  onSkipError?: () => void;
  onDownloadTrack?: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  nowPlayingInfo: NowPlayingInfoResolved[];
  miniSearch?: {
    isOpen: boolean;
    query: string;
    results: SearchAllResults;
    items: SearchResultItem[];
    highlightedIndex: number;
    onQueryChange: (q: string) => void;
    onKeyDown: (e: React.KeyboardEvent) => void;
    onResultClick: (item: SearchResultItem, enqueue: boolean) => void;
  };
  getAlbumImage?: (title: string, artistName?: string | null) => string | null;
  getArtistImage?: (name: string) => string | null;
  tagSuggestions?: string[];
  invokeInfoFetch?: InvokeInfoFetch;
  pluginsLoaded?: boolean;
}

export function NowPlayingBar({
  waveformPeaks,
  currentTrack, nativeVideoActive, playing,
  durationSecs, scrobbled,
  icyTitle,
  trackRank,
  volume, muted, queueMode,
  autoContinueEnabled, autoContinueSameFormat, showAutoContinuePopover, autoContinueWeights,
  imagePath, miniMode, miniExpanded, miniRestingSize, miniWidthSize, onCancelCollapseTimer, onBeginMiniDrag, onCycleRestingSize, onCycleMiniWidth, onToggleMiniMode, onClose,
  onPause, onStop, onNext, onPrevious,
  onSeek, onVolume, onMute,
  eqEnabled, eqMode, eqPreset, eqGains, eqPreGainDb, eqBassDb, eqTrebleDb, eqCustomPresets,
  onEqEnabledChange, onEqModeChange, onEqPresetChange, onEqGainChange, onEqPreGainChange, onEqBassChange, onEqTrebleChange, onEqResetAll, onEqSaveAs,
  eqShowBarControl, onEqShowBarControlChange,
  onToggleQueueMode, onRandomize, queueLength,
  onToggleAutoContinue, onToggleAutoContinueSameFormat, onToggleAutoContinuePopover, onAdjustAutoContinueWeight, onResetAutoContinueWeights, onCloseAutoContinuePopover,
  onToggleLike, onToggleDislike, likeDisabled, onTrackClick,
  onNavigateToArtistByName, onNavigateToAlbumByName, onNavigateToTagByName,
  playbackError, resolvedSource, loadingTrack, onSkipError,
  onDownloadTrack,
  onContextMenu,
  nowPlayingInfo,
  miniSearch,
  getAlbumImage,
  getArtistImage,
  tagSuggestions,
  invokeInfoFetch,
  pluginsLoaded,
}: NowPlayingBarProps) {
  // Subscribed here (not passed from App) so the ~4 Hz position tick re-renders
  // only this bar, not the whole tree.
  const positionSecs = usePlaybackPosition();
  const miniDragTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const miniVolumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sourceTooltipOpen, setSourceTooltipOpen] = useState(false);
  const [sourceAnchor, setSourceAnchor] = useState<{ x: number; y: number } | null>(null);
  const [audioProps, setAudioProps] = useState<{ sample_rate?: number; bit_depth?: number; channels?: number; bitrate?: number } | null>(null);
  const sourceHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sourceTooltipRef = useRef<HTMLDivElement | null>(null);
  const [showMiniVolume, setShowMiniVolume] = useState(false);
  // Cycle phase for the mini info line, shared by the compact (ultra) and
  // expanded rows — each renders its own cycler instance, so the phase must
  // live here or hover-expanding would remount the cycler and replay the
  // preview pass on every mouse-over.
  const [miniCycleState, setMiniCycleState] = useState(initialCycleState);
  const [eqOpen, setEqOpen] = useState(false);
  const eqAnchorRef = useRef<HTMLButtonElement>(null);
  const acAnchorRef = useRef<HTMLButtonElement>(null);
  const isVideo = currentTrack ? isVideoTrack(currentTrack) : false;
  // EQ is available for audio always, and for video only on the native mpv
  // engine (lavfi graph on the deck). Browser-engine video can't be EQ'd —
  // its <video> element isn't wired into the Web Audio graph.
  const eqAvailable = !isVideo || nativeVideoActive;
  // Tags for the current track, shown inline in the subtitle. The track is a
  // QueueTrack (no DB id), so resolve to a library row by metadata. The tag
  // popover edits keep this in sync via onTagsChange so the subtitle updates live.
  const [trackTags, setTrackTags] = useState<string[]>([]);

  // Blur any focused element when entering mini mode so no button appears selected
  useEffect(() => {
    if (miniMode) (document.activeElement as HTMLElement)?.blur();
  }, [miniMode]);

  // Fetch audio properties for the current track (local files only). Reset on track change.
  useEffect(() => {
    setAudioProps(null);
    if (!currentTrack?.path) return;
    if (!isLocalTrack(currentTrack)) return;
    let cancelled = false;
    invoke<{ sample_rate?: number; bit_depth?: number; channels?: number; bitrate?: number }>(
      "get_audio_properties_by_path",
      { path: currentTrack.path }
    )
      .then(p => { if (!cancelled) setAudioProps(p); })
      .catch(e => console.error("Failed to load audio properties:", e));
    return () => { cancelled = true; };
  }, [currentTrack?.path]);

  // Load tags for the current track (library tracks only). Reset on track change.
  useEffect(() => {
    setTrackTags([]);
    if (!currentTrack) return;
    let cancelled = false;
    invoke<{ id: number } | null>("find_track_by_metadata", {
      title: currentTrack.title,
      artistName: currentTrack.artist_name ?? null,
      albumName: currentTrack.album_title ?? null,
    })
      .then((lib) => {
        if (cancelled || !lib) return;
        invoke<Array<{ id: number; name: string }>>("get_tags_for_track", { trackId: lib.id })
          .then((rows) => { if (!cancelled) setTrackTags(rows.map((r) => r.name)); })
          .catch((e) => console.error("Failed to load tags for now-playing track:", e));
      })
      .catch((e) => console.error("Failed to resolve now-playing track:", e));
    return () => { cancelled = true; };
  }, [currentTrack?.title, currentTrack?.artist_name, currentTrack?.album_title]);

  // Auto-skip on error in mini mode (5s)
  useEffect(() => {
    if (!miniMode || !playbackError || !onSkipError) return;
    const timer = setTimeout(onSkipError, 5000);
    return () => clearTimeout(timer);
  }, [miniMode, playbackError, onSkipError]);

  if (miniMode) {
    const handleDrag = isMac
      ? (e: React.MouseEvent) => {
          // macOS: startDragging doesn't enter a modal loop, so dblclick fires normally
          if ((e.target as HTMLElement).closest("button")) return;
          if (e.buttons === 1) { onBeginMiniDrag?.(); getCurrentWindow().startDragging(); }
        }
      : (e: React.MouseEvent) => {
          // Windows: delay startDragging so the OS modal drag loop doesn't swallow the second click
          if ((e.target as HTMLElement).closest("button")) return;
          if (e.buttons !== 1) return;
          e.preventDefault();
          if (e.detail === 2) {
            if (miniDragTimerRef.current) { clearTimeout(miniDragTimerRef.current); miniDragTimerRef.current = null; }
            onToggleMiniMode();
          } else {
            miniDragTimerRef.current = setTimeout(() => {
              miniDragTimerRef.current = null;
              onBeginMiniDrag?.();
              getCurrentWindow().startDragging();
            }, 100);
          }
        };
    const progress = durationSecs > 0 ? (positionSecs / durationSecs) * 100 : 0;
    return (
      <footer className={`now-playing now-playing-mini${miniExpanded ? " mini-expanded" : ""}`} onMouseDown={handleDrag} onContextMenu={(e) => {
          e.preventDefault();
          onContextMenu?.(e);
        }} onWheel={(e) => {
          e.preventDefault();
          onVolume(Math.min(1, Math.max(0, volume + (e.deltaY < 0 ? 0.05 : -0.05))));
          setShowMiniVolume(true);
          if (miniVolumeTimerRef.current) clearTimeout(miniVolumeTimerRef.current);
          miniVolumeTimerRef.current = setTimeout(() => setShowMiniVolume(false), 1000);
        }} onDoubleClick={isMac ? (e) => {
          if (!(e.target as HTMLElement).closest("button")) onToggleMiniMode();
        } : undefined}>
        {miniSearch?.isOpen && getAlbumImage && getArtistImage ? (
          <MiniSearchPanel
            query={miniSearch.query}
            onQueryChange={miniSearch.onQueryChange}
            results={miniSearch.results}
            items={miniSearch.items}
            highlightedIndex={miniSearch.highlightedIndex}
            onKeyDown={miniSearch.onKeyDown}
            onResultClick={miniSearch.onResultClick}
            getAlbumImage={getAlbumImage}
            getArtistImage={getArtistImage}
          />
        ) : (
          <>
        {miniExpanded || miniRestingSize === "normal" ? (
          <div className="mini-compact-row">
            <div className="now-info">
              <div className="now-mini-art-wrapper">
                {imagePath ? (
                  <CrossfadeArt className="now-mini-art" src={resolveImageUrl(imagePath)} />
                ) : (
                  <div className="now-mini-art now-mini-art-placeholder">
                    <TrackArtFallback track={currentTrack ?? {}} size={18} />
                  </div>
                )}
              </div>
              <div className="now-mini-info-text">
                {playbackError ? (
                  <>
                    <span className="now-title now-mini-error">Playback failed</span>
                    <span className="now-artist">{currentTrack?.title || "Unknown"}</span>
                  </>
                ) : currentTrack ? (
                  <>
                    <span className="now-title">
                      {currentTrack.liked === 1 && <IconHeartFilled size={11} className="mini-ultra-heart" />}
                      {currentTrack.title}
                      {trackRank != null && trackRank <= 100 && <span className="now-rank-badge" title={`Track rank #${trackRank}`}>#{trackRank}</span>}
                    </span>
                    {showMiniVolume ? (
                      <div className={`mini-volume-row${muted ? " is-muted" : ""}`}>
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3z"/>{!muted && volume > 0 && <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/>}{!muted && volume > 0.5 && <path d="M19 12c0 3.53-2.04 6.58-5 8.05v2.08c4.12-1.57 7-5.47 7-10.13s-2.88-8.56-7-10.13V3.95c2.96 1.47 5 4.52 5 8.05z"/>}</svg>
                        <div className="mini-volume-track">
                          <div className="mini-volume-fill" style={{ width: `${Math.round(volume * 100)}%` }} />
                        </div>
                        <span className="mini-volume-pct">{muted ? "muted" : `${Math.round(volume * 100)}%`}</span>
                      </div>
                    ) : (
                      <NowPlayingInfoCycler
                        plain
                        marquee
                        className="now-artist"
                        items={nowPlayingInfo}
                        sep=" · "
                        fallbackText={currentTrack.artist_name || "Unknown"}
                        cycleResetKey={currentTrack.key}
                        cycleState={miniCycleState}
                        onCycleState={setMiniCycleState}
                      />
                    )}
                  </>
                ) : loadingTrack ? (
                  <>
                    <span className="now-title"><SlideText text={loadingTrack.title} /></span>
                    <span className="now-artist">
                      <span className="now-resolving-trying">Loading...</span>
                    </span>
                  </>
                ) : (
                  <span className="now-title">No track playing</span>
                )}
              </div>
            </div>
            <div className="mini-right">
              <div className="now-controls">
                <button className="g-btn g-btn-md mini-play-btn" onClick={onPause} title="Play / Pause">
                  <span className="now-play-icon" key={playing ? "pause" : "play"}>
                    {playing
                      ? <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
                      : <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>}
                  </span>
                </button>
                <button className="g-btn g-btn-sm" onClick={onNext} title="Next">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M16 6h2v12h-2zm-2 6L6 18V6z"/></svg>
                </button>
              </div>
            </div>
            {!miniExpanded && <div className="mini-progress" style={{ transform: `scaleX(${progress / 100})` }} />}
          </div>
        ) : (
          <div className="mini-ultra-row">
            {currentTrack && <SpinningDisc size={14} playing={playing} />}
            {currentTrack && currentTrack.liked === 1 && (
              <IconHeartFilled size={11} className="mini-ultra-heart" />
            )}
            {playbackError ? (
              <span className="mini-ultra-title">Playback failed</span>
            ) : currentTrack ? (
              <MarqueeText className="mini-ultra-title" enabled restartKey={currentTrack.key}>
                <span className="mini-ultra-track">{currentTrack.title}</span>
                <span className="mini-ultra-sep"> — </span>
                <NowPlayingInfoCycler plain className="mini-ultra-artist" items={nowPlayingInfo} sep=" · " fallbackText={currentTrack.artist_name || "Unknown"} cycleResetKey={currentTrack.key} cycleState={miniCycleState} onCycleState={setMiniCycleState} />
              </MarqueeText>
            ) : loadingTrack ? (
              <span className="mini-ultra-title">{`Loading ${loadingTrack.title}…`}</span>
            ) : (
              <span className="mini-ultra-title">No track playing</span>
            )}
            <div className="mini-progress" style={{ transform: `scaleX(${progress / 100})` }} />
          </div>
        )}
        {miniExpanded && (
          <>
            <div className="mini-seek-row" onMouseDown={(e) => e.stopPropagation()}>
              <span className="mini-seek-time">{formatDuration(positionSecs)}</span>
              <div className="mini-seek-track" onClick={(e) => {
                if (!durationSecs) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                onSeek(pct * durationSecs);
              }}>
                <div className="mini-seek-fill" style={{ width: `${progress}%` }} />
              </div>
              <span className="mini-seek-time mini-seek-total">{formatDuration(durationSecs)}</span>
            </div>
            <div className="mini-extra-row">
              <div className="mini-extra-left">
                {currentTrack && (
                  <LikeDislikeButtons
                    liked={currentTrack.liked}
                    onToggleLike={onToggleLike}
                    onToggleDislike={onToggleDislike}
                    disabled={likeDisabled}
                    variant="glass"
                    size={12}
                  />
                )}
              </div>
              <div className="mini-extra-right">
                <button className="g-btn g-btn-sm" onClick={onPrevious} title="Previous">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
                </button>
                <button
                  className="g-btn g-btn-sm"
                  onClick={onCycleMiniWidth}
                  title={`Width: ${miniWidthSize === "small" ? "Small" : miniWidthSize === "medium" ? "Medium" : "Large"}`}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8l4 4-4 4"/><path d="M6 8l-4 4 4 4"/><line x1="2" y1="12" x2="22" y2="12"/></svg>
                </button>
                <button
                  className="g-btn g-btn-rect mini-resting-size-btn"
                  onClick={onCycleRestingSize}
                  title={miniRestingSize === "normal" ? "Switch to compact" : "Switch to normal"}
                >
                  <svg width="12" height="10" viewBox="0 0 24 16" fill="none">
                    <rect x="2" y="2" width="20" height="4" rx="1.5" fill="currentColor" opacity={miniRestingSize === "normal" ? 1 : 0.25} />
                    <rect x="5" y="11" width="14" height="2" rx="1" fill="currentColor" opacity={miniRestingSize === "compact" ? 1 : 0.25} />
                  </svg>
                  <span className="mini-resting-size-label">{miniRestingSize === "normal" ? "Normal" : "Compact"}</span>
                </button>
                <button className="g-btn mini-expand-btn" onClick={() => { onCancelCollapseTimer(); onToggleMiniMode(); }} title="Exit mini mode">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="8" height="8" rx="1"/><rect x="14" y="14" width="8" height="8" rx="1"/></svg>
                </button>
                <button className="g-btn mini-close-btn" onClick={() => { onCancelCollapseTimer(); onClose(); }} title="Close">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>
            </div>
          </>
        )}
          </>
        )}
      </footer>
    );
  }

  return (
    <footer className="now-playing">
      <div
        className="now-seek-bar"
        onClick={(e) => {
          if (!durationSecs) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const pct = (e.clientX - rect.left) / rect.width;
          onSeek(pct * durationSecs);
        }}
      >
        {waveformPeaks ? (
          <WaveformSeekBar
            peaks={waveformPeaks}
            progress={durationSecs > 0 ? positionSecs / durationSecs : 0}
            accentColor="rgba(83, 168, 255, 0.7)"
            dimColor="rgba(255, 255, 255, 0.15)"
          />
        ) : durationSecs > 0 ? (
          <SegmentedSeekBar
            progress={positionSecs / durationSecs}
            durationSecs={durationSecs}
          />
        ) : null}
        <span className="now-seek-time now-seek-elapsed">{formatDuration(positionSecs)}</span>
        <span className="now-seek-time now-seek-total">
          {formatDuration(durationSecs)}
          {scrobbled && <span className="now-scrobbled" title="Logged to play history">{"\u2713"}</span>}
        </span>
      </div>
      <div className="now-main">
        <div className="now-info">
          <div className={`now-art-wrapper${playing ? " playing" : ""}`}>
            {imagePath ? (
              <CrossfadeArt className="now-art" src={resolveImageUrl(imagePath)} />
            ) : (
              <div className="now-art now-art-placeholder">
                <TrackArtFallback track={currentTrack ?? {}} size={24} />
              </div>
            )}
          </div>
          <div className="now-like-col">
            {currentTrack && (
              <LikeDislikeButtons
                liked={currentTrack.liked}
                onToggleLike={onToggleLike}
                onToggleDislike={onToggleDislike}
                disabled={likeDisabled}
                variant="glass"
                size={13}
                showKeyboardHint={`(${mod}L)`}
              />
            )}
          </div>
          <div className="now-info-text">
            {currentTrack ? (
              <>
                <span className="now-title-row">
                  <MarqueeText
                    className="now-title now-link"
                    enabled
                    restartKey={currentTrack.key}
                    onClick={() => onTrackClick(currentTrack.key)}
                    title={currentTrack.title}
                  >
                    <SlideText text={currentTrack.title} />
                    {trackRank != null && trackRank <= 100 && <span className="now-rank-badge" title={`Track rank #${trackRank}`}>#{trackRank}</span>}
                  </MarqueeText>
                  {/* Visibility + which downloader are decided upstream by
                      `decideDownload` (the EffectiveSource of the winning resolver);
                      `onDownloadTrack` is only set when a downloader owns the source. */}
                  {onDownloadTrack && (
                    <button
                      className="now-download-btn"
                      onClick={onDownloadTrack}
                      title="Download track"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                    </button>
                  )}
                </span>
                <span className="now-subtitle">
                  {(() => {
                        const isLocal = isEffectivelyLocal(currentTrack, resolvedSource ?? null);
                        const es = resolvedSource?.effectiveSource;
                        // Prefer the effective source for the local/subsonic cases (so a
                        // Library row that streams from Subsonic reads "Subsonic", not "Library").
                        const sourceName = es?.kind === "local" ? "Local"
                          : es?.kind === "subsonic" ? "Subsonic"
                          : resolvedSource?.name && resolvedSource.name !== "Library" ? resolvedSource.name
                          : isLocal ? "Local" : "Remote";
                        const openTooltip = (rect: DOMRect) => {
                          if (sourceHoverTimerRef.current) { clearTimeout(sourceHoverTimerRef.current); sourceHoverTimerRef.current = null; }
                          setSourceAnchor({ x: rect.left, y: rect.top - 8 });
                          setSourceTooltipOpen(true);
                        };
                        const scheduleClose = () => {
                          if (sourceHoverTimerRef.current) clearTimeout(sourceHoverTimerRef.current);
                          sourceHoverTimerRef.current = setTimeout(() => setSourceTooltipOpen(false), 150);
                        };
                        return <span
                          className="now-source-icon"
                          role="button"
                          tabIndex={0}
                          aria-label={`Playback source: ${sourceName}. Show details.`}
                          onMouseEnter={(e) => openTooltip(e.currentTarget.getBoundingClientRect())}
                          onMouseLeave={scheduleClose}
                          onFocus={(e) => openTooltip(e.currentTarget.getBoundingClientRect())}
                          onBlur={scheduleClose}
                          onKeyDown={(e) => {
                            if (e.key === "Escape") setSourceTooltipOpen(false);
                          }}
                        ><SourceIcon isLocal={isLocal} /></span>;
                  })()}
                  {/* Static artist · album. The cycling Now Playing info section
                      (Quality, Source, Plays, Tags, …) lives only in the mini
                      player now — the full bar keeps a plain, always-visible line.
                      For live radio streams the ICY "now streaming" title takes
                      this slot instead (stations have no artist/album). */}
                  {icyTitle ? (
                    <span className="now-artist-album" title={icyTitle}>
                      <span className="slide-text-enter" key={icyTitle}>{icyTitle}</span>
                    </span>
                  ) : (
                  <span className="now-artist-album">
                    {currentTrack.artist_name ? (
                      <span
                        className="now-link"
                        onClick={() => onNavigateToArtistByName?.(currentTrack.artist_name!)}
                      >{currentTrack.artist_name}</span>
                    ) : (
                      <span>Unknown</span>
                    )}
                    {currentTrack.album_title && (
                      <>
                        <span className="now-sep"> · </span>
                        <span
                          className="now-link"
                          onClick={() => onNavigateToAlbumByName?.(currentTrack.album_title!, currentTrack.artist_name ?? undefined)}
                        >{currentTrack.album_title}</span>
                      </>
                    )}
                  </span>
                  )}
                  {!miniMode && (
                    <TagPopover track={currentTrack} suggestions={tagSuggestions ?? []} invokeInfoFetch={invokeInfoFetch} pluginsLoaded={pluginsLoaded} onTagsChange={setTrackTags} />
                  )}
                  {trackTags.length > 0 && (
                    <span className="now-tags">
                      {trackTags.map((t) => (
                        <span
                          key={t}
                          className="now-tag now-link"
                          onClick={onNavigateToTagByName ? () => onNavigateToTagByName(t) : undefined}
                          title={`Go to #${t}`}
                        >#{t}</span>
                      ))}
                    </span>
                  )}
                </span>
              </>
            ) : loadingTrack ? (
              <>
                <span className="now-title"><SlideText text={loadingTrack.title} /></span>
                <span className="now-subtitle">
                  <span className="now-resolving-trying">Loading...</span>
                </span>
              </>
            ) : (
              <span className="now-title">No track playing</span>
            )}
          </div>
        </div>
        <div className="now-controls">
          <button className="g-btn g-btn-md" onClick={onPrevious} title={`Previous (${mod}\u2190)`}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
          </button>
          <button className="g-btn g-btn-play" onClick={onPause} title="Play / Pause (Space)">
            <span className="now-play-icon" key={playing ? "pause" : "play"}>
              {playing
                ? <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
                : <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>}
            </span>
          </button>
          <button className="g-btn g-btn-md" onClick={onNext} title={`Next (${mod}\u2192)`}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M16 6h2v12h-2zm-2 6L6 18V6z"/></svg>
          </button>
          <button className="g-btn g-btn-xs" onClick={onStop} title="Stop">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
          </button>
        </div>
      <div className="now-right">
        {/* Playlist group: queue mode · randomize · auto-continue */}
        <div className="now-group now-group--playlist" role="group" aria-label="Playlist controls">
          <button
            className={`g-btn g-btn-sm${queueMode !== "normal" ? " active" : ""}`}
            onClick={onToggleQueueMode}
            title={queueMode === "normal" ? "Normal" : queueMode === "repeat-all" ? "Repeat All" : "Repeat One"}
          >
            {queueMode === "repeat-one"
              ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M11.5 9 13 8.3V16"/></svg>
              : queueMode === "repeat-all"
              ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
              : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>}
          </button>
          <button
            className="g-btn g-btn-sm"
            onClick={onRandomize}
            disabled={queueMode === "repeat-one" || queueLength < 2}
            title="Randomize queue order"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><path d="M16 8h.01"/><path d="M8 8h.01"/><path d="M8 16h.01"/><path d="M16 16h.01"/><path d="M12 12h.01"/></svg>
          </button>
          <div className="auto-continue-wrapper">
            <button
              ref={acAnchorRef}
              className={`g-btn g-btn-sm${autoContinueEnabled && queueMode === "normal" ? " active" : ""}`}
              onClick={onToggleAutoContinuePopover}
              disabled={queueMode !== "normal"}
              title={queueMode === "normal" ? "Auto Continue" : "Auto Continue (only in Normal mode)"}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 12c-2-2.67-4-4-6-4a4 4 0 1 0 0 8c2 0 4-1.33 6-4zm0 0c2 2.67 4 4 6 4a4 4 0 0 0 0-8c-2 0-4 1.33-6 4z"/></svg>
            </button>
            {showAutoContinuePopover && (
              <AutoContinuePopover
                enabled={autoContinueEnabled}
                sameFormat={autoContinueSameFormat}
                weights={autoContinueWeights}
                onToggle={onToggleAutoContinue}
                onToggleSameFormat={onToggleAutoContinueSameFormat}
                onAdjust={onAdjustAutoContinueWeight}
                onResetAll={onResetAutoContinueWeights}
                onClose={onCloseAutoContinuePopover}
                anchorRef={acAnchorRef}
              />
            )}
          </div>
        </div>

        {/* Audio group: equalizer (+ inline knobs) · mute · volume */}
        <div className="now-group now-group--audio" role="group" aria-label="Audio controls">
          {eqAvailable && eqShowBarControl && (
            <EqBarControl
              mode={eqMode}
              enabled={eqEnabled}
              bassDb={eqBassDb}
              trebleDb={eqTrebleDb}
              gains={eqGains}
              preGainDb={eqPreGainDb}
              onBassChange={onEqBassChange}
              onTrebleChange={onEqTrebleChange}
              onEnsureEnabled={() => { if (!eqEnabled) onEqEnabledChange(true); }}
            />
          )}
          <div className="now-eq-wrapper" style={{ position: "relative" }}>
            <button
              ref={eqAnchorRef}
              className={`g-btn g-btn-sm now-playing-eq-btn ${eqEnabled && (eqMode === "simple" ? (eqBassDb !== 0 || eqTrebleDb !== 0) : eqPreset !== "flat") ? "active" : ""}`}
              onClick={() => eqAvailable && setEqOpen(o => !o)}
              disabled={!eqAvailable}
              title={eqAvailable ? "Equalizer" : "EQ unavailable for video on the browser engine"}
              aria-label="Equalizer"
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <rect x="2" y="6" width="2" height="8" />
                <rect x="7" y="2" width="2" height="12" />
                <rect x="12" y="9" width="2" height="5" />
              </svg>
            </button>
            {eqOpen && eqAvailable && (
              <EqPopover
                enabled={eqEnabled}
                mode={eqMode}
                preset={eqPreset}
                gains={eqGains}
                preGainDb={eqPreGainDb}
                bassDb={eqBassDb}
                trebleDb={eqTrebleDb}
                customPresets={eqCustomPresets}
                onEnabledChange={onEqEnabledChange}
                onModeChange={onEqModeChange}
                onPresetChange={onEqPresetChange}
                onGainChange={onEqGainChange}
                onPreGainChange={onEqPreGainChange}
                onBassChange={onEqBassChange}
                onTrebleChange={onEqTrebleChange}
                onResetAll={onEqResetAll}
                onSaveAs={onEqSaveAs}
                showBarControl={eqShowBarControl}
                onShowBarControlChange={onEqShowBarControlChange}
                onClose={() => setEqOpen(false)}
                anchorRef={eqAnchorRef}
              />
            )}
          </div>
          <div className="now-volume">
            <button className={`g-btn g-btn-sm${muted ? " is-muted" : ""}`} onClick={onMute} title={`Mute (${mod}M)`}>
              {muted || volume === 0
                ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>
                : volume < 0.5
                ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
                : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>}
            </button>
            <input
              type="range"
              className={`volume-slider${muted ? " is-muted" : ""}`}
              min="0"
              max="1"
              step="0.01"
              value={volume}
              style={{ background: `linear-gradient(to right, ${muted ? "var(--text-tertiary)" : "var(--accent)"} ${volume * 100}%, rgba(255,255,255,0.12) ${volume * 100}%)` }}
              onChange={(e) => onVolume(parseFloat(e.target.value))}
            />
          </div>
        </div>
      </div>
      </div>
      {sourceTooltipOpen && sourceAnchor && currentTrack && (() => {
        const path = currentTrack.path ?? "";
        const isSubsonic = path.startsWith("subsonic://");
        const isLocal = isLocalTrack(currentTrack);
        const resolverName = resolvedSource?.name;
        const sourceUrl = resolvedSource?.sourceUrl ?? null;

        let pluginProtocol: string | null = null;
        if (!isLocal && !isSubsonic && path.includes("://") && !path.startsWith("external://") && !path.startsWith("http://") && !path.startsWith("https://")) {
          pluginProtocol = path.substring(0, path.indexOf("://"));
        }

        // The resolver names itself (e.g. "YouTube", "TIDAL") — the host does not
        // special-case individual plugin ids here. "Library" is internal: its
        // effective source decides whether it reads "Local" or "Subsonic" (a Library
        // row can stream from a Subsonic server), else it falls through to a
        // path-derived label.
        const es = resolvedSource?.effectiveSource;
        const sourceLabel = es?.kind === "local" ? "Local"
          : es?.kind === "subsonic" ? "Subsonic"
          : resolverName && resolverName !== "Library" ? resolverName
          : pluginProtocol ? pluginProtocol.charAt(0).toUpperCase() + pluginProtocol.slice(1)
            : isSubsonic ? "Subsonic" : isLocal ? "Local" : (resolverName || "Unknown");

        const localPath = isLocal ? path.replace(/^file:\/\//, "") : null;
        // Library fallback: sourceUrl is the local file path
        const libraryFallbackPath = resolverName === "Library" && sourceUrl ? sourceUrl : null;
        const displayPath = localPath || libraryFallbackPath;

        // External link for the "open URL" action. Derived generically from the
        // resolver's reported sourceUrl — any plugin that returns an http(s) source
        // (YouTube, TIDAL, …) gets an "Open on <resolver>" button for free.
        let externalUrl: string | null = null;
        let externalLabel: string | null = null;
        if (sourceUrl && (sourceUrl.startsWith("http://") || sourceUrl.startsWith("https://"))) {
          externalUrl = sourceUrl;
          externalLabel = sourceLabel && sourceLabel !== "Unknown" ? `Open on ${sourceLabel}` : "Open link";
        } else if (isSubsonic && resolvedSource) {
          try {
            const u = new URL(resolvedSource.url);
            externalUrl = `${u.protocol}//${u.host}`;
            externalLabel = "Open server";
          } catch { /* ignore */ }
        }

        // Rows
        const rows: Array<[string, React.ReactNode]> = [];
        if (currentTrack.format) rows.push(["format", currentTrack.format.toUpperCase()]);
        if (audioProps?.bitrate) rows.push(["bitrate", `${audioProps.bitrate} kbps`]);
        if (audioProps?.sample_rate) {
          const depth = audioProps.bit_depth ? ` · ${audioProps.bit_depth}-bit` : "";
          rows.push(["quality", `${(audioProps.sample_rate / 1000).toFixed(1)} kHz${depth}`]);
        }
        if (audioProps?.channels) {
          const label = audioProps.channels === 1 ? "Mono" : audioProps.channels === 2 ? "Stereo" : `${audioProps.channels} ch`;
          rows.push(["channels", label]);
        }
        if (displayPath) rows.push(["path", <span className="now-source-path" title={displayPath}>{displayPath}</span>]);
        if (sourceUrl && !displayPath && !sourceUrl.startsWith("file://")) {
          rows.push(["source", <span className="now-source-path" title={sourceUrl}>{sourceUrl}</span>]);
        } else if (!displayPath && !sourceUrl && !isLocal && resolvedSource) {
          try {
            const u = new URL(resolvedSource.url);
            rows.push(["host", u.hostname]);
          } catch { /* ignore */ }
        }

        return (
          <div
            ref={sourceTooltipRef}
            className="ds-tooltip visible now-source-tooltip"
            style={{ left: sourceAnchor.x, top: sourceAnchor.y, transform: "translateY(-100%)" }}
            onMouseEnter={() => {
              if (sourceHoverTimerRef.current) { clearTimeout(sourceHoverTimerRef.current); sourceHoverTimerRef.current = null; }
            }}
            onMouseLeave={() => setSourceTooltipOpen(false)}
          >
            <div className="ds-tooltip-title">{sourceLabel}</div>
            {rows.length > 0 && (
              <div className="ds-tooltip-rows">
                {rows.map(([k, v]) => (
                  <div key={k} className="ds-tooltip-row">
                    <span className="ds-tooltip-key">{k}</span>
                    <span className="ds-tooltip-val">{v}</span>
                  </div>
                ))}
              </div>
            )}
            {(displayPath || externalUrl) && (
              <div className="now-source-actions">
                {displayPath && (
                  <button
                    className="ds-btn ds-btn--ghost ds-btn--sm"
                    onClick={() => {
                      invoke("show_in_folder_path", { filePath: displayPath }).catch(e => console.error("Failed to show in folder:", e));
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                    Open folder
                  </button>
                )}
                {externalUrl && (
                  <button
                    className="ds-btn ds-btn--ghost ds-btn--sm"
                    onClick={() => {
                      openUrl(externalUrl!).catch(e => console.error("Failed to open URL:", e));
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                    {externalLabel}
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })()}
    </footer>
  );
}
