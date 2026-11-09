import { memo, useEffect, useId, useMemo, useRef, useState } from "react";
import type { PluginTreeNode } from "../../types/plugin";
import { useImageCache } from "../../hooks/useImageCache";
import { useLatestRef } from "../../hooks/useLatestRef";
import { usePointerFocusGuard } from "../../hooks/usePointerFocusGuard";
import { resolveImageUrl } from "../../utils/resolveImageUrl";
import {
  effectiveSelectedId,
  entitiesNeedingArt,
  entityImageKey,
  entityPrimeSignature,
  expandedSignature,
  flattenTree,
  lazyExpandRequests,
  nodeKey,
  relocateCursor,
  rowKey,
  treeKey,
  type PendingSelection,
  type TreeRow,
} from "../../utils/pluginTree";
import { EntityArtFallback } from "../EntityArtFallback";
import "./PluginTree.css";

/** What a tree node's right-click hands the host: its library entity, by name. */
export type TreeEntityMenuTarget = NonNullable<PluginTreeNode["entity"]>;

export interface PluginTreeProps {
  nodes: PluginTreeNode[];
  selectAction: string;
  expandAction?: string;
  selectedId?: string;
  expandedIds?: string[];
  stateKey?: string;
  emptyText?: string;
  ariaLabel?: string;
  onAction?: (actionId: string, data?: unknown) => void;
  /** The host's own artist / album menu for a node carrying an `entity`. */
  onEntityContextMenu?: (e: React.MouseEvent, entity: TreeEntityMenuTarget) => void;
}

/** Above this many visible rows the rows skip layout off-screen
 *  (`content-visibility`), the same trick the plugin row list uses. */
const CV_THRESHOLD = 200;

/** What a row calls back into the tree, BY NODE ID. Read through a
 *  latest-ref, so the row memo below isn't broken by a new closure on every
 *  tree render — and by id because a row that skipped a render still holds the
 *  previous answer's node object, whose `data` may be stale. The tree resolves
 *  the id against the rows it has now. */
interface RowHandlers {
  select: (id: string) => void;
  toggle: (id: string, open: boolean) => void;
  contextMenu: (e: React.MouseEvent, id: string) => void;
}

/**
 * The plugin `tree` view node: an ARIA tree with host-local expansion, lazy
 * children (a loading row until the plugin re-renders them in), the WAI-ARIA
 * keyboard map (`utils/pluginTree.ts` → `treeKey`) and name-keyed artwork.
 *
 * Kept cheap on a large tree (a library of a thousand artists), because every
 * plugin answer is a whole new view tree:
 * - **Selection is optimistic.** The clicked row is marked at once; the
 *   plugin's next answer takes over (`effectiveSelectedId`, and `pending` is
 *   dropped on any new `nodes`). Waiting for the round trip made the highlight
 *   itself lag.
 * - **Rows are memoized by what they show** (`sameRow`), since every node
 *   object is new on every `setViewData` — a new selection re-renders two rows.
 * - **Artwork is looked up per distinct entity, only when that set or the
 *   image cache changes** — never per row per render.
 *
 * Keys: the tree `preventDefault`s exactly the keys it acts on, and the
 * window's transport shortcuts skip a key a widget already handled
 * (`widgetHandledKey`), so ↑/↓ move the cursor here while a key the tree
 * ignores (Space on a loading row) still pauses.
 */
