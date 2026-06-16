import { useMemo, useState } from "react";
import AutocompleteInput from "./AutocompleteInput";
import { selectSuggestionPills } from "../utils/tagSuggestions";
import "./TagEditor.css";

/** Max one-click suggestion pills rendered below the input. */
const MAX_PILLS = 12;

export interface TagEditorProps {
  /** Currently-applied tag names (rendered as removable chips). */
  tags: string[];
  /** Ranked suggestion pool (see buildTagSuggestionPool). */
  suggestions: string[];
  /** Add one tag (already-applied names are pre-filtered out of the dropdown). */
  onAdd: (name: string) => void;
  /** Remove one tag. */
  onRemove: (name: string) => void;
  /** Read-only when true (e.g. non-library track on a Now Playing surface). */
  disabled?: boolean;
  /** Hint shown in place of the input when disabled. */
  disabledHint?: string;
  /** Layout only — logic is identical. */
  variant?: "inline" | "popover";
  /** Placeholder for the input (when enabled). */
  placeholder?: string;
  autoFocus?: boolean;
  /** Display-only prefix shown before each chip's name (e.g. "#"). Does not
   *  affect the stored tag name passed to onAdd/onRemove. */
  chipPrefix?: string;
  /** Optional curated tags rendered as one-click "add" pills below the input
   *  (e.g. Last.fm community tags). Already-applied tags are filtered out and
   *  the list is de-duplicated case-insensitively and capped. */
  suggestedPills?: string[];
  /** Label shown before the suggestion pills (default "Suggested"). */
  suggestedPillsLabel?: string;
  /** Tags present on only SOME of the target tracks, rendered as muted chips
   *  with an `n / m` count and (when onFillToAll is set) a fill-to-all control.
   *  Providing this also disables Backspace-to-remove (ambiguous with partials). */
  partialTags?: { name: string; count: number; total: number }[];
  /** Apply a partial tag to all target tracks (the fill-to-all control). */
  onFillToAll?: (name: string) => void;
  /** Make chip labels clickable (e.g. navigate to the tag's detail page). */
  onChipLabelClick?: (name: string) => void;
  /** Lay the input and suggestion pills on a single row (pills first, input
   *  after). Default false: the legacy stacked layout (input, then pills row). */
  inlineSuggestions?: boolean;
}

