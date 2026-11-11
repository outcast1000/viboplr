import { useEffect, useMemo, useRef, useState } from "react";
import { isVideoTrack } from "../utils";
import { partialStoryboard, tileStartSecs, type Storyboard } from "../utils/storyboard";
import { HOVER_FRAME_INTERVAL_MS } from "../videoFrameQueue";
import { useStoryboard, type StoryboardTrack } from "./useStoryboard";
import { useLatestRef } from "./useLatestRef";

/** How long the cursor must rest on a card before a storyboard is asked for.
 *  Sweeping across a shelf crosses many cards; only the one the user stops on
 *  should cost a cache read — let alone an ffmpeg pass. */
export const HOVER_PREVIEW_DWELL_MS = 350;

/** Where a hover preview's storyboard comes from — the same two producers the
 *  seek bar uses (see `useStoryboard`). */
export interface HoverPreviewSource {
  /** Plugin schemes ask their owning plugin for the source's own storyboard. */
  resolveByUri?: (scheme: string, id: string) => Promise<Storyboard | null>;
  /** Settings > Playback > "Generate video seek previews". Off: only sheets
   *  already cached (or published by the source) are shown; nothing is decoded. */
  generate: boolean;
}

/** A shelf row's track as a preview target: only video rows qualify. */
export function hoverPreviewTrack(
  t: { path?: string | null; format?: string | null; duration_secs?: number | null } | null | undefined,
): StoryboardTrack | null {
  if (!t?.path) return null;
  const track = { path: t.path, format: t.format ?? null, duration_secs: t.duration_secs ?? null };
  return isVideoTrack(track) ? track : null;
}

/** The tiles a preview cycles: every one, in order (owner decision, 2026-11-12 —
 *  a Home card is hovered on purpose, so the whole video is worth playing). Tile 0
 *  is cut from the middle of its slice, not the opening frame, so none is skipped. */
export function hoverPreviewTiles(board: Storyboard): number[] {
  return Array.from({ length: Math.max(0, board.count) }, (_, i) => i);
}

/** Where a preview tile sits in its video. */
export interface HoverPreviewPosition {
  /** The moment the tile depicts: the middle of its slice, which is where the
   *  backend cuts it (`storyboard::tile_time`). */
  secs: number;
  /** The video's length. */
  totalSecs: number;
  /** `secs / totalSecs`, clamped to [0, 1] — what the progress bar draws. */
  fraction: number;
}

/** Position of `tile` in the video. The length is the track's own when known,
 *  else what the board spans (the last slice may run a little past the end). */
export function hoverPreviewPosition(
  board: Storyboard,
  tile: number,
  durationSecs: number | null | undefined,
): HoverPreviewPosition {
  const span = board.startSecs + board.count * board.intervalSecs;
  const totalSecs = durationSecs && durationSecs > 0 ? durationSecs : span;
  const start = tileStartSecs(board, tile);
  const end = Math.min(start + board.intervalSecs, totalSecs);
  // Capped at the length: a stored duration shorter than the video really is
  // would otherwise caption a late tile "9:20 / 1:40".
  const secs = Math.min(end > start ? (start + end) / 2 : start, totalSecs);
  const fraction = totalSecs > 0 ? Math.max(0, secs / totalSecs) : 0;
  return { secs, totalSecs, fraction };
}

/** The tile actually on screen: `current` while the list still holds it, else
 *  the list's first. */
export function shownPreviewTile(tiles: readonly number[], current: number | null): number | null {
  if (tiles.length === 0) return null;
  return current !== null && tiles.includes(current) ? current : tiles[0];
}

/** The tile after the one on screen: the next one in the video, wrapping to the
 *  start. Stepping by tile rather than by a counter is what keeps the loop smooth
 *  while a pass adds frames to it, and when its partial list becomes the finished
 *  sheet — a counter taken modulo a list that changes length lands anywhere. */
export function nextPreviewTile(tiles: readonly number[], current: number | null): number | null {
  const shown = shownPreviewTile(tiles, current);
  if (shown === null) return null;
  return tiles.find((t) => t > shown) ?? tiles[0];
}

export interface HoverStoryboard {
  /** Spread onto the element whose hover drives the preview. */
  hoverProps: { onMouseEnter: () => void; onMouseLeave: () => void };
  board: Storyboard | null;
  /** Tile to draw over the resting art right now; null = show the resting art. */
  tile: number | null;
  /** Where that tile sits in the video; null whenever `tile` is. */
  position: HoverPreviewPosition | null;
  /** The storyboard is being fetched or generated for a card the user rests on. */
  loading: boolean;
  /** While a sheet is generated: frames made so far and how many it will hold;
   *  null when there's no count to report (a cache read, a plugin fetch). */
  generating: { done: number; count: number } | null;
}

