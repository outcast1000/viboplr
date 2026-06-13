import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import TagEditor from "./TagEditor";
import { useTagActions } from "../hooks/useTagActions";
import type { QueueTrack } from "../types";
import "./TagPopover.css";

interface TagPopoverProps {
  track: QueueTrack;
  suggestions: string[];
  /** Notifies the parent of the current tag list so it can render them inline
   *  in the subtitle (kept in sync as the user adds/removes here). */
  onTagsChange?: (tags: string[]) => void;
}

export default function TagPopover({ track, suggestions, onTagsChange }: TagPopoverProps) {
  const [open, setOpen] = useState(false);
  const [resolvedId, setResolvedId] = useState<number | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const tagActions = useTagActions();

  // Resolve + load tags whenever the modal opens (cheap: only on demand).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    invoke<{ id: number } | null>("find_track_by_metadata", {
      title: track.title,
      artistName: track.artist_name ?? null,
      albumName: track.album_title ?? null,
    })
      .then((lib) => {
        if (cancelled) return;
        if (!lib) { setResolvedId(null); setTags([]); return; }
        setResolvedId(lib.id);
        invoke<Array<{ id: number; name: string }>>("get_tags_for_track", { trackId: lib.id })
          .then((rows) => { if (!cancelled) setTags(rows.map((r) => r.name)); })
          .catch((e) => console.error("Failed to load tags for now-playing track:", e));
      })
      .catch((e) => console.error("Failed to resolve now-playing track:", e));
    return () => { cancelled = true; };
  }, [open, track.title, track.artist_name, track.album_title]);

  // Reset when the track changes (close the modal).
  useEffect(() => { setOpen(false); }, [track.key]);

  // Escape closes the modal. Per the modal-dismiss convention, an outside click
  // on the overlay does NOT close it — only Escape, the × button, or Done.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setOpen(false); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  function syncTags(next: string[]) {
    setTags(next);
    onTagsChange?.(next);
  }

  async function handleAdd(name: string) {
    if (resolvedId == null) return;
    syncTags([...tags, name]);
    const names = await tagActions.add(resolvedId, name);
    if (names == null) syncTags(tags.filter((t) => t.toLowerCase() !== name.toLowerCase()));
    else syncTags(names);
  }

  async function handleRemove(name: string) {
    if (resolvedId == null) return;
    const before = tags;
    syncTags(before.filter((t) => t.toLowerCase() !== name.toLowerCase()));
    const names = await tagActions.remove(resolvedId, before, name);
    if (names == null) syncTags(before);
    else syncTags(names);
  }

  return (
    <>
      <button
        className="now-tag-btn"
        title="Edit tags"
        onClick={() => setOpen(true)}
        aria-label="Edit tags"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82Z" />
          <line x1="7" y1="7" x2="7.01" y2="7" />
        </svg>
      </button>
      {open && createPortal(
        <div className="ds-modal-overlay">
          <div className="ds-modal tag-edit-modal" role="dialog" aria-label="Edit tags" aria-modal="true">
            <div className="tag-edit-modal-head">
              <div className="ds-modal-title tag-edit-modal-title">Edit tags</div>
              <button className="tag-edit-modal-close" onClick={() => setOpen(false)} aria-label="Close" title="Close">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            <div className="tag-edit-modal-track">{track.title}</div>
            {resolvedId != null && tags.length === 0 && (
              <div className="tag-edit-modal-emptyhint">No tags yet — add one below.</div>
            )}
            <TagEditor
              tags={tags}
              suggestions={suggestions}
              onAdd={handleAdd}
              onRemove={handleRemove}
              variant="popover"
              disabled={resolvedId == null}
              disabledHint="Add this track to your library to tag it"
              placeholder="Type a tag and press Enter…"
              autoFocus
              chipPrefix="#"
            />
            <div className="ds-modal-actions">
              <button className="ds-btn ds-btn--primary ds-btn--sm" onClick={() => setOpen(false)}>Done</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
