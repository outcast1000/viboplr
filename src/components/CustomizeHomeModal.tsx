import { useMemo, useRef, useState } from "react";
import { isShelfVisible } from "../hooks/useHome";
import "./CustomizeHomeModal.css";

function Toggle({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button
      className={`ds-toggle ${checked ? "on" : ""}`}
      onClick={onChange}
      role="switch"
      aria-checked={checked}
    >
      <span className="ds-toggle-thumb" />
    </button>
  );
}

/** One row of the Customize list: a built-in shelf, or a registered plugin shelf. */
export interface CustomizeShelfRow {
  id: string;
  title: string;
  description?: string;
  /** The contributing plugin's name; absent for built-in shelves. */
  source?: string;
}

export interface CustomizeHomeModalProps {
  // Every configurable shelf in its current order — built-ins (including Radio)
  // and the plugin shelves registered right now. The first visible shelf becomes
  // the Home hero carousel, whichever kind it is.
  shelves: CustomizeShelfRow[];
  visibility: Record<string, boolean>;
  onReorder: (orderedIds: string[]) => void;
  onToggle: (id: string) => void;
  onReset: () => void;
  onClose: () => void;
}

export function CustomizeHomeModal(props: CustomizeHomeModalProps) {
  const rowById = new Map(props.shelves.map((r) => [r.id, r]));
  const order = props.shelves.map((r) => r.id);

  const [query, setQuery] = useState("");

  const visibleCount = order.filter((id) => isShelfVisible(id, props.visibility)).length;

  const filteredOrder = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return props.shelves.map((r) => r.id);
    return props.shelves
      .filter((r) =>
        [r.title, r.description ?? "", r.source ?? ""].some((s) => s.toLowerCase().includes(q)),
      )
      .map((r) => r.id);
  }, [query, props.shelves]);

  // Drag-reorder state for built-in rows. Refs drive the drag (no re-render churn);
  // the state mirrors are only for the dragging/drag-over visual styling.
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const draggedRef = useRef<string | null>(null);
  const dragOverRef = useRef<string | null>(null);
  const didDragRef = useRef(false);
  const ghostRef = useRef<HTMLDivElement | null>(null);

  function handleHandleMouseDown(e: React.MouseEvent, id: string) {
    if (e.button !== 0) return;
    draggedRef.current = id;
    dragOverRef.current = null;
    didDragRef.current = false;
    const startX = e.clientX;
    const startY = e.clientY;

    function findShelfId(el: Element | null): string | null {
      while (el) {
        const sid = el.getAttribute("data-shelf-id");
        if (sid) return sid;
        el = el.parentElement;
      }
      return null;
    }

    function showGhost(x: number, y: number) {
      if (!ghostRef.current) {
        const ghost = document.createElement("div");
        ghost.className = "customize-home-drag-ghost";
        ghost.textContent = rowById.get(id)?.title ?? id;
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
      if (!draggedRef.current) return;
      if (!didDragRef.current) {
        if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 5) return;
        didDragRef.current = true;
        setDraggingId(draggedRef.current);
      }
      showGhost(ev.clientX, ev.clientY);
      const target = document.elementFromPoint(ev.clientX, ev.clientY);
      const overId = target ? findShelfId(target) : null;
      if (overId && overId !== draggedRef.current && rowById.has(overId)) {
        dragOverRef.current = overId;
        setDragOverId(overId);
      } else {
        dragOverRef.current = null;
        setDragOverId(null);
      }
    }

    function onMouseUp() {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      removeGhost();
      const from = draggedRef.current;
      const to = dragOverRef.current;
      if (didDragRef.current && from && to && from !== to) {
        const ids = [...order];
        const fromIdx = ids.indexOf(from);
        const toIdx = ids.indexOf(to);
        if (fromIdx !== -1 && toIdx !== -1) {
          ids.splice(fromIdx, 1);
          ids.splice(toIdx, 0, from);
          props.onReorder(ids);
        }
      }
      draggedRef.current = null;
      dragOverRef.current = null;
      setDraggingId(null);
      setDragOverId(null);
      // Reset after the click event that follows mouseup would have fired.
      setTimeout(() => { didDragRef.current = false; }, 0);
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }

  return (
    <div className="ds-modal-overlay home-customize-overlay">
      <div className="ds-modal ds-modal--lg customize-home-modal" onClick={(e) => e.stopPropagation()}>
        <div className="customize-home-header">
          <h2 className="ds-modal-title">Customize Home</h2>
          <span className="customize-home-count">{visibleCount} of {order.length} shown</span>
        </div>
        <p className="customize-home-hint">Drag <span className="customize-home-handle-inline">⠿</span> to reorder. The first shown shelf becomes the carousel.</p>

        <input
          className="ds-search customize-home-search"
          type="text"
          placeholder="Search shelves…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        <div className="customize-home-list">
          {filteredOrder.length === 0 && (
            <div className="customize-home-empty">No shelves match "{query}"</div>
          )}
          {filteredOrder.map((id) => {
            const visible = isShelfVisible(id, props.visibility);
            const row = rowById.get(id);
            return (
              <div
                key={id}
                data-shelf-id={id}
                className={
                  "customize-home-row" +
                  (visible ? "" : " off") +
                  (draggingId === id ? " dragging" : "") +
                  (dragOverId === id ? " drag-over" : "")
                }
              >
                <span
                  className="customize-home-handle"
                  onMouseDown={(e) => handleHandleMouseDown(e, id)}
                  title="Drag to reorder"
                >⠿</span>
                <div className="customize-home-text">
                  <span className="customize-home-title-line">
                    <span className="customize-home-title">{row?.title ?? id}</span>
                    {row?.source && <span className="customize-home-source">{row.source}</span>}
                  </span>
                  {row?.description && <span className="customize-home-desc">{row.description}</span>}
                </div>
                <Toggle
                  checked={visible}
                  onChange={() => props.onToggle(id)}
                />
              </div>
            );
          })}
        </div>

        <div className="ds-modal-actions">
          <button className="ds-btn ds-btn--ghost" onClick={props.onReset}>Reset</button>
          <button className="ds-btn ds-btn--primary" onClick={props.onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