export default function TagEditor({
  tags,
  suggestions,
  onAdd,
  onRemove,
  disabled,
  disabledHint,
  variant = "inline",
  placeholder,
  autoFocus,
  chipPrefix = "",
  suggestedPills,
  suggestedPillsLabel = "Suggested",
  partialTags,
  onFillToAll,
  onChipLabelClick,
  inlineSuggestions,
}: TagEditorProps) {
  const [input, setInput] = useState("");

  // Names already represented (fully applied or partial) — excluded from the
  // dropdown and pills so they aren't offered for re-add.
  const appliedNames = useMemo(
    () => [...tags, ...(partialTags ?? []).map((p) => p.name)],
    [tags, partialTags],
  );
  const exclude = new Set(appliedNames.map((t) => t.toLowerCase()));

  // One-click pills: curated suggestions minus already-applied tags, deduped
  // case-insensitively and capped. Hidden when the editor is read-only.
  const pills = useMemo(
    () => (disabled || !suggestedPills?.length ? [] : selectSuggestionPills(suggestedPills, appliedNames, MAX_PILLS)),
    [suggestedPills, appliedNames, disabled],
  );

  function commit(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    const lower = trimmed.toLowerCase();
    // Typing a partial tag's name means "apply it to all" — route to fill rather
    // than silently no-opping (partial names are in the exclude set, so without
    // this the only way to promote a partial tag would be the hover fill control).
    const partialMatch = partialTags?.find((p) => p.name.toLowerCase() === lower);
    if (partialMatch && onFillToAll) {
      onFillToAll(partialMatch.name);
      setInput("");
      return;
    }
    if (exclude.has(lower)) {
      setInput("");
      return;
    }
    onAdd(trimmed);
    setInput("");
  }

  function handleKeyDownExtra(e: React.KeyboardEvent<HTMLInputElement>) {
    // Comma also commits (matches the legacy BulkEditModal behavior).
    if (e.key === ",") {
      e.preventDefault();
      commit(input);
    } else if (e.key === "Backspace" && input === "" && tags.length > 0 && partialTags === undefined) {
      onRemove(tags[tags.length - 1]);
    }
  }

  const inputEl = (
    <AutocompleteInput
      value={input}
      onChange={setInput}
      suggestions={suggestions}
      exclude={exclude}
      onCommit={commit}
      onKeyDownExtra={handleKeyDownExtra}
      placeholder={placeholder ?? "Add a tag…"}
      inputClassName="tag-editor-input ds-input"
      autoFocus={autoFocus}
    />
  );
  const pillsEl = pills.length > 0 ? (
    <div className="tag-editor-suggested">
      <span className="tag-editor-suggested-label">{suggestedPillsLabel}</span>
      {pills.map((name) => (
        <button
          type="button"
          key={name}
          className="tag-editor-suggested-pill"
          onClick={() => commit(name)}
          title={`Add "${name}"`}
        >
          <span className="tag-editor-suggested-plus">+</span>{chipPrefix}{name}
        </button>
      ))}
    </div>
  ) : null;
  const showAddArea = !disabled;

  return (
    <div className={`tag-editor tag-editor--${variant}${inlineSuggestions ? " tag-editor--entity" : ""}`}>
      <div className="tag-editor-chips">
        {tags.map((name) => (
          <span key={`full:${name}`} className="track-tag-chip track-tag-assigned">
            <span
              className={onChipLabelClick ? "track-tag-name track-tag-name--link" : "track-tag-name"}
              onClick={onChipLabelClick ? (e) => { e.stopPropagation(); onChipLabelClick(name); } : undefined}
              title={onChipLabelClick ? `Open "${name}"` : undefined}
            >
              {chipPrefix}{name}
            </span>
            {!disabled && (
              <span
                className="track-tag-remove"
                onClick={(e) => { e.stopPropagation(); onRemove(name); }}
                title="Remove tag"
              >
                &times;
              </span>
            )}
          </span>
        ))}
        {(partialTags ?? []).map((pt) => (
          <span key={`partial:${pt.name}`} className="track-tag-chip track-tag-assigned track-tag-partial">
            <span
              className={onChipLabelClick ? "track-tag-name track-tag-name--link" : "track-tag-name"}
              onClick={onChipLabelClick ? (e) => { e.stopPropagation(); onChipLabelClick(pt.name); } : undefined}
              title={onChipLabelClick ? `Open "${pt.name}"` : undefined}
            >
              {chipPrefix}{pt.name}
            </span>
            <span className="track-tag-count" title={`On ${pt.count} of ${pt.total} tracks`}>
              {pt.count}/{pt.total}
            </span>
            {!disabled && onFillToAll && (
              <span
                className="track-tag-fill"
                onClick={(e) => { e.stopPropagation(); onFillToAll(pt.name); }}
                title="Apply to all tracks"
              >
                &uarr;
              </span>
            )}
            {!disabled && (
              <span
                className="track-tag-remove"
                onClick={(e) => { e.stopPropagation(); onRemove(pt.name); }}
                title="Remove from all tracks"
              >
                &times;
              </span>
            )}
          </span>
        ))}
        {tags.length === 0 && (partialTags?.length ?? 0) === 0 && disabled && (
          <span className="tag-editor-empty">No tags</span>
        )}
      </div>
      {disabled && disabledHint && (
        <span className="tag-editor-hint">{disabledHint}</span>
      )}
      {showAddArea && (inlineSuggestions ? (
        <div className="tag-editor-add-row">
          {pillsEl}
          {inputEl}
        </div>
      ) : (
        <>
          {inputEl}
          {pillsEl}
        </>
      ))}
    </div>
  );
}
