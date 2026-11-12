import { useState, useRef, useEffect, useCallback, useMemo, memo } from "react";
import { computeIndexSelection } from "../utils/rowSelection";
import type { QueueTrack, QueueMode } from "../types";
import type { PlaylistContext } from "../hooks/useQueue";
import { sourceNoteChipTitle, type EntrySourceNote, type TrackFailure } from "../playback/trackFailures";
import type { ResolvingStatus } from "../hooks/useStreamResolution";
import { formatDuration, formatFileSize } from "../utils";
import { queueItemLocalThumb, playlistContextTitle, type ThumbInfo } from "../mainPlaylist";
import { extractDominantColor, type RGB } from "../utils/extractDominantColor";
import { resolveImageUrl } from "../utils/resolveImageUrl";
import type { LoadingPlay } from "../hooks/useQueue";
import { QueueLoadFailureRow, QueueLoadingBlock, QueueSwitchBanner } from "./LoadingPlay";
import { resolveTrackImage } from "../utils/trackImage";
import { useImageCache } from "../hooks/useImageCache";
import { useFlipList } from "../hooks/useFlipList";
import { useQueueVideoFrames, shelfVideoKey } from "../hooks/useShelfVideoFrames";
import { SpinningDisc } from "./SpinningDisc";
import { TrackArtFallback } from "./TrackArtFallback";
import { LikeDislikeButtons } from "./LikeDislikeButtons";
import { showNativeMenu } from "../nativeMenu";
import { buildQueueHeaderMenuSpecs } from "../contextMenu/buildQueueHeaderMenuSpecs";
import { useAssignRef } from "../hooks/useLatestRef";
import { useFileSize } from "../hooks/useFileSize";
import "./QueuePanel.css";


