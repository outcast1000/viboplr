import { useRef, useEffect } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
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
  albumImages: Record<number, string | null>;
  artistImages: Record<number, string | null>;
  onFetchAlbumImage: (entity: { id: number; title: string; artist_name: string | null }) => void;
  onFetchArtistImage: (entity: { id: number; name: string }) => void;
}

function ResultImage({ track, albumImages, artistImages }: {
  track: Track;
  albumImages: Record<number, string | null>;
  artistImages: Record<number, string | null>;
}) {
  // Fallback chain: album image → artist image → initial letter
  const albumPath = track.album_id != null ? albumImages[track.album_id] : undefined;
  const artistPath = track.artist_id != null ? artistImages[track.artist_id] : undefined;
  const imagePath = albumPath || artistPath;

  if (imagePath) {
    return <img className="result-img" src={convertFileSrc(imagePath)} alt="" />;
  }

  const initial = (track.title[0] ?? "?").toUpperCase();
  return <span className="result-img-fallback">{initial}</span>;
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
  albumImages,
  artistImages,
  onFetchAlbumImage,
  onFetchArtistImage,
}: CentralSearchDropdownProps) {
  const internalRef = useRef<HTMLInputElement>(null);
  const inputRef = externalInputRef ?? internalRef;
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on click outside
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

  // Trigger image fetching for visible results
  useEffect(() => {
    if (!isOpen) return;
    for (const track of results) {
      if (track.album_id != null && albumImages[track.album_id] === undefined) {
        onFetchAlbumImage({ id: track.album_id, title: track.album_title ?? "", artist_name: track.artist_name });
      }
      if (track.artist_id != null && artistImages[track.artist_id] === undefined) {
        onFetchArtistImage({ id: track.artist_id, name: track.artist_name ?? "Unknown" });
      }
    }
  }, [isOpen, results, albumImages, artistImages, onFetchAlbumImage, onFetchArtistImage]);

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
              <div className="result-art">
                <ResultImage track={track} albumImages={albumImages} artistImages={artistImages} />
              </div>
              <div className="result-info">
                <div className="result-title">{track.title}</div>
                <div className="result-subtitle">
                  {track.artist_name}
                  {track.artist_name && track.album_title && " · "}
                  {track.album_title}
                </div>
              </div>
              <span className="result-play">▶</span>
            </div>
          ))}
          <div className="central-search-footer">
            <span>↵ play</span>
            <span className="footer-separator">·</span>
            <span>⌘↵ queue</span>
            <span className="footer-separator">·</span>
            <span>↵ from search for all results</span>
          </div>
        </div>
      )}
    </div>
  );
}
