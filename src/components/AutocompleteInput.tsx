import { useState, useRef, useMemo, useEffect } from "react";
import { filterSuggestions } from "../utils/filterSuggestions";

interface AutocompleteInputProps {
  value: string;
  onChange: (value: string) => void;
  suggestions: string[];
  /** Lowercased names to hide from the dropdown (e.g. already-added tags). */
  exclude?: Set<string>;
  placeholder?: string;
  disabled?: boolean;
  inputClassName?: string;
  /** Fires on Enter / row-select. When set, the field acts as a committer (tags). */
  onCommit?: (value: string) => void;
  /** Extra key handling delegated from the parent (e.g. tag Backspace). */
  onKeyDownExtra?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  autoFocus?: boolean;
}

export default function AutocompleteInput({
  value,
  onChange,
  suggestions,
  exclude,
  placeholder,
  disabled,
  inputClassName,
  onCommit,
  onKeyDownExtra,
  autoFocus,
}: AutocompleteInputProps) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dropdownRef = useRef<HTMLDivElement | null>(null);

  const matches = useMemo(
    () => filterSuggestions(suggestions, value, exclude),
    [suggestions, value, exclude],
  );

  useEffect(() => {
    return () => { if (blurTimer.current) clearTimeout(blurTimer.current); };
  }, []);

  // Auto-highlight the first match as the user types (or on open). Reset to none
  // when there are no matches. Re-keyed on value/open so mouse/arrow highlight
  // persists between keystrokes instead of snapping back every render.
  useEffect(() => {
    setHighlight(matches.length > 0 ? 0 : -1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, open]);

  // Keep the keyboard-highlighted row scrolled into view (matches CentralSearchDropdown).
  useEffect(() => {
    if (highlight < 0 || !dropdownRef.current) return;
    const el = dropdownRef.current.querySelector(".autocomplete-row.highlighted") as HTMLElement | null;
    el?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  function select(name: string) {
    if (onCommit) {
      onCommit(name);
    } else {
      onChange(name);
    }
    setOpen(false);
    setHighlight(-1);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (open && matches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight((h) => (h + 1) % matches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => (h - 1 + matches.length) % matches.length);
        return;
      }
      // Enter or Tab accepts the highlighted suggestion.
      if ((e.key === "Enter" || e.key === "Tab") && highlight >= 0) {
        e.preventDefault();
        select(matches[highlight]);
        return;
      }
    }
    if (e.key === "Escape") {
      setOpen(false);
      setHighlight(-1);
      return;
    }
    if (e.key === "Enter" && onCommit) {
      e.preventDefault();
      if (value.trim()) {
        onCommit(value);
        setOpen(false);
        setHighlight(-1);
      }
      return;
    }
    onKeyDownExtra?.(e);
  }

  return (
    <div className="autocomplete-wrapper">
      <input
        className={inputClassName ?? "ds-input"}
        type="text"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => { blurTimer.current = setTimeout(() => setOpen(false), 120); }}
        onKeyDown={handleKeyDown}
        role="combobox"
        aria-expanded={open && matches.length > 0}
        aria-autocomplete="list"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
      />
      {open && matches.length > 0 && (
        <div
          className="autocomplete-dropdown"
          role="listbox"
          ref={dropdownRef}
          onMouseDown={() => { if (blurTimer.current) clearTimeout(blurTimer.current); }}
        >
          {matches.map((name, i) => (
            <div
              key={name}
              role="option"
              aria-selected={i === highlight}
              className={`autocomplete-row${i === highlight ? " highlighted" : ""}`}
              onClick={() => select(name)}
            >
              {name}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
