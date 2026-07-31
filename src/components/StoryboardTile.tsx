import { useEffect, useRef, useState } from "react";
import type { Storyboard } from "../utils/storyboard";
import { tileFitStyle, tileCoverStyle } from "../utils/storyboard";

interface StoryboardTileProps {
  board: Storyboard;
  /** Tile to show. Callers resolve this first (via `tileIndexAt` or
   *  `spreadTileIndices`) so they can branch on whether a tile exists at all — an
   *  element that renders null is still truthy and can't carry that decision. */
  index: number;
  className?: string;
  /** Explicit box size. Omit to let CSS size the box; the tile then scales to fit. */
  width?: number;
  height?: number;
  /**
   * Fill a box whose aspect ratio differs from the tile's, cropping centrally
   * (`object-fit: cover`, which CSS can't apply to a sprite). Unlike fit mode this
   * needs pixel dimensions — pass `width`/`height` when they're known, otherwise the
   * box measures itself.
   */
  cover?: boolean;
}

/**
 * One tile of a storyboard sprite sheet.
 *
 * Draws via background offsets rather than a canvas, so nothing reads pixels and
 * cross-origin (plugin-supplied) sheets never taint anything. Shared by the seek-bar
 * hover bubble, the video filmstrip, the detail-page hero art, and `VideoRowThumb`.
 */
export function StoryboardTile({
  board, index, className, width, height, cover,
}: StoryboardTileProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  // Cover mode needs real pixels. When the caller knows them (a fixed-size slot) we
  // use those; otherwise the box is CSS-sized and has to be measured, which costs one
  // extra frame before the tile appears.
  const needsMeasure = !!cover && (width == null || height == null);
  const [measured, setMeasured] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    if (!needsMeasure) return;
    const el = ref.current;
    if (!el) return;
    const apply = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        setMeasured(prev =>
          prev && prev.w === r.width && prev.h === r.height ? prev : { w: r.width, h: r.height },
        );
      }
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => observer.disconnect();
  }, [needsMeasure]);

  const boxW = width ?? measured?.w;
  const boxH = height ?? measured?.h;
  const style =
    cover && boxW != null && boxH != null
      ? tileCoverStyle(board, index, boxW, boxH)
      : cover
        ? null // waiting on measurement
        : tileFitStyle(board, index);

  // In cover mode the element must exist before it can be measured, so render the
  // (still empty) box rather than bailing out.
  if (!style && !needsMeasure) return null;

  return (
    <div
      ref={ref}
      className={className}
      style={{
        ...(style ?? null),
        ...(width != null ? { width } : null),
        ...(height != null ? { height } : null),
        // Only meaningful in fit mode with a CSS-sized box; cover mode fills its box.
        ...(!cover && width == null && height == null
          ? { aspectRatio: `${board.tileW} / ${board.tileH}` }
          : null),
        backgroundRepeat: "no-repeat",
      }}
    />
  );
}
