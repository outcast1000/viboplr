import { useState } from "react";
import AutocompleteInput from "./AutocompleteInput";
import "./TagEditor.css";

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
}: TagEditorProps) {
  const [input, setInput] = useState("");

  const exclude = new Set(tags.map((t) => t.toLowerCase()));

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
    </div>
  );
}