export function PluginTree({
  nodes,
  selectAction,
  expandAction,
  selectedId,
  expandedIds,
  stateKey,
  emptyText,
  ariaLabel,
  onAction,
  onEntityContextMenu,
}: PluginTreeProps) {
  // Expansion is host-local so a chevron answers at once, without a round
  // trip through a worker plugin. `expandedIds` seeds it, and a change of its
  // VALUE (or of `stateKey` — another hierarchy) resets it: previous-value-in-
  // state, not an effect, so the reset lands in the same render.
  const sig = expandedSignature(expandedIds);
  const [seen, setSeen] = useState({ sig, stateKey });
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(expandedIds ?? []));
  // The keyboard cursor, as a `rowKey` (kind-prefixed, so it can name a
  // loading row without colliding with a plugin id).
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const [answered, setAnswered] = useState(nodes);
  const stateKeyChanged = seen.stateKey !== stateKey;
  if (seen.sig !== sig || stateKeyChanged) {
    setSeen({ sig, stateKey });
    setExpanded(new Set(expandedIds ?? []));
    if (stateKeyChanged) {
      setActiveKey(null);
      setPending(null);
    }
  }
  // Any new node tree is the plugin's answer: from here its `selectedId` is
  // the truth, whether or not it adopted the click.
  if (answered !== nodes) {
    setAnswered(nodes);
    if (pending) setPending(null);
  }
  const shownSelectedId = effectiveSelectedId(selectedId, pending);

  const rows = useMemo(() => flattenTree(nodes, expanded), [nodes, expanded]);
  // A cursor whose row went away (a loading row replaced by its children, a
  // node the plugin redrew without) moves to the row that now stands for it
  // (`relocateCursor`) — otherwise the next ↓ jumped to the top of the tree.
  // Previous-value-in-state, so the move lands before this render commits. A
  // `stateKey` change clears the cursor instead.
  const [cursorRows, setCursorRows] = useState(rows);
  if (cursorRows !== rows) {
    setCursorRows(rows);
    if (!stateKeyChanged) {
      const next = relocateCursor(cursorRows, rows, activeKey);
      if (next !== activeKey) setActiveKey(next);
    }
  }
  const activeIndex = activeKey === null ? -1 : rows.findIndex((r) => rowKey(r) === activeKey);

  const treeId = useId();
  const domId = (key: string) => `${treeId}-${encodeURIComponent(key)}`;
  const focusGuard = usePointerFocusGuard();

  // Keep the keyboard cursor in view.
  useEffect(() => {
    if (activeKey === null) return;
    const el = document.getElementById(domId(activeKey));
    if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
    // domId is derived from the stable useId value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey]);

  // Name-keyed artwork through the shared cache. The lazy `getImage` (which
  // may start a fetch) runs in an effect, once per change of the SET of
  // visible entities; render only peeks — and only once per entity, memoized
  // on that set and the cache, so a selection costs no artwork work at all.
  const albumCache = useImageCache("album");
  const artistCache = useImageCache("artist");
  const primeKey = useMemo(() => entityPrimeSignature(rows), [rows]);
  const entities = useMemo(() => entitiesNeedingArt(rows), [primeKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    for (const e of entities) {
      if (e.kind === "album") albumCache.getImage(e.name, e.artistName);
      else artistCache.getImage(e.name);
    }
    // The getters track the cache; only a new entity set needs priming.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entities]);
  const peekAlbum = albumCache.peekImage;
  const peekArtist = artistCache.peekImage;
  const artByEntity = useMemo(() => {
    const m = new Map<string, string | undefined>();
    for (const e of entities) {
      const path = e.kind === "album" ? peekAlbum(e.name, e.artistName) : peekArtist(e.name);
      m.set(entityImageKey(e), resolveImageUrl(path));
    }
    return m;
  }, [entities, peekAlbum, peekArtist]);
  const imageFor = (node: PluginTreeNode): string | undefined => {
    if (node.imageUrl) return resolveImageUrl(node.imageUrl);
    return node.entity ? artByEntity.get(entityImageKey(node.entity)) : undefined;
  };

  // Lazy nodes the plugin has been asked to load (`expandAction`), so each is
  // asked once per wait. The user's own expand asks in `setOpen`; this effect
  // asks for the rest — lazy nodes opened by `expandedIds`, which nothing ever
  // asked for, so they showed "Loading…" forever.
  const askedRef = useRef<Set<string>>(new Set());
  const lazyRef = useLatestRef({ onAction, expandAction, rows });
  useEffect(() => {
    const { onAction: act, expandAction: action, rows: current } = lazyRef.current!;
    const { request, asked } = lazyExpandRequests(current, askedRef.current);
    askedRef.current = asked;
    if (!action || !act) return;
    for (const id of request) {
      const row = current.find((r) => r.kind === "node" && r.node.id === id);
      asked.add(id);
      act(action, { id, expanded: true, data: row?.kind === "node" ? row.node.data : undefined });
    }
    // Runs per new row set; the callbacks are read through the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  const setOpen = (node: PluginTreeNode, open: boolean) => {
    setExpanded((prev) => {
      if (prev.has(node.id) === open) return prev;
      const next = new Set(prev);
      if (open) next.add(node.id);
      else next.delete(node.id);
      return next;
    });
    // Marked as asked here, so the lazy-load effect doesn't ask again for the
    // loading row this expand draws.
    if (open) askedRef.current.add(node.id);
    if (expandAction) onAction?.(expandAction, { id: node.id, expanded: open, data: node.data });
  };
  const select = (node: PluginTreeNode) => {
    setActiveKey(nodeKey(node.id));
    // Mark it now; the plugin's next answer replaces this.
    setPending({ id: node.id, base: selectedId });
    onAction?.(selectAction, { id: node.id, data: node.data });
  };

  const nodeById = (id: string): PluginTreeNode | null => {
    for (const r of rows) if (r.kind === "node" && r.node.id === id) return r.node;
    return null;
  };
  const handlersRef = useLatestRef<RowHandlers>({
    select: (id) => { const n = nodeById(id); if (n) select(n); },
    toggle: (id, open) => {
      const n = nodeById(id);
      if (!n) return;
      setActiveKey(nodeKey(id));
      setOpen(n, open);
    },
    contextMenu: (e, id) => {
      const n = nodeById(id);
      if (!n?.entity || !onEntityContextMenu) return;
      e.preventDefault();
      onEntityContextMenu(e, n.entity);
    },
  });

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const result = treeKey(rows, activeIndex, e.key);
    // Not handled: leave the key alone (no preventDefault), so the window's
    // own shortcut for it still runs.
    if (result.type === "none") return;
    e.preventDefault();
    const find = (id: string) => rows.find((r): r is Extract<TreeRow, { kind: "node" }> => r.kind === "node" && r.node.id === id);
    switch (result.type) {
      case "move":
        setActiveKey(rowKey(rows[result.index]));
        break;
      case "expand": {
        const r = find(result.id);
        if (r) setOpen(r.node, true);
        break;
      }
      case "collapse": {
        const r = find(result.id);
        if (r) setOpen(r.node, false);
        break;
      }
      case "select": {
        const r = find(result.id);
        if (r) select(r.node);
        break;
      }
    }
  }

  // Tab puts the cursor on the selected node (else the first); a click must
  // not move it before the click itself lands (see usePointerFocusGuard).
  function handleFocus(e: React.FocusEvent<HTMLDivElement>) {
    if (focusGuard.isPointerFocus() || e.target !== e.currentTarget || activeIndex >= 0 || rows.length === 0) return;
    const sel = shownSelectedId !== undefined
      ? rows.findIndex((r) => r.kind === "node" && r.node.id === shownSelectedId)
      : -1;
    setActiveKey(rowKey(rows[sel >= 0 ? sel : 0]));
  }

  if (nodes.length === 0) {
    return <div className="ptree-empty">{emptyText ?? "Nothing here yet"}</div>;
  }

  const cv = rows.length > CV_THRESHOLD;
  return (
    <div
      className={`ptree${cv ? " ptree--cv" : ""}`}
      role="tree"
      aria-label={ariaLabel ?? "Tree"}
      tabIndex={0}
      aria-activedescendant={activeKey !== null && activeIndex >= 0 ? domId(activeKey) : undefined}
      onKeyDown={handleKeyDown}
      onFocus={handleFocus}
      onMouseDownCapture={focusGuard.onMouseDownCapture}
    >
      {rows.map((row, i) => {
        const key = rowKey(row);
        return (
          <TreeRowView
            key={key}
            row={row}
            domId={domId(key)}
            selected={row.kind === "node" && row.node.id === shownSelectedId}
            active={i === activeIndex}
            src={row.kind === "node" ? imageFor(row.node) : undefined}
            handlersRef={handlersRef}
          />
        );
      })}
    </div>
  );
}

interface TreeRowViewProps {
  row: TreeRow;
  domId: string;
  selected: boolean;
  active: boolean;
  src: string | undefined;
  handlersRef: React.RefObject<RowHandlers>;
}

/** Equal when the row draws the same thing. Node objects are new on every
 *  plugin answer, so identity would re-render every row every time. */
function sameRow(a: TreeRowViewProps, b: TreeRowViewProps): boolean {
  if (a.selected !== b.selected || a.active !== b.active || a.src !== b.src || a.domId !== b.domId) return false;
  const ra = a.row;
  const rb = b.row;
  if (ra.kind !== rb.kind || ra.depth !== rb.depth) return false;
  if (ra.kind === "loading" || rb.kind === "loading") return true;
  if (ra.expandable !== rb.expandable || ra.expanded !== rb.expanded) return false;
  const na = ra.node;
  const nb = rb.node;
  return na.label === nb.label && na.sublabel === nb.sublabel && na.badge === nb.badge &&
    na.entity?.kind === nb.entity?.kind;
}

const TreeRowView = memo(function TreeRowView({ row, domId, selected, active, src, handlersRef }: TreeRowViewProps) {
  const indent = { paddingLeft: `calc(${row.depth} * var(--ptree-indent))` };
  if (row.kind === "loading") {
    return (
      <div
        id={domId}
        className={`ptree-row ptree-row--loading${active ? " ptree-row--active" : ""}`}
        role="treeitem"
        aria-level={row.depth + 1}
        aria-disabled="true"
        style={indent}
      >
        <span className="ptree-chevron" aria-hidden="true" />
        <span className="ds-spinner ds-spinner--sm" aria-hidden="true" />
        <span className="ptree-label">Loading…</span>
      </div>
    );
  }
  // Events pass the id only; the tree looks up the current node (see RowHandlers).
  const { node } = row;
  const id = node.id;
  const h = () => handlersRef.current!;
  const showArt = !!src || !!node.entity;
  return (
    <div
      id={domId}
      className={`ptree-row${selected ? " ptree-row--selected" : ""}${active ? " ptree-row--active" : ""}`}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-selected={selected}
      aria-expanded={row.expandable ? row.expanded : undefined}
      style={indent}
      onClick={() => h().select(id)}
      onDoubleClick={() => { if (row.expandable) h().toggle(id, !row.expanded); }}
      onContextMenu={node.entity ? (e) => h().contextMenu(e, id) : undefined}
    >
      {row.expandable ? (
        <button
          type="button"
          className={`ptree-chevron ptree-chevron--btn${row.expanded ? " ptree-chevron--open" : ""}`}
          tabIndex={-1}
          aria-label={row.expanded ? `Collapse ${node.label}` : `Expand ${node.label}`}
          onClick={(e) => { e.stopPropagation(); h().toggle(id, !row.expanded); }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      ) : (
        <span className="ptree-chevron" aria-hidden="true" />
      )}
      {showArt && (
        <span className={`ptree-art${node.entity?.kind === "artist" ? " ptree-art--round" : ""}`} aria-hidden="true">
          {src ? <img src={src} alt="" loading="lazy" /> : <EntityArtFallback kind={node.entity!.kind} />}
        </span>
      )}
      <span className="ptree-text">
        <span className="ptree-label">{node.label}</span>
        {node.sublabel && <span className="ptree-sublabel">{node.sublabel}</span>}
      </span>
      {node.badge !== undefined && node.badge !== "" && <span className="ptree-badge">{node.badge}</span>}
    </div>
  );
}, sameRow);
