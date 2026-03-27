// src/components/ViewSearchBar.tsx
import { useRef } from "react";

interface ViewSearchBarProps {
  query: string;
  onQueryChange: (q: string) => void;
  placeholder: string;
}

export function ViewSearchBar({ query, onQueryChange, placeholder }: ViewSearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="view-search-bar">
      <svg
        className="view-search-icon"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <input
        ref={inputRef}
        type="text"
        placeholder={placeholder}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            onQueryChange("");
            inputRef.current?.blur();
          }
        }}
      />
      {query && (
        <button
          className="search-clear-btn"
          onClick={() => {
            onQueryChange("");
            inputRef.current?.focus();
          }}
          title="Clear search"
          tabIndex={-1}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      )}
    </div>
  );
}
