// src/components/CentralSearchDropdown.tsx
import { useRef, useEffect } from "react";
import type { Track } from "../types";

interface CentralSearchDropdownProps {
  query: string;
  onQueryChange: (q: string) => void;
  results: Track[];
  isOpen: boolean;
  highlightedIndex: number;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onResultClick: (track: Track) => void;
  onClose: () => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
}

export function CentralSearchDropdown({
  query,
  onQueryChange,
  results,
  isOpen,
  highlightedIndex,
  onKeyDown,
  onResultClick,
  onClose,
  inputRef: externalInputRef,
}: CentralSearchDropdownProps) {
  const internalRef = useRef<HTMLInputElement>(null);
  const inputRef = externalInputRef ?? internalRef;
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isOpen, onClose]);

  return (
    <div className="central-search-container" ref={containerRef}>
      <div className="search-input-wrapper">
        <svg
          className="search-icon"
          width="18"
          height="18"
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
          placeholder="What do you want to play?"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => {
            setTimeout(() => {
              if (!containerRef.current?.contains(document.activeElement)) {
                onClose();
              }
            }, 150);
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
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>

      {isOpen && results.length > 0 && (
        <div className="central-search-dropdown">
          {results.map((track, i) => (
            <div
              key={track.id}
              className={`central-search-result ${i === highlightedIndex ? "highlighted" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                onResultClick(track);
              }}
            >
              <span className="result-title">{track.title}</span>
              <span className="result-artist">{track.artist_name}</span>
              <span className="result-play">▶</span>
            </div>
          ))}
          <div className="central-search-footer">
            Press Enter to see all results →
          </div>
        </div>
      )}
    </div>
  );
}