function formatTotalDuration(tracks: QueueTrack[]): string {
  const totalSecs = tracks.reduce((sum, t) => sum + (t.duration_secs ?? 0), 0);
  const hours = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export function formatPlaylistSource(source: string | null | undefined): string | null {
  if (!source) return null;
  const s = source.toLowerCase().trim();
  if (!s) return null;
  const known: Record<string, string> = {
    album: "Playing from album",
    artist: "Playing from artist",
    tag: "Playing from tag",
    playlist: "Playing from playlist",
  };
  if (known[s]) return known[s];
  // Plugins often pass a URI (`spotify://playlists/<id>`) as the source. The
  // raw id is noise in a heading, so name only the service and the kind of
  // thing ("spotify playlist"); the full URI stays in the info popover.
  const uri = /^([a-z][a-z0-9+.-]*):(?:\/\/)?([a-z]+)?/.exec(s);
  if (uri && s.includes(":")) {
    const kind = uri[2] ? uri[2].replace(/s$/, "") : "";
    return `Playing from ${kind ? `${uri[1]} ${kind}` : uri[1]}`;
  }
  return `Playing from ${s}`;
}

interface QueueRowProps {
  track: QueueTrack;
  index: number;
  isCurrent: boolean;
  isPlaying: boolean;
  isSelected: boolean;
  dropAbove: boolean;
  dropBelow: boolean;
  isDraggedRow: boolean;
  localThumb: string | null;
  resolving: { error: string | null; trying: string | null } | null;
  failure: TrackFailure | null;
  onShowFailure: (track: QueueTrack) => void;
  sourceNote: EntrySourceNote | null;
  onShowSource: (track: QueueTrack) => void;
  showRadio: boolean;
  showLocate: boolean;
  showLikes: boolean;
  showDislike: boolean;
  getTrackImage: (t: QueueTrack) => string | null;
  /** The album → artist chain alone, ignoring the entry's own image_url — the
   * fallback once that explicit image has failed to load. */
  getEntityImage: (t: QueueTrack) => string | null;
  observeVisible: (el: Element, cb: () => void) => () => void;
  onRowMouseDown: (e: React.MouseEvent, index: number) => void;
  onRowClick: (e: React.MouseEvent, index: number) => void;
  onRowContextMenu: (e: React.MouseEvent, index: number) => void;
  onRowInfoEnter: (e: React.MouseEvent<HTMLDivElement>, track: QueueTrack) => void;
  onRowInfoLeave: () => void;
  onPlay: (track: QueueTrack, index: number) => void;
  onTogglePlayPause: () => void;
  onStartRadio: (track: QueueTrack) => void;
  onLocateTrack: (track: QueueTrack) => void;
  onToggleLike: (track: QueueTrack) => void;
  onToggleDislike: (track: QueueTrack) => void;
  /** Opens the artist / album page for a name click. Returns false when the
   *  click belongs to the row instead (a modifier-click selection, or the
   *  mouseup that ends a drag), so the row's own click handler still runs. */
  onOpenEntity: ((e: React.MouseEvent, track: QueueTrack, kind: "artist" | "album") => boolean) | null;
}

// Memoized so panel-level state changes (drag drop-target, selection, tooltip)
// only re-render the rows whose props actually changed — a large queue must not
// pay a full-list re-render per mousemove.
const QueueRow = memo(function QueueRow({
  track: t, index: i, isCurrent, isPlaying, isSelected, dropAbove, dropBelow, isDraggedRow,
  localThumb, resolving, failure, onShowFailure, sourceNote, onShowSource, showRadio, showLocate, showLikes, showDislike,
  getTrackImage, getEntityImage, observeVisible,
  onRowMouseDown, onRowClick, onRowContextMenu, onRowInfoEnter, onRowInfoLeave,
  onPlay, onTogglePlayPause, onStartRadio, onLocateTrack, onToggleLike, onToggleDislike, onOpenEntity,
}: QueueRowProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  // Entity-image lookups invoke the backend (and can trigger a provider fetch)
  // on a cache miss, so they are gated on the row actually scrolling into
  // view — mounting a large queue must not fire a lookup per row.
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    return observeVisible(el, () => setVisible(true));
  }, [observeVisible]);
  // Looked up once on screen (same gate as the art lookup): the library row's
  // size, else the file on disk. Queue entries don't carry one.
  const fileSize = useFileSize(t.path, visible);

  return (
    <div
      ref={rowRef}
      data-queue-index={i}
      data-flip-key={t.key}
      className={
        `queue-item${isCurrent ? ` queue-current${isPlaying ? "" : " paused"}` : ""}${isSelected ? " selected" : ""}`
        + `${dropAbove ? " drop-above" : ""}`
        + `${dropBelow ? " drop-below" : ""}`
        + `${isDraggedRow ? " dragging" : ""}`
      }
      onMouseDown={(e) => onRowMouseDown(e, i)}
      onClick={(e) => onRowClick(e, i)}
      onDoubleClick={() => onPlay(t, i)}
      onContextMenu={(e) => onRowContextMenu(e, i)}
    >
      <div className="queue-item-content">
        {showLikes && (
          <div className="queue-item-like">
            <LikeDislikeButtons
              track={t}
              onToggleLike={() => onToggleLike(t)}
              onToggleDislike={showDislike ? () => onToggleDislike(t) : undefined}
              variant="inline"
              size={13}
            />
          </div>
        )}
        <div className="queue-item-art-wrapper">
          <QueueItemThumb
            localThumb={localThumb}
            fallback={visible ? getTrackImage(t) : null}
            entityFallback={visible ? getEntityImage : null}
            track={t}
          />
        </div>
        <div
          className="queue-item-info"
          onMouseEnter={(e) => onRowInfoEnter(e, t)}
          onMouseLeave={onRowInfoLeave}
        >
          <div className="queue-item-line1">
            {resolving ? (
              <span
                className="queue-item-resolving-icon ds-motion-essential"
                title={resolving.error ? `${resolving.error} · Trying ${resolving.trying}…` : `Trying ${resolving.trying}…`}
              />
            ) : isCurrent ? (
              <SpinningDisc size={13} playing={isPlaying} />
            ) : null}
            <span className="queue-item-title">{t.title}</span>
            <span className="queue-item-duration">{formatDuration(t.duration_secs)}</span>
          </div>
          <div className="queue-item-line2">
            <span className="queue-item-artist-album">
              {/* The names are links (a plain click opens the page). Mousedown is
                  left to bubble so a drag can still start on the text; a
                  double-click on a name stays a navigation, not a play. */}
              {t.artist_name && onOpenEntity ? (
                <span
                  className="queue-item-artist queue-item-link"
                  onClick={(e) => { if (onOpenEntity(e, t, "artist")) e.stopPropagation(); }}
                  onDoubleClick={(e) => e.stopPropagation()}
                >{t.artist_name}</span>
              ) : (
                <span className="queue-item-artist">{t.artist_name || "Unknown"}</span>
              )}
              {t.album_title && (
                <>
                  <span className="queue-item-sep"> · </span>
                  {onOpenEntity ? (
                    <span
                      className="queue-item-album queue-item-link"
                      onClick={(e) => { if (onOpenEntity(e, t, "album")) e.stopPropagation(); }}
                      onDoubleClick={(e) => e.stopPropagation()}
                    >{t.album_title}</span>
                  ) : (
                    <span className="queue-item-album">{t.album_title}</span>
                  )}
                </>
              )}
            </span>
            {sourceNote && !resolving && !failure ? (
              <button
                type="button"
                className={`queue-item-via${sourceNote.reason === "fallback" ? " queue-item-via--fallback" : ""}`}
                title={sourceNoteChipTitle(sourceNote)}
                onMouseDown={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); onShowSource(t); }}
              >
                {sourceNote.reason === "fallback" ? (
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/></svg>
                ) : (
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/></svg>
                )}
                <span className="queue-item-via-name">via {sourceNote.name}</span>
              </button>
            ) : fileSize != null ? (
              <span className="queue-item-size">{formatFileSize(fileSize)}</span>
            ) : null}
          </div>
          {resolving?.trying ? (
            <div className="queue-item-status queue-item-status-trying" aria-live="polite">
              <span className="queue-item-status-text">
                <span className="queue-item-trying">Trying {resolving.trying}…</span>
                {resolving.error && <span className="queue-item-trying-why"> · {resolving.error}</span>}
              </span>
            </div>
          ) : null}
          {failure && !resolving ? (
            <button
              type="button"
              className="queue-item-status queue-item-status-failed"
              title="Show what happened"
              onMouseDown={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onShowFailure(t); }}
            >
              <svg className="queue-resolving-fail-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              <span className="queue-resolving-error">Couldn't play · {failure.summary}</span>
            </button>
          ) : null}
        </div>
      </div>
      <div className="row-hover-actions">
        {isCurrent ? (
          <button
            className="row-hover-action row-hover-action--play"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onTogglePlayPause(); }}
            title={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? (
              <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
            )}
          </button>
        ) : (
          <button
            className="row-hover-action row-hover-action--play"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onPlay(t, i); }}
            title="Play"
          >
            <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
          </button>
        )}
        {showRadio && (
          <button
            className="row-hover-action"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onStartRadio(t); }}
            title="Start radio"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="2"/><path d="M7.76 16.24a6 6 0 0 1 0-8.48M16.24 7.76a6 6 0 0 1 0 8.48M4.93 19.07a10 10 0 0 1 0-14.14M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
          </button>
        )}
        {showLocate && (
          <button
            className="row-hover-action"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onLocateTrack(t); }}
            title="Details"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
          </button>
        )}
      </div>
    </div>
  );
});

