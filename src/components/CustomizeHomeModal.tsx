import { useRef, useState } from "react";
import { BUILTIN_SHELF_DESCRIPTORS, isShelfVisible } from "../hooks/useHome";
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

export interface CustomizeHomeModalProps {
  // Current order of the built-in shelves (ids), including Radio. The first
  // visible shelf becomes the Home hero carousel. Only built-in shelves are
  // configurable here; plugin shelves are not surfaced.
  builtInOrder: string[];
  visibility: Record<string, boolean>;
  onReorder: (orderedIds: string[]) => void;
  onToggle: (id: string) => void;
  onReset: () => void;
  onClose: () => void;
}

export function CustomizeHomeModal(props: CustomizeHomeModalProps) {
  const titleById = new Map(BUILTIN_SHELF_DESCRIPTORS.map((d) => [d.id, d.title]));
  const descById = new Map(BUILTIN_SHELF_DESCRIPTORS.map((d) => [d.id, d.description]));

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
        ghost.textContent = titleById.get(id) ?? id;
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
      // Only built-in rows are reorderable targets.
      if (overId && overId !== draggedRef.current && titleById.has(overId)) {
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
        const ids = [...props.builtInOrder];
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
    <div className="ds-modal-overlay">
      <div className="ds-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="ds-modal-title">Customize Home</h2>
        <p className="customize-home-hint">Drag to reorder. The first shown shelf becomes the carousel.</p>

        <div className="customize-home-list">
          {props.builtInOrder.map((id) => (
            <div
              key={id}
              data-shelf-id={id}
              className={
                "customize-home-row" +
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
                <span className="customize-home-title">{titleById.get(id) ?? id}</span>
                {descById.get(id) && <span className="customize-home-desc">{descById.get(id)}</span>}
              </div>
              <Toggle
                checked={isShelfVisible(id, props.visibility)}
                onChange={() => props.onToggle(id)}
              />
            </div>
          ))}
        </div>

        <div className="ds-modal-actions">
          <button className="ds-btn ds-btn--ghost" onClick={props.onReset}>Reset</button>
          <button className="ds-btn ds-btn--primary" onClick={props.onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
