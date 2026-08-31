import { memo, useCallback, useRef, useState, useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { resolveImageUrl } from "../utils/resolveImageUrl";
import { usePlaybackPosition } from "../playback/positionStore";
import type { QueueTrack, SearchAllResults, SearchResultItem, QueueMode, ResolvedSource } from "../types";
import type { AutoContinueWeights } from "../hooks/useAutoContinue";
import type { MiniRestingSize, MiniWidthSize } from "../hooks/useMiniMode";
import { formatDuration, isVideoTrack } from "../utils";
import { EqControlGroup, type EqControls } from "./EqButton";
import type { EqMode } from "../eqPresets";
import { SeekLadder, SeekHoverBubble, seekHoverAt, hasFilmstrip, type SeekHover } from "./SeekSurface";
import { TransportButtons, QueueModeGroup, VolumeControl } from "./TransportControls";
import { BufferingChip } from "./BufferingChip";
import { bufferedFraction } from "../playback/bufferState";
import { usePlaybackBuffer } from "../playback/bufferStore";
import type { Storyboard } from "../utils/storyboard";
import { LikeDislikeButtons } from "./LikeDislikeButtons";
import { IconHeartFilled } from "./Icons";
import { SpinningDisc } from "./SpinningDisc";
import { TrackArtFallback } from "./TrackArtFallback";
import { MiniSearchPanel } from "./MiniSearchPanel";
import TagPopover from "./TagPopover";
import { NowPlayingInfoCycler, MarqueeText, initialCycleState, type MarqueePlan } from "./NowPlayingInfoCycler";
import type { NowPlayingInfoResolved } from "../hooks/useNowPlayingInfo";
import { SourceIndicator } from "./SourceIndicator";
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
  /** Seek-preview tiles for the current video track; null for audio. */
  storyboard: Storyboard | null;
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
  /** Enter fullscreen for whatever is playing. App dispatches by track kind
      (video → its own path, audio → the overlay), the same callback Cmd/Ctrl+F
      uses — the bar does not decide which surface answers. */
  onToggleFullscreen: () => void;
  /** False when nothing is playing; the button is disabled rather than hidden so
      the right end of the bar doesn't reflow as the queue drains. */
  canFullscreen: boolean;
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

// memo'd: the bar renders on every App state change otherwise (App is its
// parent and re-renders often — queue edits, modal opens, cache landings).
// App.tsx keeps every callback prop identity-stable via useStableCallbacks and
// the object props memoized, so this comparator only fails when data the bar
// actually renders has changed. The ~4 Hz position tick stays out of App state
// entirely (usePlaybackPosition below), so playback time keeps updating inside
// the memo boundary.
export const NowPlayingBar = memo(function NowPlayingBar({
  waveformPeaks,
  storyboard,
  currentTrack, nativeVideoActive, playing,
  durationSecs, scrobbled,
  icyTitle,
  trackRank,
  volume, muted, queueMode,
  autoContinueEnabled, autoContinueSameFormat, showAutoContinuePopover, autoContinueWeights,
  imagePath, miniMode, miniExpanded, miniRestingSize, miniWidthSize, onCancelCollapseTimer, onBeginMiniDrag, onCycleRestingSize, onCycleMiniWidth, onToggleMiniMode, onClose,
  onPause, onStop, onNext, onPrevious,
  onSeek, onVolume, onMute, onToggleFullscreen, canFullscreen,
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
  // Subscribed here (not passed from App) so the ~4 Hz position tick — and the
  // buffer readout, which moves 1-4×/sec while a stream fills — re-render only
  // this bar, not the whole tree.
  const positionSecs = usePlaybackPosition();
  const buffer = usePlaybackBuffer();
  const bufferedPct = bufferedFraction(buffer?.bufferedToSecs ?? null, durationSecs);
  const miniDragTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const miniVolumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showMiniVolume, setShowMiniVolume] = useState(false);
  // Cycle phase for the mini info line, shared by the compact (ultra) and
  // expanded rows — each renders its own cycler instance, so the phase must
  // live here or hover-expanding would remount the cycler and replay the
  // preview pass on every mouse-over.
  const [miniCycleState, setMiniCycleState] = useState(initialCycleState);

  // Compact (ultra) row: when a preempting on-request item (a sung lyric line)
  // is too wide to share the line with the track title, the title yields for
  // that line. `onDisplay` (from the cycler) records what's up and brings the
  // title back the moment the content changes; `onPlan` (from the line's
  // MarqueeText) hides it when the full line overflows while a request is
  // showing. One-way per content instance, so it can't oscillate: hiding
  // shrinks the line, and the next measure (no overflow) takes no action.
  const [ultraTitleYieldedFor, setUltraTitleYieldedFor] = useState<string | null>(null);
  const ultraDisplayRef = useRef({ sig: "", request: false });
  const handleUltraDisplay = useCallback((d: { sig: string; request: boolean }) => {
    ultraDisplayRef.current = d;
    setUltraTitleYieldedFor((prev) => (prev !== null && prev !== d.sig ? null : prev));
  }, []);
  const handleUltraPlan = useCallback((plan: MarqueePlan | null) => {
    if (plan && ultraDisplayRef.current.request) {
      setUltraTitleYieldedFor((prev) => prev ?? ultraDisplayRef.current.sig);
    }
  }, []);
  // Scrub preview over the seek track: pct drives the waveform's ghost tint,
  // x positions the floating time bubble (px within .now-seek-wrap).
  const [seekHover, setSeekHover] = useState<SeekHover | null>(null);
  const seekWrapRef = useRef<HTMLDivElement>(null);
  const isVideo = currentTrack ? isVideoTrack(currentTrack) : false;
  // EQ is available for audio always, and for video only on the native mpv
  // engine (lavfi graph on the deck). Browser-engine video can't be EQ'd —
  // its <video> element isn't wired into the Web Audio graph.
  const eqAvailable = !isVideo || nativeVideoActive;
  // Bundled for EqButton, which the fullscreen bar renders from the same shape.
  const eqControls: EqControls = {
    enabled: eqEnabled, mode: eqMode, preset: eqPreset, gains: eqGains,
    preGainDb: eqPreGainDb, bassDb: eqBassDb, trebleDb: eqTrebleDb,
    customPresets: eqCustomPresets,
    onEnabledChange: onEqEnabledChange, onModeChange: onEqModeChange,
    onPresetChange: onEqPresetChange, onGainChange: onEqGainChange,
    onPreGainChange: onEqPreGainChange, onBassChange: onEqBassChange,
    onTrebleChange: onEqTrebleChange, onResetAll: onEqResetAll, onSaveAs: onEqSaveAs,
    showBarControl: eqShowBarControl, onShowBarControlChange: onEqShowBarControlChange,
  };
  // Tags for the current track, shown inline in the subtitle. The track is a
  // QueueTrack (no DB id), so resolve to a library row by metadata. The tag
  // popover edits keep this in sync via onTagsChange so the subtitle updates live.
  const [trackTags, setTrackTags] = useState<string[]>([]);

  // Blur any focused element when entering mini mode so no button appears selected
  useEffect(() => {
    if (miniMode) (document.activeElement as HTMLElement)?.blur();
  }, [miniMode]);

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
            {playbackError ? (
              <span className="mini-ultra-title">Playback failed</span>
            ) : currentTrack ? (
              <MarqueeText className="mini-ultra-title" enabled restartKey={currentTrack.key} onPlan={handleUltraPlan}>
                {ultraTitleYieldedFor === null && (
                  <>
                    {currentTrack.liked === 1 && <IconHeartFilled size={11} className="mini-ultra-heart" />}
                    <span className="mini-ultra-track">{currentTrack.title}</span>
                    <span className="mini-ultra-sep"> — </span>
                  </>
                )}
                <NowPlayingInfoCycler plain className="mini-ultra-artist" items={nowPlayingInfo} sep=" · " fallbackText={currentTrack.artist_name || "Unknown"} cycleResetKey={currentTrack.key} cycleState={miniCycleState} onCycleState={setMiniCycleState} onDisplay={handleUltraDisplay} />
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
      {/* `has-filmstrip` lets the bar expand on hover (see the CSS) — only worth it
          when the frames ARE the seek surface. */}
      <div
        className={`now-seek-wrap${hasFilmstrip(storyboard, durationSecs) ? " has-filmstrip" : ""}`}
        ref={seekWrapRef}
      >
        <div className="now-seek-bar">
          <span className="now-seek-time now-seek-elapsed">{formatDuration(positionSecs)}</span>
          {/* The waveform lives in its own middle track that flexes between the two
              time labels; the seek math maps against THIS wrapper (not the full bar)
              so the click position still lines up with the visible waveform. */}
          <div
            className="now-seek-track"
            onClick={(e) => {
              if (!durationSecs) return;
              const rect = e.currentTarget.getBoundingClientRect();
              const pct = (e.clientX - rect.left) / rect.width;
              onSeek(pct * durationSecs);
            }}
            onMouseMove={(e) => {
              if (!durationSecs) return;
              setSeekHover(seekHoverAt(e, seekWrapRef.current));
            }}
            onMouseLeave={() => setSeekHover(null)}
          >
            {/* Video never has a waveform (useWaveform bails on it), so where a
                storyboard exists the frames themselves are the seek surface.
                Shared with the fullscreen bar — see SeekLadder. */}
            <SeekLadder
              storyboard={storyboard}
              waveformPeaks={waveformPeaks}
              positionSecs={positionSecs}
              durationSecs={durationSecs}
              hoverPct={seekHover?.pct ?? null}
              bufferedPct={bufferedPct}
            />
            <BufferingChip buffer={buffer} />
          </div>
          <span className="now-seek-time now-seek-total">
            {formatDuration(durationSecs)}
            {scrobbled && <span className="now-scrobbled" title="Logged to play history">{"\u2713"}</span>}
          </span>
        </div>
        <SeekHoverBubble
          hover={seekHover}
          storyboard={storyboard}
          positionSecs={positionSecs}
          durationSecs={durationSecs}
          className="now-seek-bubble"
          deltaClassName="now-seek-bubble-delta"
        />
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
                  <SourceIndicator track={currentTrack} resolvedSource={resolvedSource ?? null} />
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
        <TransportButtons
          playing={playing}
          onPrevious={onPrevious}
          onPause={onPause}
          onNext={onNext}
          onStop={onStop}
          className="now-controls"
        />
      <div className="now-right">
        {/* Playlist group: queue mode · randomize · auto-continue */}
        <div className="now-group now-group--playlist" role="group" aria-label="Playlist controls">
          <QueueModeGroup
            queueMode={queueMode}
            onToggleQueueMode={onToggleQueueMode}
            onRandomize={onRandomize}
            queueLength={queueLength}
            autoContinueEnabled={autoContinueEnabled}
            autoContinueSameFormat={autoContinueSameFormat}
            showAutoContinuePopover={showAutoContinuePopover}
            autoContinueWeights={autoContinueWeights}
            onToggleAutoContinue={onToggleAutoContinue}
            onToggleAutoContinueSameFormat={onToggleAutoContinueSameFormat}
            onToggleAutoContinuePopover={onToggleAutoContinuePopover}
            onAdjustAutoContinueWeight={onAdjustAutoContinueWeight}
            onResetAutoContinueWeights={onResetAutoContinueWeights}
            onCloseAutoContinuePopover={onCloseAutoContinuePopover}
          />
        </div>

        {/* Audio group: equalizer (+ inline knobs) · mute · volume */}
        <div className="now-group now-group--audio" role="group" aria-label="Audio controls">
          <EqControlGroup eq={eqControls} available={eqAvailable} />
          <VolumeControl
            volume={volume}
            muted={muted}
            onVolume={onVolume}
            onMute={onMute}
            className="now-volume"
          />
        </div>

        {/* View group: fullscreen. Last on the right so the control sits in the
            same corner the fullscreen bar's Exit button occupies — one place to
            look, whichever bar is on screen. Enter-only: while fullscreen is up
            this bar is covered (the overlay and the video container both pin
            themselves over the grid), so the restore half of the toggle lives on
            FullscreenControls. */}
        <div className="now-group now-group--view" role="group" aria-label="View controls">
          <button
            className="g-btn g-btn-sm"
            onClick={onToggleFullscreen}
            disabled={!canFullscreen}
            title={canFullscreen ? `Fullscreen (${mod}F)` : "Fullscreen (nothing playing)"}
            aria-label="Enter fullscreen"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 3 21 3 21 9" />
              <polyline points="9 21 3 21 3 15" />
              <line x1="21" y1="3" x2="14" y2="10" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          </button>
        </div>
      </div>
      </div>
    </footer>
  );
});
