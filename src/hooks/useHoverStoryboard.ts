import { useEffect, useRef, useState } from "react";
import { isVideoTrack } from "../utils";
import type { Storyboard } from "../utils/storyboard";
import { HOVER_FRAME_INTERVAL_MS } from "../videoFrameQueue";
import { useStoryboard, type StoryboardTrack } from "./useStoryboard";

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

export interface HoverStoryboard {
  /** Spread onto the element whose hover drives the preview. */
  hoverProps: { onMouseEnter: () => void; onMouseLeave: () => void };
  board: Storyboard | null;
  /** Tile to draw over the resting art right now; null = show the resting art. */
  tile: number | null;
  /** The storyboard is being fetched or generated for a card the user rests on. */
  loading: boolean;
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
 */
export function useHoverStoryboard(track: StoryboardTrack | null, source: HoverPreviewSource): HoverStoryboard {
  const path = track?.path ?? null;
  const [hovering, setHovering] = useState(false);
  const [wanted, setWanted] = useState(false);
  const [step, setStep] = useState(0);
  const [kept, setKept] = useState<{ path: string; board: Storyboard } | null>(null);
  const dwellRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Previous-value-in-state: a recycled card (shelf refresh, carousel advance)
  // drops the previous track's board and request.
  const [lastPath, setLastPath] = useState(path);
  if (path !== lastPath) {
    setLastPath(path);
    setKept(null);
    setWanted(false);
    setStep(0);
  }

  const board = kept && kept.path === path ? kept.board : null;
  // Asked only while wanted and not yet held: a held board needs no IPC.
  const sb = useStoryboard(wanted && !board ? track : null, source.resolveByUri, null, source.generate);
  if (path && sb.board && sb.status === "ready" && kept?.board !== sb.board) {
    setKept({ path, board: sb.board });
  }

  const tiles = board ? hoverPreviewTiles(board) : [];
  const cycling = hovering && tiles.length > 0;

  useEffect(() => {
    if (!cycling || tiles.length < 2) return;
    const id = setInterval(() => setStep((s) => s + 1), HOVER_FRAME_INTERVAL_MS);
    return () => clearInterval(id);
  }, [cycling, tiles.length]);

  useEffect(() => () => {
    if (dwellRef.current) clearTimeout(dwellRef.current);
  }, []);

  const onMouseEnter = () => {
    if (!track) return;
    setHovering(true);
    setStep(0);
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
    setStep(0);
  };

  return {
    hoverProps: { onMouseEnter, onMouseLeave },
    board,
    tile: cycling ? tiles[step % tiles.length] : null,
    loading: hovering && wanted && !board && sb.status === "loading",
  };
}