/** The tiles a sheet still being generated can show: the frames extracted so
 *  far. A resumed pass's frames start mid-video (`startIndex`), so they're
 *  addressed from there and keep their real timestamps. */
export function partialPreviewTiles(partial: { frames: string[]; startIndex: number; count: number }): number[] {
  const end = Math.min(partial.count, partial.startIndex + partial.frames.length);
  const out: number[] = [];
  for (let i = Math.max(0, partial.startIndex); i < end; i++) out.push(i);
  return out;
}

/**
 * A storyboard flip-book for a card, driven by hover — the Home counterpart of
 * `VideoRowThumb`'s cycling, which is cache-only because a track list's rows are
 * crossed by the dozen. A Home card is a deliberate target, so after a short dwell
 * this asks `useStoryboard` for the sheet, which reads the cache, asks the owning
 * plugin, or generates one (when generation is on). Leaving before it lands
 * withdraws interest, which kills a pass nobody else wants.
 *
 * Once a board arrives it is kept for the card's track, so re-hovering cycles at
 * once without another round-trip.
 *
 * While a sheet is still being generated, the frames extracted so far already
 * cycle (the loop grows as they land), and `generating` reports how far along the
 * pass is. A slow pass — AV1 through libaom is one ffmpeg run per tile, seconds
 * each — would otherwise show a busy bar and nothing else for over a minute.
 */
export function useHoverStoryboard(track: StoryboardTrack | null, source: HoverPreviewSource): HoverStoryboard {
  const path = track?.path ?? null;
  const [hovering, setHovering] = useState(false);
  const [wanted, setWanted] = useState(false);
  // The tile on screen, by tile index (null = the list's first) — see nextPreviewTile.
  const [current, setCurrent] = useState<number | null>(null);
  const [kept, setKept] = useState<{ path: string; board: Storyboard } | null>(null);
  const dwellRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Previous-value-in-state: a recycled card (shelf refresh, carousel advance)
  // drops the previous track's board and request.
  const [lastPath, setLastPath] = useState(path);
  if (path !== lastPath) {
    setLastPath(path);
    setKept(null);
    setWanted(false);
    setCurrent(null);
  }

  const board = kept && kept.path === path ? kept.board : null;
  // Asked only while wanted and not yet held: a held board needs no IPC.
  const sb = useStoryboard(wanted && !board ? track : null, source.resolveByUri, null, source.generate);
  if (path && sb.board && sb.status === "ready" && kept?.board !== sb.board) {
    setKept({ path, board: sb.board });
  }

  // The frames a pass has extracted so far, as a board of their own.
  const partial = !board && sb.status === "loading" ? sb.partial : null;
  const partialBoard = useMemo(
    () => partial
      ? partialStoryboard(partial.frames, partial.intervalSecs, partial.count, partial.startIndex, partial.tileW, partial.tileH)
      : null,
    [partial],
  );
  const shown = board ?? partialBoard;
  const tiles = board ? hoverPreviewTiles(board) : partial && partialBoard ? partialPreviewTiles(partial) : [];
  const tilesRef = useLatestRef(tiles);
  const cycling = hovering && tiles.length > 0;
  // A boolean, not the tile count: a growing partial loop must not restart the
  // timer on every frame that lands. The tick reads the newest list.
  const canCycle = cycling && tiles.length > 1;

  useEffect(() => {
    if (!canCycle) return;
    const id = setInterval(() => setCurrent((c) => nextPreviewTile(tilesRef.current, c)), HOVER_FRAME_INTERVAL_MS);
    return () => clearInterval(id);
  }, [canCycle, tilesRef]);

  useEffect(() => () => {
    if (dwellRef.current) clearTimeout(dwellRef.current);
  }, []);

  const onMouseEnter = () => {
    if (!track) return;
    setHovering(true);
    setCurrent(null);
    if (board || dwellRef.current) return;
    dwellRef.current = setTimeout(() => {
      dwellRef.current = null;
      setWanted(true);
    }, HOVER_PREVIEW_DWELL_MS);
  };

  const onMouseLeave = () => {
    if (dwellRef.current) {
      clearTimeout(dwellRef.current);
      dwellRef.current = null;
    }
    setHovering(false);
    setWanted(false);
    setCurrent(null);
  };

  const tile = cycling ? shownPreviewTile(tiles, current) : null;
  const loading = hovering && wanted && !board && sb.status === "loading";
  return {
    hoverProps: { onMouseEnter, onMouseLeave },
    board: shown,
    tile,
    position: shown && tile !== null ? hoverPreviewPosition(shown, tile, track?.duration_secs) : null,
    loading,
    generating: loading && partial && partial.count > 0
      ? { done: Math.min(partial.count, partial.startIndex + partial.frames.length), count: partial.count }
      : null,
  };
}
