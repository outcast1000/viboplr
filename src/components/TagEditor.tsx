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
}: TagEditorProps) {
  const [input, setInput] = useState("");

  const exclude = new Set(tags.map((t) => t.toLowerCase()));

  // One-click pills: curated suggestions minus already-applied tags, deduped
  // case-insensitively and capped. Hidden when the editor is read-only.
  const pills = useMemo(
    () => (disabled || !suggestedPills?.length ? [] : selectSuggestionPills(suggestedPills, tags, MAX_PILLS)),
    [suggestedPills, tags, disabled],
  );

  function commit(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (exclude.has(trimmed.toLowerCase())) {
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
    } else if (e.key === "Backspace" && input === "" && tags.length > 0) {
      onRemove(tags[tags.length - 1]);
    }
  }

  return (
    <div className={`tag-editor tag-editor--${variant}`}>
      <div className="tag-editor-chips">
        {tags.map((name) => (
          <span key={name} className="track-tag-chip track-tag-assigned">
            <span className="track-tag-name">{chipPrefix}{name}</span>
            {!disabled && (
              <span
                className="track-tag-remove"
                onClick={() => onRemove(name)}
                title="Remove tag"
              >
                &times;
              </span>
            )}
          </span>
        ))}
        {tags.length === 0 && disabled && (
          <span className="tag-editor-empty">No tags</span>
        )}
      </div>
      {disabled ? (
        disabledHint ? <span className="tag-editor-hint">{disabledHint}</span> : null
      ) : (
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
      )}
      {pills.length > 0 && (
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
      )}
    </div>
  );
}