interface QueuePanelProps {
  queue: QueueTrack[];
  queueIndex: number;
  queuePanelRef: React.RefObject<HTMLDivElement | null>;
  playlistContext: PlaylistContext | null;
  onPlay: (track: QueueTrack, index: number) => void;
  onTogglePlayPause: () => void;
  onRemove: (index: number) => void;
  onLocateTrack?: (track: QueueTrack) => void;
  onStartRadio?: (track: QueueTrack) => void;
  onNavigateToArtist?: (name: string) => void;
  onNavigateToAlbum?: (title: string, artistName?: string) => void;
  onMoveMultiple: (indices: number[], targetIndex: number) => void;
  /** Queue history (queue.md "Queue History"): the Latest play card Back /
   *  Forward would put back, or null at that end. The buttons are disabled,
   *  not hidden, at an end so the header doesn't jump. */
  historyBack: { name: string } | null;
  historyForward: { name: string } | null;
  onHistoryBack: () => void;
  onHistoryForward: () => void;
  onSaveAsM3U: () => void;
  onSaveToPlaylists: () => void;
  onExportAsMixtape: () => void;
  onLoadPlaylist: () => void;
  onPublishQueue: () => void;
  /** "Prefer video" mode — a check item in the ⋯ menu. While on, an info row at
   *  the head of the list explains the mode and offers Turn off, so the mode is
   *  never on without the list saying so. */
  preferVideoResolution: boolean;
  onPreferVideoResolutionChange: (enabled: boolean) => void;
  /** One-shot queue reorder (see queue.md "Randomize Is Destructive, Not
   *  Stateful") — lives in the queue header, next to what it reorders. */
  onRandomize: () => void;
  /** Normal / Repeat All / Repeat One. Its button sits in the header and on the
   *  collapsed rail; Randomize disables in Repeat One. */
  queueMode: QueueMode;
  onToggleQueueMode: () => void;
  /** Auto-continue on/off — one button next to queue mode. It only applies in
   *  Normal mode, so it disables (keeping its slot) in the repeat modes. */
  autoContinueEnabled: boolean;
  onToggleAutoContinue: () => void;
  /** Auto-continue's tuning lives in Settings → Playback; the ⋯ menu links there. */
  onOpenAutoContinueSettings: () => void;
  onContextMenu: (e: React.MouseEvent, indices: number[]) => void;
  onToggleLike?: (track: QueueTrack) => void;
  onToggleDislike?: (track: QueueTrack) => void;
  externalDropTarget: number | null;
  collapsed: boolean;
  /** Audio-fullscreen drawer state: undefined outside fullscreen, else whether
   *  the drawer is currently slid in. Drives scroll-to-current on each reveal —
   *  the parked drawer keeps its last scroll position otherwise, so it would
   *  open on wherever the user last browsed rather than on what's playing. */
  fsRevealed?: boolean;
  onToggleCollapsed: () => void;
  isPlaying?: boolean;
  debugMode?: boolean;
  mainPlaylistDir: string | null;
  thumbInfo: Record<string, ThumbInfo>;
  /** What each entry's resolver walk is asking right now, keyed by
   *  QueueTrack.key — the row's spinner and "Trying X…" line. */
  resolvingByKey?: Record<string, ResolvingStatus>;
  /** Why an entry didn't play (either stage), keyed by QueueTrack.key. */
  trackFailures?: Record<string, TrackFailure>;
  /** Click on a row's "Couldn't play" note — App opens the details dialog. */
  onShowFailure?: (track: QueueTrack) => void;
  /** Where an entry played from when it wasn't its own source, keyed by
   *  QueueTrack.key — drawn as the row's "via X" chip. */
  sourceNotes?: Record<string, EntrySourceNote>;
  /** Click on a row's "via X" chip — App opens the source dialog. */
  onShowSource?: (track: QueueTrack) => void;
  /** A play still being built (usePlayActions.playWithBackfill): an extend
   *  renders placeholder rows after the queue, a switch a banner above it. */
  loadingPlay?: LoadingPlay | null;
  /** The queue ran out and playback waits for the loading play. */
  playbackWaiting?: boolean;
  /** A loading play's remainder that never arrived (this session only). */
  loadFailure?: string | null;
  /** Drop the loading play (the switch banner's Cancel). */
  onCancelLoadingPlay?: () => void;
}


/** "⌘[" / "Ctrl+[" — the queue history's shortcuts, for the buttons' tooltips. */
function shortcutLabel(key: string): string {
  return navigator.platform.includes("Mac") ? `⌘${key}` : `Ctrl+${key}`;
}

const QUEUE_MODE_LABELS: Record<QueueMode, string> = {
  "normal": "Normal",
  "repeat-all": "Repeat All",
  "repeat-one": "Repeat One",
};

/** The queue header's icons: one size and one stroke, so no glyph looks
 *  heavier than its neighbour (the ⋯ included — a text glyph sat on the font's
 *  baseline and changed weight with the skin's font). */
