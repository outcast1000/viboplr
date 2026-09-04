import { useState, useEffect, useRef, useCallback } from "react";
import type { QueueTrack, QueueMode, ResolvedSource } from "../types";
import { resolveImageUrl } from "../utils/resolveImageUrl";
import type { AutoContinueWeights } from "../hooks/useAutoContinue";
import { formatDuration, isVideoTrack } from "../utils";
import { usePlaybackPosition } from "../playback/positionStore";
import { useIdleVisibility } from "../hooks/useIdleVisibility";
import { SeekLadder, SeekHoverBubble, seekHoverAt, hasFilmstrip, type SeekHover } from "./SeekSurface";
import { TransportButtons, QueueModeGroup, VolumeControl } from "./TransportControls";
import { EqControlGroup, type EqControls } from "./EqButton";
import { SourceIndicator } from "./SourceIndicator";
import type { Storyboard } from "../utils/storyboard";
import { LikeDislikeButtons } from "./LikeDislikeButtons";
import { BufferingChip } from "./BufferingChip";
import { bufferedFraction } from "../playback/bufferState";
import { usePlaybackBuffer } from "../playback/bufferStore";

interface FullscreenControlsProps {
  waveformPeaks: number[] | null;
  /** Seek-preview tiles for the current video track; null for audio. */
  storyboard: Storyboard | null;
  currentTrack: QueueTrack | null;
  playing: boolean;
  durationSecs: number;
  scrobbled: boolean;
  volume: number;
  muted: boolean;
  queueMode: QueueMode;
  autoContinueEnabled: boolean;
  autoContinueSameFormat: boolean;
  showAutoContinuePopover: boolean;
  autoContinueWeights: AutoContinueWeights;
  imagePath: string | null;
  onPause: () => void;
  onStop: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onSeek: (secs: number) => void;
  onVolume: (level: number) => void;
  onMute: () => void;
  onToggleQueueMode: () => void;
  onToggleAutoContinue: () => void;
  onToggleAutoContinueSameFormat: () => void;
  onToggleAutoContinuePopover: () => void;
  onAdjustAutoContinueWeight: (key: keyof AutoContinueWeights, value: number) => void;
  onResetAutoContinueWeights: () => void;
  onCloseAutoContinuePopover: () => void;
  onToggleLike: () => void;
  onToggleDislike?: () => void;
  /** Leave fullscreen. **Optional**: the audio surface omits it, because its own
      corner action row carries the fullscreen toggle in both directions and two
      exits on one screen is one too many. Video has no corner row, so it passes
      this and the button is its only visible way out besides Escape. */
  onToggleFullscreen?: () => void;
  showQueue?: boolean;
  /** Show/hide the queue. **Optional**, and for the same reason: in audio
      fullscreen the queue reveals itself when the pointer reaches the right edge,
      so a button that toggles it is redundant. Video still passes it. */
  onToggleQueue?: () => void;
  /** Whether synced lyrics exist for the current video (gates the subtitle toggle). */
  hasSubtitles: boolean;
  subtitlesOn: boolean;
  onToggleSubtitles: () => void;
  onNavigateToArtistByName: (name: string) => void;
  onNavigateToAlbumByName: (name: string, artistName?: string | null) => void;
  /** Equalizer state + handlers, the same bundle the now-playing bar builds.
      **Optional** only so a host that has no EQ wiring can omit it; App passes
      it on both surfaces, because "the controls are the same in every
      fullscreen" also means they're the same as the windowed bar's. */
  eq?: EqControls;
  /** Whether mpv is driving the current video — the one case where video can be
      EQ'd. Mirrors the now-playing bar's availability rule. */
  nativeVideoActive?: boolean;
  /** The winning stream resolver, for the `SourceIndicator` on the subtitle line.
      Same prop, same component, same slot as the docked bar. */
  resolvedSource?: ResolvedSource | null;
  /**
   * Treat this as a live fullscreen presentation even though there is no DOM
   * `:fullscreen` element.
   *
   * Two surfaces need it, both of which use WINDOW fullscreen: the audio /
   * visualizer overlay (see AudioFullscreen) and **native mpv video**
   * (`.video-container--native-fs`). In both, `document.fullscreenElement` is
   * null, so the idle auto-hide and the cursor-hiding — both gated on it — never
   * arm and the controls sit permanently over the picture. Only the browser
   * engine's video fullscreen is a real DOM `:fullscreen`, which is detected
   * without help.
   */
  active?: boolean;
}

