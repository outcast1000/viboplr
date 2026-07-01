// The single definition of the row hover-action tray (Play / Enqueue / Start
// radio / Details) shared by every track surface, plus a dynamic mode for
// plugin-declared actions. Type-agnostic: callers pass pre-bound `() => void`
// thunks (already closed over the row + selection), so this never sees a track.
//
// Markup parity is load-bearing: the outer `.row-hover-actions` span is what
// the parent's `.<row>:hover .row-hover-actions` CSS reveals, and each button
// keeps the `.row-hover-action` class + `onMouseDown`/`onClick` stopPropagation
// that the surfaces' click/drag guards (`.closest('.row-hover-action')`) rely on.

// One dynamic (plugin-declared) action. `onClick` is already bound to the row +
// selection by the caller. `isPlay` gives the first/primary action accent styling.
export interface RowHoverAction {
  id: string;
  label: string;
  icon?: string;
  isPlay?: boolean;
  onClick: () => void;
}

export interface RowHoverActionsProps {
  // Fixed universal-track actions — each button renders only when provided.
  onPlay?: () => void;
  onEnqueue?: () => void;
  onStartRadio?: () => void;
  onDetails?: () => void;
  // Dynamic plugin actions, appended after the fixed set.
  actions?: RowHoverAction[];
}

export function RowHoverActions({ onPlay, onEnqueue, onStartRadio, onDetails, actions }: RowHoverActionsProps) {
  const hasFixed = !!(onPlay || onEnqueue || onStartRadio || onDetails);
  const hasDynamic = !!(actions && actions.length);
  if (!hasFixed && !hasDynamic) return null;

  return (
    <span className="row-hover-actions">
      {onPlay && (
        <button type="button" className="row-hover-action row-hover-action--play" title="Play" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onPlay(); }}>
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 6.82v10.36c0 .79.87 1.27 1.54.84l8.14-5.18a1 1 0 0 0 0-1.69L9.54 5.98A.998.998 0 0 0 8 6.82z"/></svg>
        </button>
      )}
      {onEnqueue && (
        <button type="button" className="row-hover-action" title="Enqueue" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onEnqueue(); }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14"/></svg>
        </button>
      )}
      {onStartRadio && (
        <button type="button" className="row-hover-action" title="Start radio" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onStartRadio(); }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="2"/><path d="M7.76 16.24a6 6 0 0 1 0-8.48M16.24 7.76a6 6 0 0 1 0 8.48M4.93 19.07a10 10 0 0 1 0-14.14M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
        </button>
      )}
      {onDetails && (
        <button type="button" className="row-hover-action" title="Details" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onDetails(); }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
        </button>
      )}
      {actions?.map((a) => (
        <button
          key={a.id}
          type="button"
          className={`row-hover-action${a.isPlay ? " row-hover-action--play" : ""}`}
          title={a.label}
          aria-label={a.label}
          onMouseDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); a.onClick(); }}
        >
          {a.icon ? <span className="ptr-hover-glyph">{a.icon}</span> : <span className="ptr-hover-text">{a.label}</span>}
        </button>
      ))}
    </span>
  );
}
