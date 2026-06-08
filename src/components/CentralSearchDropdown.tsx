import { useRef, useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Track, Album, Artist, SearchAllResults, SearchResultItem } from "../types";
import "./CentralSearchDropdown.css";

const mod = navigator.platform.includes("Mac") ? "\u2318" : "Ctrl+";

const SEARCH_PLACEHOLDERS = [
  "What's next?",
  "What comes next?",
  "Up next...",
  "What do you want to hear?",
  "Find your next track...",
  "Play something...",
  "Search tracks, artists, albums...",
  "Find anything...",
  "Go to...",
  "Drop a vibe...",
  "What's the vibe?",
];

function randomPlaceholder() {
  return SEARCH_PLACEHOLDERS[Math.floor(Math.random() * SEARCH_PLACEHOLDERS.length)];
}

interface CentralSearchDropdownProps {
  query: string;
  onQueryChange: (q: string) => void;
  results: SearchAllResults;
  items: SearchResultItem[];
  isOpen: boolean;
  highlightedIndex: number;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onResultClick: (item: SearchResultItem) => void;
  onClose: () => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  getAlbumImage: (title: string, artistName?: string | null) => string | null;
  getArtistImage: (name: string) => string | null;
}

function ArtistImage({ artist, getArtistImage }: {
  artist: Artist;
  getArtistImage: (name: string) => string | null;
}) {
  const path = getArtistImage(artist.name);
  if (path) {
    return <img className="result-img result-img-round" src={convertFileSrc(path)} alt="" />;
  }
  const initial = (artist.name[0] ?? "?").toUpperCase();
  return <span className="result-img-fallback result-img-round">{initial}</span>;
}

function AlbumImage({ album, getAlbumImage, getArtistImage }: {
  album: Album;
  getAlbumImage: (title: string, artistName?: string | null) => string | null;
  getArtistImage: (name: string) => string | null;
}) {
  const albumPath = getAlbumImage(album.title, album.artist_name);
  const artistPath = album.artist_name ? getArtistImage(album.artist_name) : null;
  const imagePath = albumPath || artistPath;
  if (imagePath) {
    return <img className="result-img" src={convertFileSrc(imagePath)} alt="" />;
  }
  const initial = (album.title[0] ?? "?").toUpperCase();
  return <span className="result-img-fallback">{initial}</span>;
}

function TrackImage({ track, getAlbumImage, getArtistImage }: {
  track: Track;
  getAlbumImage: (title: string, artistName?: string | null) => string | null;
  getArtistImage: (name: string) => string | null;
}) {
  const albumPath = track.album_title ? getAlbumImage(track.album_title, track.artist_name) : null;
  const artistPath = track.artist_name ? getArtistImage(track.artist_name) : null;
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
  items,
  isOpen,
  highlightedIndex,
  onKeyDown,
  onResultClick,
  onClose,
  inputRef: externalInputRef,
  getAlbumImage,
  getArtistImage,
}: CentralSearchDropdownProps) {
  const internalRef = useRef<HTMLInputElement>(null);
  const inputRef = externalInputRef ?? internalRef;
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [placeholder, setPlaceholder] = useState(randomPlaceholder);
  const [focused, setFocused] = useState(false);
  const showDropdown = isOpen && items.length > 0;
  const showOverlay = focused || showDropdown;

  useEffect(() => {
    const id = setInterval(() => setPlaceholder(randomPlaceholder()), 5 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  // Close on click outside
  useEffect(() => {
    if (!showOverlay) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setFocused(false);
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showOverlay, onClose]);

  // Scroll highlighted item into view
  useEffect(() => {
    if (highlightedIndex < 0 || !dropdownRef.current) return;
    const el = dropdownRef.current.querySelector(".central-search-result.highlighted") as HTMLElement | null;
    el?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex]);

  // Display order tracks → albums → artists (matches the mini-player search
  // and the `items` array in useCentralSearch).
  const trackOffset = 0;
  const albumOffset = results.tracks.length;
  const artistOffset = results.tracks.length + results.albums.length;

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
          placeholder={placeholder}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setTimeout(() => {
              if (!containerRef.current?.contains(document.activeElement)) {
                setFocused(false);
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

      {showOverlay && (
        <div className="central-search-dropdown" ref={dropdownRef}>
          <div className="central-search-results">
            {results.tracks.length > 0 && (
              <>
                <div className="search-section-header">Tracks</div>
                {results.tracks.map((track, i) => (
                  <div
                    key={`track-${track.id}`}
                    className={`central-search-result ${trackOffset + i === highlightedIndex ? "highlighted" : ""}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      onResultClick({ kind: "track", data: track });
                    }}
                  >
                    <div className="result-art">
                      <TrackImage track={track} getAlbumImage={getAlbumImage} getArtistImage={getArtistImage} />
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
              </>
            )}
            {results.albums.length > 0 && (
              <>
                <div className="search-section-header">Albums</div>
                {results.albums.map((album, i) => (
                  <div
                    key={`album-${album.id}`}
                    className={`central-search-result ${albumOffset + i === highlightedIndex ? "highlighted" : ""}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      onResultClick({ kind: "album", data: album });
                    }}
                  >
                    <div className="result-art">
                      <AlbumImage album={album} getAlbumImage={getAlbumImage} getArtistImage={getArtistImage} />
                    </div>
                    <div className="result-info">
                      <div className="result-title">{album.title}</div>
                      <div className="result-subtitle">
                        {album.artist_name}
                        {album.artist_name && album.year ? " · " : ""}
                        {album.year}
                      </div>
                    </div>
                    <span className="result-action">→</span>
                  </div>
                ))}
              </>
            )}
            {results.artists.length > 0 && (
              <>
                <div className="search-section-header">Artists</div>
                {results.artists.map((artist, i) => (
                  <div
                    key={`artist-${artist.id}`}
                    className={`central-search-result ${artistOffset + i === highlightedIndex ? "highlighted" : ""}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      onResultClick({ kind: "artist", data: artist });
                    }}
                  >
                    <div className="result-art">
                      <ArtistImage artist={artist} getArtistImage={getArtistImage} />
                    </div>
                    <div className="result-info">
                      <div className="result-title">{artist.name}</div>
                      <div className="result-subtitle">Artist · {artist.track_count} tracks</div>
                    </div>
                    <span className="result-action">→</span>
                  </div>
                ))}
              </>
            )}
          </div>
          {items.length > 0 && (
            <div className="central-search-footer">
              <span><kbd>↵</kbd> play track / open</span>
              <span className="footer-separator">·</span>
              <span><kbd>{mod}↵</kbd> add to queue</span>
              <span className="footer-separator">·</span>
              <span><kbd>↵</kbd> without selection to search</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
