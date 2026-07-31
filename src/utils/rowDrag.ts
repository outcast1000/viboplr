// Generic vertical drag-to-reorder for settings-style lists, extracted from
// SettingsPanel's provider lists so every "priority list" surface behaves the
// same (5px threshold, cursor-following ghost, accent drop indicator).
//
// Markup contract (the `.provider-v*` classes in SettingsPanel.css carry the
// styling, and are reused verbatim by other lists):
//   <div data-vlist>
//     <div data-row-index="0"> <span onMouseDown={startRowDrag(...)}>⠿</span> … </div>
//     …
//   </div>

/**
 * Begin a drag from a row handle. Reorders within the handle's own
 * `[data-vlist]` container; `onReorder(from, to)` applies the move on drop
 * (never called for a plain click, or when the row didn't move).
 */
export function startRowDrag(
  e: React.MouseEvent,
  sourceIndex: number,
  displayName: string,
  onReorder: (from: number, to: number) => void,
): void {
  if (e.button !== 0) return;
  e.preventDefault();
  const startX = e.clientX;
  const startY = e.clientY;
  const handle = e.currentTarget as HTMLElement;
  const sourceRow = handle.closest("[data-row-index]") as HTMLElement | null;
  const list = handle.closest("[data-vlist]") as HTMLElement | null;
  if (!sourceRow || !list) return;
  let overIndex: number | null = null;
  let didDrag = false;
  let ghost: HTMLDivElement | null = null;

  function findRowIndex(el: Element | null): number | null {
    while (el && el !== list) {
      const idx = el.getAttribute("data-row-index");
      if (idx !== null) return parseInt(idx, 10);
      el = el.parentElement;
    }
    return null;
  }

  function clearDropIndicators() {
    list!.querySelectorAll(".provider-vrow-drop-above, .provider-vrow-drop-below").forEach((el) => {
      el.classList.remove("provider-vrow-drop-above", "provider-vrow-drop-below");
    });
  }

  function onMouseMove(ev: MouseEvent) {
    if (!didDrag) {
      if (Math.abs(ev.clientX - startX) < 5 && Math.abs(ev.clientY - startY) < 5) return;
      didDrag = true;
      sourceRow!.classList.add("provider-vrow-dragging");
    }
    if (!ghost) {
      ghost = document.createElement("div");
      ghost.className = "provider-vrow-ghost";
      ghost.textContent = displayName;
      document.body.appendChild(ghost);
    }
    ghost.style.left = `${ev.clientX + 12}px`;
    ghost.style.top = `${ev.clientY - 10}px`;

    clearDropIndicators();
    const target = document.elementFromPoint(ev.clientX, ev.clientY);
    const overIdx = list!.contains(target) ? findRowIndex(target) : null;
    overIndex = overIdx;
    if (overIdx !== null && overIdx !== sourceIndex) {
      const targetRow = list!.querySelector(`[data-row-index="${overIdx}"]`);
      if (targetRow) {
        targetRow.classList.add(overIdx < sourceIndex ? "provider-vrow-drop-above" : "provider-vrow-drop-below");
      }
    }
  }

  function onMouseUp() {
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
    if (ghost) { ghost.remove(); ghost = null; }
    clearDropIndicators();
    sourceRow!.classList.remove("provider-vrow-dragging");
    if (didDrag && overIndex !== null && overIndex !== sourceIndex) {
      onReorder(sourceIndex, overIndex);
    }
  }

  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);
}

/** Move `from` to `to` in a copy of `list`. Pure + exported for tests. */
export function reorderList<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length) return list;
  const next = list.slice();
  const [moved] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(next.length, to)), 0, moved);
  return next;
}
