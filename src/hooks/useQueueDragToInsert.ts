import { useState } from "react";
import type { QueueTrack } from "../types";
import { store } from "../store";

/** Pending enqueue captured when a drop (or enqueue) hits duplicates already in
 * the queue. `position` is set only for drag-to-insert drops; a plain enqueue
 * leaves it undefined (append). Owned by `useContextMenuActions` because both the
 * enqueue path and this drag path populate it; the duplicate banner reads it. */
export interface PendingEnqueue {
  all: QueueTrack[];
  duplicates: QueueTrack[];
  unique: QueueTrack[];
  position?: number;
}

interface UseQueueDragToInsertDeps {
  queueHook: {
    findDuplicates: (tracks: QueueTrack[]) => { duplicates: QueueTrack[]; unique: QueueTrack[] };
    insertAtPosition: (tracks: QueueTrack[], pos: number) => void;
    queue: QueueTrack[];
  };
  queueCollapsed: boolean;
  setQueueCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  setPendingEnqueue: React.Dispatch<React.SetStateAction<PendingEnqueue | null>>;
}

/**
 * Drag-to-queue: dragging tracks (from any list) onto the queue panel inserts
 * them at the drop position. Owns the `externalDropTarget` indicator state and
 * the raw mouse-listener / ghost-element DOM handshake (the WKWebView pattern
 * documented by the drag-and-drop skill). Duplicate drops defer to the shared
 * `pendingEnqueue` banner instead of inserting immediately.
 */
export function useQueueDragToInsert({ queueHook, queueCollapsed, setQueueCollapsed, setPendingEnqueue }: UseQueueDragToInsertDeps) {
  const [externalDropTarget, setExternalDropTarget] = useState<number | null>(null);

  function handleTrackDragStart(dragTracks: QueueTrack[]) {
    let ghost: HTMLDivElement | null = null;
    const dropTargetRef = { current: null as number | null };

    function findQueueIndex(el: Element | null): number | null {
      while (el) {
        const idx = el.getAttribute("data-queue-index");
        if (idx !== null) return parseInt(idx, 10);
        el = el.parentElement;
      }
      return null;
    }

    function onMouseMove(ev: MouseEvent) {
      if (!ghost) {
        ghost = document.createElement("div");
        ghost.className = "queue-drag-ghost";
        ghost.textContent = `${dragTracks.length} track${dragTracks.length > 1 ? "s" : ""}`;
        document.body.appendChild(ghost);
      }
      ghost.style.left = `${ev.clientX + 12}px`;
      ghost.style.top = `${ev.clientY - 10}px`;

      const target = document.elementFromPoint(ev.clientX, ev.clientY);
      const queuePanel = target?.closest(".queue-panel");
      if (queuePanel) {
        const overIndex = findQueueIndex(target);
        if (overIndex !== null) {
          const el = target!.closest("[data-queue-index]") as HTMLElement | null;
          if (el) {
            const rect = el.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;
            const dt = ev.clientY < midY ? overIndex : overIndex + 1;
            dropTargetRef.current = dt;
            setExternalDropTarget(dt);
          }
        } else {
          // Over queue panel but not on an item — drop at end
          dropTargetRef.current = queueHook.queue.length;
          setExternalDropTarget(queueHook.queue.length);
        }
      } else {
        dropTargetRef.current = null;
        setExternalDropTarget(null);
      }
    }

    function onMouseUp() {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      if (ghost) { ghost.remove(); ghost = null; }

      if (dropTargetRef.current !== null) {
        const pos = dropTargetRef.current;
        const { duplicates, unique } = queueHook.findDuplicates(dragTracks);
        if (duplicates.length > 0) {
          setPendingEnqueue({ all: dragTracks, duplicates, unique, position: pos });
          if (queueCollapsed) { setQueueCollapsed(false); store.set("queueCollapsed", false); }
        } else {
          queueHook.insertAtPosition(dragTracks, pos);
          if (queueCollapsed) { setQueueCollapsed(false); store.set("queueCollapsed", false); }
        }
      }

      setExternalDropTarget(null);
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }

  return { externalDropTarget, handleTrackDragStart };
}