function QueueIcon({ children }: { children: React.ReactNode }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

const REPEAT_PATHS = (
  <>
    <path d="m17 2 4 4-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14" />
    <path d="m7 22-4-4 4-4" /><path d="M21 13v1a4 4 0 0 1-4 4H3" />
  </>
);

/** Queue mode · auto-continue: what the queue does next. Rendered twice — in the
 *  header and on the collapsed rail — so the two can never disagree. */
function QueueBehaviourButtons({ queueMode, onToggleQueueMode, autoContinueEnabled, onToggleAutoContinue }: {
  queueMode: QueueMode;
  onToggleQueueMode: () => void;
  autoContinueEnabled: boolean;
  onToggleAutoContinue: () => void;
}) {
  // Auto-continue only runs in Normal mode (App.tsx handleNext). It is
  // aria-disabled rather than removed (the rail's label below doesn't jump) or
  // `disabled` (a disabled .g-btn takes no pointer events, so the tooltip saying
  // why would never show).
  const acApplies = queueMode === "normal";
  const acOn = acApplies && autoContinueEnabled;
  return (
    <>
      {/* Always the repeat glyph: grey in Normal (repeat is off), accent in the
          repeat modes, with a 1 for Repeat One — so the button says what it does
          before it is ever clicked. */}
      <button
        className={`g-btn g-btn-sm${queueMode !== "normal" ? " active" : ""}`}
        onClick={onToggleQueueMode}
        title={`Queue mode: ${QUEUE_MODE_LABELS[queueMode]}`}
        aria-label={`Queue mode: ${QUEUE_MODE_LABELS[queueMode]}`}
      >
        <QueueIcon>
          {REPEAT_PATHS}
          {queueMode === "repeat-one" && <path d="M11 10h1v4" />}
        </QueueIcon>
      </button>
      <button
        className={`g-btn g-btn-sm${acOn ? " active" : ""}`}
        onClick={() => { if (acApplies) onToggleAutoContinue(); }}
        aria-disabled={!acApplies || undefined}
        aria-pressed={acOn}
        aria-label="Auto-continue"
        title={!acApplies
          ? "Auto-continue only applies in Normal mode"
          : autoContinueEnabled
            ? "Auto-continue is on: similar tracks play when the queue ends. Click to turn off."
            : "Auto-continue: keep playing similar tracks when the queue ends"}
      >
        <QueueIcon><path d="M12 12c-2-2.67-4-4-6-4a4 4 0 1 0 0 8c2 0 4-1.33 6-4zm0 0c2 2.67 4 4 6 4a4 4 0 0 0 0-8c-2 0-4 1.33-6 4z" /></QueueIcon>
      </button>
    </>
  );
}

export function QueueItemThumb({ localThumb, fallback, entityFallback, track }: {
  localThumb: string | null;
  fallback: string | null;
  entityFallback: ((t: QueueTrack) => string | null) | null;
  track: QueueTrack;
}) {
  const [failedSrcs, setFailedSrcs] = useState<Set<string>>(new Set());

  // An explicit image is never the only candidate (same rule as Home's
  // cards): a plugin can hand over a local path it later prunes, or a URL
  // that expires. Once those have failed, the album → artist chain is asked —
  // and only then, so a row whose own image loads never costs a lookup.
  const usable = (s: string | null | undefined): s is string => !!s && !failedSrcs.has(s);
  let src: string | null = [localThumb, fallback].find(usable) ?? null;
  if (!src && entityFallback) {
    const entity = entityFallback(track);
    if (usable(entity)) src = entity;
  }

  if (!src) {
    return (
      <div className="queue-item-thumb queue-item-thumb-placeholder">
        <TrackArtFallback track={track} size={26} />
      </div>
    );
  }

  return (
    <img
      key={src}
      className="queue-item-thumb"
      src={src}
      onError={() => setFailedSrcs(prev => new Set(prev).add(src))}
      alt=""
    />
  );
}

export function QueuePanel({
  queue, queueIndex, queuePanelRef, playlistContext,

  onPlay, onTogglePlayPause, onRemove: _onRemove, onLocateTrack, onStartRadio, onNavigateToArtist, onNavigateToAlbum, onMoveMultiple, historyBack, historyForward, onHistoryBack, onHistoryForward, onSaveAsM3U, onSaveToPlaylists, onExportAsMixtape, onLoadPlaylist, onPublishQueue, preferVideoResolution, onPreferVideoResolutionChange, onRandomize, queueMode, onToggleQueueMode, autoContinueEnabled, onToggleAutoContinue, onOpenAutoContinueSettings, onContextMenu, onToggleLike, onToggleDislike,
  externalDropTarget,
  collapsed, fsRevealed, onToggleCollapsed, isPlaying, debugMode,
  mainPlaylistDir, thumbInfo, resolvingByKey, trackFailures, onShowFailure, sourceNotes, onShowSource,
  loadingPlay = null, playbackWaiting = false, loadFailure = null, onCancelLoadingPlay,
}: QueuePanelProps) {
  const switching = loadingPlay?.mode === "switch" ? loadingPlay : null;
  const extending = loadingPlay?.mode === "extend" ? loadingPlay : null;
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const [dropTarget, setDropTarget] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [tooltip, setTooltip] = useState<{ track: QueueTrack; anchorX: number; anchorY: number } | null>(null);
  const [contextInfoAnchor, setContextInfoAnchor] = useState<{ x: number; y: number } | null>(null);
  const [contextInfoPos, setContextInfoPos] = useState<{ left: number; top: number } | null>(null);
  const contextInfoRef = useRef<HTMLDivElement>(null);
  const [coverColor, setCoverColor] = useState<RGB | null>(null);
  const lastClickedIndexRef = useRef<number | null>(null);
  const dragIndicesRef = useRef<number[] | null>(null);
  const dropTargetRef = useRef<number | null>(null);
  const didDragRef = useRef(false);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const tooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ left: number; top: number } | null>(null);
  const queueListRef = useRef<HTMLDivElement>(null);
  const historySegRef = useRef<HTMLDivElement>(null);

  // Physical reorder/insert/remove settling for the queue list.
  const flipList = useFlipList(queueListRef);

  useEffect(() => {
    if (!tooltip || !tooltipRef.current) { setTooltipPos(null); return; }
    const el = tooltipRef.current;
    const rect = el.getBoundingClientRect();
    const pad = 8;
    let left = tooltip.anchorX;
    let top = tooltip.anchorY - rect.height - 6;
    if (top < pad) top = tooltip.anchorY + 30;
    if (left + rect.width > window.innerWidth - pad) left = window.innerWidth - pad - rect.width;
    if (left < pad) left = pad;
    if (top + rect.height > window.innerHeight - pad) top = window.innerHeight - pad - rect.height;
    setTooltipPos({ left, top });
  }, [tooltip]);

  const openHeaderMenu = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const specs = buildQueueHeaderMenuSpecs({
      preferVideo: preferVideoResolution,
      onTogglePreferVideo: () => onPreferVideoResolutionChange(!preferVideoResolution),
      onLoadPlaylist, onSaveToPlaylists, onSaveAsM3U, onPublishQueue, onExportAsMixtape,
      onOpenAutoContinueSettings,
      // Below 230px the history buttons are hidden (QueuePanel.css), so they
      // move into this menu. Asked of the layout itself, so the CSS stays the
      // one place the breakpoint lives.
      history: historySegRef.current && historySegRef.current.getClientRects().length === 0
        ? {
          back: historyBack, forward: historyForward, onBack: onHistoryBack, onForward: onHistoryForward,
          backShortcut: shortcutLabel("["), forwardShortcut: shortcutLabel("]"),
        }
        : null,
    });
    showNativeMenu(rect.left, rect.bottom, specs).catch((err) =>
      console.error("Failed to show queue header menu:", err)
    );
  }, [
    preferVideoResolution, onPreferVideoResolutionChange,
    onLoadPlaylist, onSaveToPlaylists, onSaveAsM3U, onPublishQueue, onExportAsMixtape,
    onOpenAutoContinueSettings,
    historyBack, historyForward, onHistoryBack, onHistoryForward,
  ]);

  useEffect(() => {
    if (!contextInfoAnchor || !contextInfoRef.current) { setContextInfoPos(null); return; }
    const el = contextInfoRef.current;
    const rect = el.getBoundingClientRect();
    const pad = 8;
    let left = contextInfoAnchor.x;
    let top = contextInfoAnchor.y + 4;
    if (left + rect.width > window.innerWidth - pad) left = window.innerWidth - pad - rect.width;
    if (left < pad) left = pad;
    if (top + rect.height > window.innerHeight - pad) top = contextInfoAnchor.y - rect.height - 4;
    if (top < pad) top = pad;
    setContextInfoPos({ left, top });
  }, [contextInfoAnchor]);

  useEffect(() => {
    if (!contextInfoAnchor) return;
    const handle = (e: MouseEvent) => {
      if (contextInfoRef.current && !contextInfoRef.current.contains(e.target as Node)) {
        setContextInfoAnchor(null);
      }
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [contextInfoAnchor]);

  // Clear selection when queue changes (add/remove/reorder)
  useEffect(() => { setSelectedIndices(new Set()); }, [queue]);

  // Image resolution for queue items missing an explicit image_url, priority
  // video frame -> album -> artist. Album/artist go through useImageCache, which
  // fetches on a cache miss AND refreshes this view when the backend emits
  // {album,artist}-image-ready. Video first-frames go through the shared
  // VideoFrameQueue: useQueueVideoFrames extracts on demand and re-renders on
  // completion. So unlike the previous cache-only pass, a queue thumbnail now
  // populates as soon as the image lands instead of staying a placeholder.
  const albumImages = useImageCache("album");
  const artistImages = useImageCache("artist");
  const videoFrames = useQueueVideoFrames(queue);

  const getTrackImage = useCallback((t: QueueTrack): string | null =>
    resolveTrackImage(t, {
      albumImageFor: albumImages.getImage,
      artistImageFor: artistImages.getImage,
      // Video frame URLs from the queue are already converted — passed verbatim.
      videoFrame: videoFrames[shelfVideoKey(t.path)] ?? null,
    }),
  [videoFrames, albumImages, artistImages]);

  // The same chain without the entry's own image_url, for when that image
  // fails to load (QueueItemThumb asks for it only then).
  const getEntityImage = useCallback((t: QueueTrack): string | null =>
    getTrackImage({ ...t, image_url: undefined }),
  [getTrackImage]);

  // Resolved cover for the context banner. Prefer the explicit context image
  // (album/artist/tag/playlist play, or a plugin coverUrl); when the context
  // carries none — e.g. a Spotify radio, whose plugin passes only name+source —
  // fall back to the first queued track's art via the same chain the rows use
  // (track image_url -> video frame -> album -> artist). For radio queue[0] IS
  // the seed, so the banner shows the track that started the station; and since
  // it goes through the track's own image_url (external art) and the fetching
  // entity caches, it fills in reactively instead of staying a blank
  // (see-through on macOS) placeholder.
  const bannerCover: string | null = !playlistContext
    ? null
    : playlistContext.imagePath
      ? (resolveImageUrl(playlistContext.imagePath) ?? null)
      : (queue.length > 0 ? getTrackImage(queue[0]) : null);

  // Extract dominant color from the resolved banner cover for the gradient.
  useEffect(() => {
    if (!bannerCover) {
      setCoverColor(null);
      return;
    }
    let canceled = false;
    extractDominantColor(bannerCover).then(result => {
      if (!canceled) setCoverColor(result);
    });
    return () => { canceled = true; };
  }, [bannerCover]);

  // One IntersectionObserver for the whole list (not one per row). Rows
  // register via observeVisible and get a single became-visible callback,
  // which gates their image resolution to on-screen rows.
  const visibilityCbs = useRef(new Map<Element, () => void>());
  const visibilityObs = useRef<IntersectionObserver | null>(null);
  const observeVisible = useCallback((el: Element, cb: () => void) => {
    if (!visibilityObs.current) {
      visibilityObs.current = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const hit = visibilityCbs.current.get(entry.target);
          if (hit) {
            visibilityCbs.current.delete(entry.target);
            visibilityObs.current?.unobserve(entry.target);
            hit();
          }
        }
      }, { rootMargin: "200px" });
    }
    visibilityCbs.current.set(el, cb);
    visibilityObs.current.observe(el);
    return () => {
      visibilityCbs.current.delete(el);
      visibilityObs.current?.unobserve(el);
    };
  }, []);
  useEffect(() => () => visibilityObs.current?.disconnect(), []);

  // Latest props/state for the stable row handlers below (queue.md "Ref-Based
  // State Access") — the handlers keep one identity across renders so the
  // memoized rows don't re-render whenever the panel does.
  const latestRef = useRef({ selectedIndices, onPlay, onTogglePlayPause, onStartRadio, onLocateTrack, onToggleLike, onToggleDislike, onMoveMultiple, onContextMenu, onShowFailure, onShowSource, onNavigateToArtist, onNavigateToAlbum });
  useAssignRef(latestRef, { selectedIndices, onPlay, onTogglePlayPause, onStartRadio, onLocateTrack, onToggleLike, onToggleDislike, onMoveMultiple, onContextMenu, onShowFailure, onShowSource, onNavigateToArtist, onNavigateToAlbum });

  const rowPlay = useCallback((t: QueueTrack, i: number) => latestRef.current.onPlay(t, i), []);
  const rowTogglePlayPause = useCallback(() => latestRef.current.onTogglePlayPause(), []);
  const rowStartRadio = useCallback((t: QueueTrack) => latestRef.current.onStartRadio?.(t), []);
  const rowLocateTrack = useCallback((t: QueueTrack) => latestRef.current.onLocateTrack?.(t), []);
  const rowShowFailure = useCallback((t: QueueTrack) => latestRef.current.onShowFailure?.(t), []);
  const rowShowSource = useCallback((t: QueueTrack) => latestRef.current.onShowSource?.(t), []);
  const rowToggleLike = useCallback((t: QueueTrack) => latestRef.current.onToggleLike?.(t), []);
  const rowToggleDislike = useCallback((t: QueueTrack) => latestRef.current.onToggleDislike?.(t), []);
  const canOpenEntity = !!(onNavigateToArtist && onNavigateToAlbum);
  const rowOpenEntity = useCallback((e: React.MouseEvent, t: QueueTrack, kind: "artist" | "album"): boolean => {
    // A modifier-click is a selection gesture and the mouseup ending a drag is
    // not a click on the name — both stay with the row.
    if (didDragRef.current || e.metaKey || e.ctrlKey || e.shiftKey) return false;
    const { onNavigateToArtist: toArtist, onNavigateToAlbum: toAlbum } = latestRef.current;
    if (kind === "artist") {
      if (!t.artist_name || !toArtist) return false;
      toArtist(t.artist_name);
    } else {
      if (!t.album_title || !toAlbum) return false;
      // An album is keyed by its album artist (a compilation is owned by
      // "Various Artists", not by this track's performer).
      toAlbum(t.album_title, t.album_artist_name ?? t.artist_name ?? undefined);
    }
    return true;
  }, []);

  // Scroll to currently playing track when panel opens, un-collapses, or the
  // fullscreen drawer reveals (each reveal, not just the first — the parked
  // drawer keeps its scroll position between reveals).
  useEffect(() => {
    // Parked fullscreen drawer: wait for the reveal rather than scrolling a
    // panel that is translated off-screen.
    if (fsRevealed === false) return;
    if (!collapsed && queueIndex >= 0 && queuePanelRef.current) {
      requestAnimationFrame(() => {
        const list = queuePanelRef.current?.querySelector(".queue-list");
        const item = list?.querySelector(`[data-queue-index="${queueIndex}"]`) as HTMLElement | undefined;
        item?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
    }
  }, [collapsed, fsRevealed]);

  const handleRowClick = useCallback((e: React.MouseEvent, index: number) => {
    // Ignore click if we just finished a drag
    if (didDragRef.current) return;

    const meta = e.metaKey || e.ctrlKey;
    const shift = e.shiftKey;

    const newSelection = computeIndexSelection(
      latestRef.current.selectedIndices, index,
      lastClickedIndexRef.current, meta, shift,
    );
    setSelectedIndices(newSelection);
    lastClickedIndexRef.current = index;
  }, []);

  function findQueueIndex(el: Element | null): number | null {
    while (el) {
      const idx = el.getAttribute("data-queue-index");
      if (idx !== null) return parseInt(idx, 10);
      el = el.parentElement;
    }
    return null;
  }

  const handleRowMouseDown = useCallback((e: React.MouseEvent, index: number) => {
    if (e.button !== 0) return;

    // Determine which indices we're dragging
    const selected = latestRef.current.selectedIndices;
    let indices: number[];
    if (selected.has(index) && selected.size > 1) {
      indices = [...selected].sort((a, b) => a - b);
    } else {
      indices = [index];
    }
    dragIndicesRef.current = indices;
    didDragRef.current = false;

    const startX = e.clientX;
    const startY = e.clientY;

    function showGhost(x: number, y: number) {
      if (!ghostRef.current) {
        const ghost = document.createElement("div");
        ghost.className = "queue-drag-ghost";
        ghost.textContent = `${indices.length} track${indices.length > 1 ? "s" : ""}`;
        document.body.appendChild(ghost);
        ghostRef.current = ghost;
      }
      ghostRef.current.style.left = `${x + 12}px`;
      ghostRef.current.style.top = `${y - 10}px`;
    }

    function removeGhost() {
      if (ghostRef.current) {
        ghostRef.current.remove();
        ghostRef.current = null;
      }
    }

    function onMouseMove(ev: MouseEvent) {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!didDragRef.current && Math.abs(dx) + Math.abs(dy) < 5) return;

      if (!didDragRef.current) {
        didDragRef.current = true;
        setIsDragging(true);
        if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
        setTooltip(null);
        setTooltipPos(null);
      }

      showGhost(ev.clientX, ev.clientY);

      const target = document.elementFromPoint(ev.clientX, ev.clientY);
      const overIndex = target ? findQueueIndex(target) : null;
      if (overIndex !== null) {
        const el = target!.closest("[data-queue-index]") as HTMLElement | null;
        if (el) {
          const rect = el.getBoundingClientRect();
          const midY = rect.top + rect.height / 2;
          const dt = ev.clientY < midY ? overIndex : overIndex + 1;
          dropTargetRef.current = dt;
          setDropTarget(dt);
        }
      } else {
        dropTargetRef.current = null;
        setDropTarget(null);
      }
    }

    function onMouseUp() {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      removeGhost();

      if (didDragRef.current && dragIndicesRef.current && dropTargetRef.current !== null) {
        latestRef.current.onMoveMultiple(dragIndicesRef.current, dropTargetRef.current);
      }

      dragIndicesRef.current = null;
      dropTargetRef.current = null;
      setDropTarget(null);
      setIsDragging(false);
      // Prevent the click handler from firing after drag
      setTimeout(() => { didDragRef.current = false; }, 0);
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, []);

  const handleRowContextMenu = useCallback((e: React.MouseEvent, index: number) => {
    e.preventDefault();
    const selected = latestRef.current.selectedIndices;
    if (selected.size > 1 && selected.has(index)) {
      latestRef.current.onContextMenu(e, [...selected].sort((a, b) => a - b));
    } else {
      setSelectedIndices(new Set([index]));
      lastClickedIndexRef.current = index;
      latestRef.current.onContextMenu(e, [index]);
    }
  }, []);

  const handleRowInfoEnter = useCallback((e: React.MouseEvent<HTMLDivElement>, track: QueueTrack) => {
    const rect = e.currentTarget.getBoundingClientRect();
    tooltipTimerRef.current = setTimeout(() => setTooltip({ track, anchorX: rect.left, anchorY: rect.top }), 400);
  }, []);

  const handleRowInfoLeave = useCallback(() => {
    if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
    setTooltip(null);
    setTooltipPos(null);
  }, []);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      setSelectedIndices(new Set());
    } else if (e.key === "a" && (e.metaKey || e.ctrlKey) && queue.length > 0) {
      if ((e.target as HTMLElement)?.closest("input, textarea, [contenteditable]")) return;
      e.preventDefault();
      setSelectedIndices(new Set(Array.from({ length: queue.length }, (_, i) => i)));
    }
  }

  // Derived values for banner rendering
  const eyebrow = formatPlaylistSource(playlistContext?.source);
  const gradientStop = coverColor
    ? `${coverColor.r}, ${coverColor.g}, ${coverColor.b}`
    : "var(--accent-rgb)";
  // backgroundImage, NOT the background shorthand: the shorthand resets
  // background-color, and the banner must keep the opaque backing the CSS gives
  // it (.queue-context-banner) — the gradient fades to transparent, and during
  // a native-video queue placement the panel behind it is a see-through hole
  // (see TrackDetailView.css .mpv-video-hole.video-in-queue), so without its
  // own backing the banner text sat on the desktop.
  const bannerStyle: { backgroundImage: string } = {
    backgroundImage: `linear-gradient(90deg, rgba(${gradientStop}, 0.45) 0%, rgba(${gradientStop}, 0.08) 60%, transparent 100%)`,
  };
  const hasInfoContent = !!(
    playlistContext?.source ||
    playlistContext?.description ||
    (playlistContext?.metadata && Object.keys(playlistContext.metadata).length > 0)
  );

  const randomizeOff = queueMode === "repeat-one" || queue.length < 2;
  // One walk of the queue per change, shared by the header, the banner and
  // the collapsed rail (the panel re-renders often while music plays).
  const totalDuration = useMemo(() => formatTotalDuration(queue), [queue]);

  return (
    <aside className={`queue-panel${collapsed ? " collapsed" : ""}`} ref={queuePanelRef} tabIndex={-1} onKeyDown={handleKeyDown}>
      {collapsed ? (
        <div className="queue-collapsed-strip" onClick={onToggleCollapsed}>
          {/* The queue's behaviour stays visible while collapsed — a hidden
              Repeat One otherwise reads as "the same song keeps playing".
              Clicks here must not also expand the panel. */}
          <div className="now-group queue-rail-group" role="group" aria-label="Queue behaviour" onClick={(e) => e.stopPropagation()}>
            <QueueBehaviourButtons
              queueMode={queueMode}
              onToggleQueueMode={onToggleQueueMode}
              autoContinueEnabled={autoContinueEnabled}
              onToggleAutoContinue={onToggleAutoContinue}
            />
          </div>
          <span className="queue-collapsed-label">Queue</span>
          <span className="queue-collapsed-count">{queue.length} track{queue.length !== 1 ? "s" : ""}</span>
          {queue.length > 0 && <span className="queue-collapsed-duration">{totalDuration}</span>}
        </div>
      ) : (
      <>
      <div className="queue-header">
        {/* The queue's count and length live here (there is no info bar at
            the bottom any more). They give way first as the panel narrows: the
            count below 300px, the title below 280px (QueuePanel.css). */}
        <span className="queue-header-title">
          <span className="queue-title">Queue</span>
          {queue.length > 0 && (
            <span className="queue-header-count">
              {queue.length} &middot; {totalDuration}
            </span>
          )}
        </span>
        {/* One pill, three segments: the queue's history, what the queue
            does, then what you can do to it. Everything else is in the ⋯
            menu. Unavailable buttons are aria-disabled, not `disabled`, so
            their tooltip can still say why. */}
        <div className="now-group queue-header-group" role="group" aria-label="Queue controls">
          <div className="queue-header-seg queue-header-seg--history" ref={historySegRef} role="group" aria-label="Queue history">
            <button
              className="g-btn g-btn-sm"
              onClick={() => { if (historyBack) onHistoryBack(); }}
              aria-disabled={!historyBack || undefined}
              title={historyBack ? `Back to: ${historyBack.name} (${shortcutLabel("[")})` : "No earlier queue"}
              aria-label={historyBack ? `Back to ${historyBack.name}` : "Back: no earlier queue"}
            >
              <QueueIcon><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></QueueIcon>
            </button>
            <button
              className="g-btn g-btn-sm"
              onClick={() => { if (historyForward) onHistoryForward(); }}
              aria-disabled={!historyForward || undefined}
              title={historyForward ? `Forward to: ${historyForward.name} (${shortcutLabel("]")})` : "No later queue"}
              aria-label={historyForward ? `Forward to ${historyForward.name}` : "Forward: no later queue"}
            >
              <QueueIcon><path d="m15 14 5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" /></QueueIcon>
            </button>
          </div>
          <span className="queue-header-divider queue-header-divider--history" aria-hidden="true" />
          <div className="queue-header-seg" role="group" aria-label="Queue behaviour">
            <QueueBehaviourButtons
              queueMode={queueMode}
              onToggleQueueMode={onToggleQueueMode}
              autoContinueEnabled={autoContinueEnabled}
              onToggleAutoContinue={onToggleAutoContinue}
            />
          </div>
          <span className="queue-header-divider" aria-hidden="true" />
          <div className="queue-header-seg" role="group" aria-label="Queue actions">
            <button
              className="g-btn g-btn-sm"
              onClick={() => {
                if (randomizeOff) return;
                flipList.staggerNext();
                onRandomize();
              }}
              aria-disabled={randomizeOff || undefined}
              title={queueMode === "repeat-one"
                ? "Randomize is off in Repeat One"
                : queue.length < 2 ? "Randomize needs at least two tracks" : "Randomize queue order"}
              aria-label="Randomize queue order"
            >
              <QueueIcon><rect width="18" height="18" x="3" y="3" rx="2" ry="2" /><path d="M16 8h.01" /><path d="M8 8h.01" /><path d="M8 16h.01" /><path d="M16 16h.01" /><path d="M12 12h.01" /></QueueIcon>
            </button>
            <button
              className="g-btn g-btn-sm"
              onClick={openHeaderMenu}
              title="Queue options"
              aria-label="Queue options"
            >
              <QueueIcon><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></QueueIcon>
            </button>
          </div>
        </div>
      </div>
      {playlistContext && queue.length > 0 && (
        <div className="queue-context-banner" style={bannerStyle}>
          <div className="queue-context-cover">
            {bannerCover ? (
              <img
                src={bannerCover}
                alt=""
                onError={e => { e.currentTarget.style.display = "none"; }}
              />
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 18V5l12-2v13"/>
                <circle cx="6" cy="18" r="3"/>
                <circle cx="18" cy="16" r="3"/>
              </svg>
            )}
          </div>
          {eyebrow && <div className="queue-context-eyebrow">{eyebrow}</div>}
          <div className="queue-context-text">
            <div className="queue-context-name">{playlistContextTitle(playlistContext)}</div>
            <div className="queue-context-meta">
              {queue.length} track{queue.length !== 1 ? "s" : ""} · {totalDuration}
            </div>
          </div>
          {hasInfoContent && (
            <button
              className="queue-context-info-btn"
              aria-expanded={contextInfoAnchor !== null}
              onClick={(e) => {
                e.stopPropagation();
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setContextInfoAnchor(prev => prev ? null : { x: rect.left, y: rect.bottom });
              }}
              title="Playlist info"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
            </button>
          )}
        </div>
      )}
      {/* A play whose first song isn't known yet: the queue below keeps
          playing, and is replaced when the new list lands. */}
      {switching && (
        <QueueSwitchBanner play={switching} onCancel={() => onCancelLoadingPlay?.()} />
      )}
      <div className={`queue-list${switching ? " queue-list--superseded" : ""}`} ref={queueListRef}>
        {/* The mode banner for "Prefer video": the mode changes what every play
            in this list does (a music video is fetched before the track's own
            audio plays), so the list itself says so — a toggle buried in a
            header icon is how the mode got "stuck on" for users who forgot it.
            The Turn off button is the escape hatch at the point of effect. */}
        {preferVideoResolution && (
          <div className="queue-prefer-video-row">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m22 8-6 4 6 4V8Z"/><rect width="14" height="12" x="2" y="6" rx="2" ry="2"/></svg>
            <span className="queue-prefer-video-text">
              Prefer video is on — tracks play as music videos when one is found
            </span>
            <button
              className="queue-prefer-video-off"
              onClick={() => onPreferVideoResolutionChange(false)}
            >
              Turn off
            </button>
          </div>
        )}
        {queue.map((t, i) => (
          <QueueRow
            key={t.key}
            track={t}
            index={i}
            isCurrent={i === queueIndex}
            isPlaying={i === queueIndex ? !!isPlaying : false}
            isSelected={selectedIndices.has(i)}
            dropAbove={dropTarget === i || externalDropTarget === i}
            dropBelow={i === queue.length - 1 && (dropTarget === i + 1 || externalDropTarget === i + 1)}
            isDraggedRow={isDragging && (dragIndicesRef.current?.includes(i) ?? false)}
            localThumb={resolveImageUrl(queueItemLocalThumb({
              mainPlaylistDir,
              uri: t.path,
              thumbInfo,
            })) ?? null}
            resolving={resolvingByKey?.[t.key] ?? null}
            failure={trackFailures?.[t.key] ?? null}
            onShowFailure={rowShowFailure}
            sourceNote={sourceNotes?.[t.key] ?? null}
            onShowSource={rowShowSource}
            showRadio={!!onStartRadio}
            showLocate={!!onLocateTrack}
            showLikes={!!onToggleLike}
            showDislike={!!onToggleDislike}
            getTrackImage={getTrackImage}
            getEntityImage={getEntityImage}
            observeVisible={observeVisible}
            onRowMouseDown={handleRowMouseDown}
            onRowClick={handleRowClick}
            onRowContextMenu={handleRowContextMenu}
            onRowInfoEnter={handleRowInfoEnter}
            onRowInfoLeave={handleRowInfoLeave}
            onPlay={rowPlay}
            onTogglePlayPause={rowTogglePlayPause}
            onStartRadio={rowStartRadio}
            onLocateTrack={rowLocateTrack}
            onToggleLike={rowToggleLike}
            onToggleDislike={rowToggleDislike}
            onOpenEntity={canOpenEntity ? rowOpenEntity : null}
          />
        ))}
        {queue.length === 0 && !switching && (
          <div className={`queue-empty${externalDropTarget !== null ? " drop-highlight" : ""}`}>
            {externalDropTarget !== null ? "Drop here to add" : "Playlist is empty"}
          </div>
        )}
        {/* The play started from a known first track and its remainder is still
            resolving (a plugin scrape, a remote catalog). Without this a
            one-track queue looks finished rather than still filling. While the
            queue has run out and waits, the first placeholder is marked next. */}
        {extending && <QueueLoadingBlock play={extending} waiting={playbackWaiting} />}
        {/* Persistent, unlike the toast: a tail can fail long after the user
            looked away. Cleared by the next play. */}
        {!loadingPlay && loadFailure && <QueueLoadFailureRow message={loadFailure} />}
      </div>
      </>
      )}
      {tooltip && (() => {
        const t = tooltip.track;
        return (
          <div
            ref={tooltipRef}
            className={`ds-tooltip${tooltipPos ? " visible" : ""}`}
            style={tooltipPos ?? { left: tooltip.anchorX, top: tooltip.anchorY, visibility: "hidden" }}
          >
            <div className="ds-tooltip-title">{t.title}</div>
            {debugMode ? (
              <div className="ds-tooltip-rows">
                {([
                  ["key", t.key], ["path", t.path],
                  ["artist", t.artist_name], ["album", t.album_title],
                  ["duration_secs", t.duration_secs], ["format", t.format],
                  ["image_url", t.image_url],
                ] as [string, unknown][]).map(([k, v]) => (
                  <div key={k} className="ds-tooltip-row">
                    <span className="ds-tooltip-key">{k}</span>
                    <span className="ds-tooltip-val">{v != null ? String(v) : "(none)"}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="ds-tooltip-body">
                {[
                  [t.artist_name, t.album_title].filter(Boolean).join(" — "),
                  t.format?.toUpperCase(),
                ].filter(Boolean).join("\n")}
              </div>
            )}
          </div>
        );
      })()}
      {contextInfoAnchor && playlistContext && (
        <div
          ref={contextInfoRef}
          className={`ds-tooltip${contextInfoPos ? " visible" : ""}`}
          style={{ ...(contextInfoPos ?? { left: contextInfoAnchor.x, top: contextInfoAnchor.y, visibility: "hidden" as const }), pointerEvents: "auto" }}
        >
          <div className="ds-tooltip-title">{playlistContextTitle(playlistContext)}</div>
          <div className="ds-tooltip-rows">
            {playlistContext.source && (
              <div className="ds-tooltip-row">
                <span className="ds-tooltip-key">source</span>
                <span className="ds-tooltip-val">{playlistContext.source}</span>
              </div>
            )}
            {playlistContext.metadata && Object.entries(playlistContext.metadata).map(([key, value]) => (
              <div className="ds-tooltip-row" key={key}>
                <span className="ds-tooltip-key">{key}</span>
                <span className="ds-tooltip-val">{value}</span>
              </div>
            ))}
            {playlistContext.description && (
              <div className="ds-tooltip-row">
                <span className="ds-tooltip-key">description</span>
                <span className="ds-tooltip-val ds-tooltip-val--desc">{playlistContext.description.length > 200 ? playlistContext.description.slice(0, 200) + "…" : playlistContext.description}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
