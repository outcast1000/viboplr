// Presentational two-line track row (the `.entity-list-item` shape) shared by
// the library list view, playlist detail, plugin views, history, and (as a
// slotted body) the queue. It owns NO state: selection, drag, keyboard, and
// interaction all live in the parent view, which passes booleans + handlers.
//
// Emits the existing global CSS classes verbatim (see App.css `.entity-list-*`
// / `.row-hover-action*`) so skins keep working. The `.row-hover-actions` tray
// is rendered as a SIBLING of `.entity-list-content`, matching the parent
// hover-reveal selector.
import type { ReactNode } from "react";
import { VideoRowThumb } from "./VideoRowThumb";
import { RowHoverActions, type RowHoverActionsProps } from "./RowHoverActions";

// The thumbnail is resolved by the CALLER into one of three shapes; TrackRow
// owns only the markup branch, never the image-cache lookups.
export type TrackRowThumb =
  | { kind: "video"; trackId: number; alt: string }   // local video → VideoRowThumb
  | { kind: "image"; url: string; alt?: string }        // pre-resolved album/artist/image_url
  | { kind: "initials"; text: string }                  // first-letter placeholder (plugin rows)
  | { kind: "blank" }                                    // empty themed box (e.g. history artist with no image)
  | { kind: "disc" };                                    // default disc SVG fallback

export interface TrackRowProps {
  // --- content ---
  leading?: ReactNode;          // like buttons | rank | number | nothing
  thumb: TrackRowThumb;
  thumbClassName?: string;      // defaults to "entity-list-img"
  title: string;
  subtitle?: ReactNode;         // plain text OR clickable .track-link spans
  column?: ReactNode;           // optional middle column between info and meta (e.g. plugin album column)
  meta?: ReactNode;             // trailing .entity-list-count content (e.g. duration)
  belowSubtitle?: ReactNode;    // extra line under the subtitle (e.g. queue resolve-failure banner)
  actions?: RowHoverActionsProps;

  // --- visual state (owned by the parent) ---
  selected?: boolean;
  active?: boolean;             // keyboard cursor → .highlighted
  playing?: boolean;            // currently playing → .playing

  // --- interaction (owned by the parent) ---
  onClick?: (e: React.MouseEvent) => void;
  onMouseDown?: (e: React.MouseEvent) => void;
  onDoubleClick?: (e: React.MouseEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;

  // --- listbox a11y / DOM passthrough (opt-in per adopter) ---
  id?: string;
  role?: string;
  ariaSelected?: boolean;
  className?: string;           // extra classes appended after the base set
  dataAttrs?: Record<string, string | number>;  // e.g. data-queue-index / data-history-index
}

function Thumb({ thumb, className }: { thumb: TrackRowThumb; className: string }) {
  if (thumb.kind === "video") {
    return <VideoRowThumb trackId={thumb.trackId} alt={thumb.alt} className={className} />;
  }
  if (thumb.kind === "image") {
    return <div className={className}><img src={thumb.url} alt={thumb.alt ?? ""} /></div>;
  }
  if (thumb.kind === "initials") {
    return <div className={className}>{thumb.text}</div>;
  }
  if (thumb.kind === "blank") {
    return <div className={className} />;
  }
  return (
    <div className={`${className} entity-list-img--disc`}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="22" height="22">
        <circle cx="12" cy="12" r="10" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    </div>
  );
}

export function TrackRow({
  leading, thumb, thumbClassName = "entity-list-img", title, subtitle, column, meta, belowSubtitle, actions,
  selected, active, playing,
  onClick, onMouseDown, onDoubleClick, onContextMenu,
  id, role, ariaSelected, className, dataAttrs,
}: TrackRowProps) {
  const cls = `entity-list-item${playing ? " playing" : ""}${selected ? " selected" : ""}${active ? " highlighted" : ""}${className ? ` ${className}` : ""}`;
  return (
    <div
      className={cls}
      id={id}
      role={role}
      aria-selected={ariaSelected}
      onClick={onClick}
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      {...dataAttrs}
    >
      <div className="entity-list-content">
        {leading}
        <Thumb thumb={thumb} className={thumbClassName} />
        <div className="entity-list-info">
          <span className="entity-list-name">{title}</span>
          {subtitle != null && <span className="entity-list-secondary">{subtitle}</span>}
          {belowSubtitle}
        </div>
        {column}
        {meta != null && <span className="entity-list-count">{meta}</span>}
      </div>
      {actions && <RowHoverActions {...actions} />}
    </div>
  );
}