export function FullscreenControls({
  waveformPeaks,
  storyboard,
  currentTrack, playing,
  durationSecs, scrobbled,
  volume, muted, queueMode,
  autoContinueEnabled, autoContinueSameFormat, showAutoContinuePopover, autoContinueWeights,
  imagePath,
  onPause, onStop, onNext, onPrevious,
  onSeek, onVolume, onMute, onToggleQueueMode,
  onToggleAutoContinue, onToggleAutoContinueSameFormat, onToggleAutoContinuePopover, onAdjustAutoContinueWeight, onResetAutoContinueWeights, onCloseAutoContinuePopover,
  onToggleLike, onToggleDislike, onToggleFullscreen, showQueue, onToggleQueue, hasSubtitles, subtitlesOn, onToggleSubtitles, onNavigateToArtistByName, onNavigateToAlbumByName,
  eq, nativeVideoActive = false, resolvedSource = null,
  active = false,
}: FullscreenControlsProps) {
  // Subscribed here (not passed from App) so the ~4 Hz position tick — and the
  // buffer readout while a stream fills — re-render only this overlay.
  const positionSecs = usePlaybackPosition();
  const buffer = usePlaybackBuffer();
  const bufferedPct = bufferedFraction(buffer?.bufferedToSecs ?? null, durationSecs);
  const [domFullscreen, setDomFullscreen] = useState(false);
  // Either kind of fullscreen counts: the video path uses a DOM :fullscreen
  // element, the audio path uses window fullscreen + a pinned overlay.
  const isFullscreen = active || domFullscreen;
  // Same rule as the now-playing bar: audio always, video only under mpv.
  const eqAvailable = !currentTrack || !isVideoTrack(currentTrack) || nativeVideoActive;
  const overlayRef = useRef<HTMLDivElement>(null);
  // Scrub preview: pct picks the storyboard tile, x positions the bubble
  // (px within .fs-seek-wrap).
  const [seekHover, setSeekHover] = useState<SeekHover | null>(null);
  const seekWrapRef = useRef<HTMLDivElement>(null);

  // Show on movement over the fullscreen container (our parent), hide after the
  // idle wait, stay up while paused and while something is holding it. Only
  // armed in fullscreen: docked, `.fs-controls` isn't even rendered.
  const { visible, reset: resetTimer, pin } = useIdleVisibility({
    enabled: isFullscreen,
    hold: !playing,
    getTarget: () => overlayRef.current?.parentElement ?? null,
  });

  // Track DOM fullscreen state. Leaving it re-shows via the hook's `enabled`
  // gate, so there is nothing to unwind here.
  useEffect(() => {
    const onChange = () => setDomFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // The EQ popover is a 600px panel you read as much as you drag, so the idle
  // timer must not yank the bar (and the popover inside it) out from under it.
  // Keyed separately from the drag hold: releasing one must not release the other.
  const handleEqOpenChange = useCallback((open: boolean) => pin("eq", open), [pin]);

  const handleOverlayClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    resetTimer();
  };

  const handleDragStart = () => pin("drag", true);
  const handleDragEnd = () => pin("drag", false);

  // Apply cursor style to fullscreen container
  useEffect(() => {
    if (!isFullscreen) return;
    const container = overlayRef.current?.parentElement;
    if (!container) return;
    container.style.cursor = visible ? "default" : "none";
    return () => { container.style.cursor = ""; };
  }, [isFullscreen, visible]);

  return (
    <div
      ref={overlayRef}
      className={`fs-controls${visible ? " fs-visible" : ""}`}
      onClick={handleOverlayClick}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {/* The bubble has to live outside .fs-seek-bar, which clips (overflow: hidden).
          Mirrors .now-seek-wrap in the now-playing bar. */}
      <div
        className={`fs-seek-wrap${hasFilmstrip(storyboard, durationSecs) ? " has-filmstrip" : ""}`}
        ref={seekWrapRef}
      >
      <div
        className="fs-seek-bar"
        onClick={(e) => {
          if (!durationSecs) return;
          e.stopPropagation();
          const rect = e.currentTarget.getBoundingClientRect();
          const pct = (e.clientX - rect.left) / rect.width;
          onSeek(pct * durationSecs);
        }}
        onMouseMove={(e) => {
          // Deliberately no stopPropagation: the overlay's idle timer watches
          // mousemove, and swallowing it here would hide the controls mid-scrub.
          if (!durationSecs) return;
          setSeekHover(seekHoverAt(e, seekWrapRef.current));
        }}
        onMouseLeave={() => setSeekHover(null)}
      >
        {/* Same ladder as the now-playing bar, by construction — see SeekLadder. */}
        <SeekLadder
          storyboard={storyboard}
          waveformPeaks={waveformPeaks}
          positionSecs={positionSecs}
          durationSecs={durationSecs}
          hoverPct={seekHover?.pct ?? null}
          bufferedPct={bufferedPct}
        />
        <BufferingChip buffer={buffer} />
        <span className="fs-seek-time fs-seek-elapsed">{formatDuration(positionSecs)}</span>
        <span className="fs-seek-time fs-seek-total">
          {formatDuration(durationSecs)}
          {scrobbled && <span className="fs-scrobbled" title="Logged to play history">{"\u2713"}</span>}
        </span>
      </div>
      <SeekHoverBubble
        hover={seekHover}
        storyboard={storyboard}
        positionSecs={positionSecs}
        durationSecs={durationSecs}
        className="fs-seek-bubble"
        deltaClassName="fs-seek-bubble-delta"
      />
      </div>
      <div className="fs-main">
        <div className="fs-info">
          {imagePath && <img className="fs-art" src={resolveImageUrl(imagePath)} alt="" />}
          <div className="fs-like-col">
            {currentTrack && (
              <LikeDislikeButtons
                liked={currentTrack.liked}
                onToggleLike={onToggleLike}
                onToggleDislike={onToggleDislike}
                variant="glass"
                size={13}
              />
            )}
          </div>
          <div className="fs-info-text">
            {currentTrack ? (
              <>
                <span className="fs-title">{currentTrack.title}</span>
                <span className="fs-subtitle">
                  {/* Same indicator, same slot as the docked bar. Fullscreen is
                      where a stream is most likely to be misbehaving, so it is
                      the last place the "where is this coming from" answer
                      should disappear. */}
                  <SourceIndicator track={currentTrack} resolvedSource={resolvedSource ?? null} />
                  <span className="fs-link" onClick={currentTrack.artist_name ? () => onNavigateToArtistByName(currentTrack.artist_name!) : undefined}>{currentTrack.artist_name || "Unknown"}</span>
                  {currentTrack.album_title && (
                    <><span className="fs-sep"> — </span><span className="fs-link" onClick={() => onNavigateToAlbumByName(currentTrack.album_title!, currentTrack.artist_name)}>{currentTrack.album_title}</span></>
                  )}
                </span>
              </>
            ) : null}
          </div>
        </div>
        <TransportButtons
          playing={playing}
          onPrevious={onPrevious}
          onPause={onPause}
          onNext={onNext}
          onStop={onStop}
          className="fs-center"
          playClassName="fs-play-btn"
        />
        <div className="fs-right">
          <div className="fs-group">
          <QueueModeGroup
            queueMode={queueMode}
            onToggleQueueMode={onToggleQueueMode}
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
          {/* Last in this group, immediately before volume — the same slot the
              cluster occupies in the now-playing bar, and the same cluster:
              inline Bass/Treble slot (or curve preview) plus the popover button. */}
          {eq && <EqControlGroup eq={eq} available={eqAvailable} onOpenChange={handleEqOpenChange} />}
          </div>
          <div className="fs-group">
          <VolumeControl
            volume={volume}
            muted={muted}
            onVolume={onVolume}
            onMute={onMute}
            className="fs-volume"
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          />
          </div>
          <div className="fs-group">
          {hasSubtitles && (
            <button
              className={`g-btn g-btn-sm${subtitlesOn ? " active" : ""}`}
              onClick={onToggleSubtitles}
              title={subtitlesOn ? "Hide subtitles" : "Show subtitles"}
              aria-label={subtitlesOn ? "Hide subtitles" : "Show subtitles"}
              aria-pressed={subtitlesOn}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="5" width="18" height="14" rx="2" />
                <path d="M7 14.5a2 2 0 0 1 0-4" />
                <path d="M15 14.5a3 3 0 0 1 0-4" />
              </svg>
            </button>
          )}
          {onToggleQueue && (
            <button
              className={`g-btn g-btn-sm${showQueue ? " active" : ""}`}
              onClick={onToggleQueue}
              title="Playlist"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
            </button>
          )}
          {onToggleFullscreen && (
            <button
              className="g-btn g-btn-sm"
              onClick={onToggleFullscreen}
              title="Exit fullscreen"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="4 14 10 14 10 20" />
                <polyline points="20 10 14 10 14 4" />
                <line x1="14" y1="10" x2="21" y2="3" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            </button>
          )}
          </div>
        </div>
      </div>
    </div>
  );
}
