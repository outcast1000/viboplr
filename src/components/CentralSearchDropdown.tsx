import { useRef, useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Track, Album, Artist, SearchAllResults, SearchResultItem } from "../types";

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
  albumImages: Record<number, string | null>;
  artistImages: Record<number, string | null>;
  onFetchAlbumImage: (entity: { id: number; title: string; artist_name: string | null }) => void;
  onFetchArtistImage: (entity: { id: number; name: string }) => void;
}

function ArtistImage({ artist, artistImages }: {
  artist: Artist;
  artistImages: Record<number, string | null>;
}) {
  const path = artistImages[artist.id];
  if (path) {
    return <img className="result-img result-img-round" src={convertFileSrc(path)} alt="" />;
  }
  const initial = (artist.name[0] ?? "?").toUpperCase();
  return <span className="result-img-fallback result-img-round">{initial}</span>;
}

function AlbumImage({ album, albumImages, artistImages }: {
  album: Album;
  albumImages: Record<number, string | null>;
  artistImages: Record<number, string | null>;
}) {
  const albumPath = albumImages[album.id];
  const artistPath = album.artist_id != null ? artistImages[album.artist_id] : undefined;
  const imagePath = albumPath || artistPath;
  if (imagePath) {
    return <img className="result-img" src={convertFileSrc(imagePath)} alt="" />;
  }
  const initial = (album.title[0] ?? "?").toUpperCase();
  return <span className="result-img-fallback">{initial}</span>;
}

function TrackImage({ track, albumImages, artistImages }: {
  track: Track;
  albumImages: Record<number, string | null>;
  artistImages: Record<number, string | null>;
}) {
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
  items,
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
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [placeholder, setPlaceholder] = useState(randomPlaceholder);

  useEffect(() => {
    const id = setInterval(() => setPlaceholder(randomPlaceholder()), 5 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

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
    for (const artist of results.artists) {
      if (artistImages[artist.id] === undefined) {
        onFetchArtistImage({ id: artist.id, name: artist.name });
      }
    }
    for (const album of results.albums) {
      if (albumImages[album.id] === undefined) {
        onFetchAlbumImage({ id: album.id, title: album.title, artist_name: album.artist_name });
      }
      if (album.artist_id != null && artistImages[album.artist_id] === undefined) {
        onFetchArtistImage({ id: album.artist_id, name: album.artist_name ?? "Unknown" });
      }
    }
    for (const track of results.tracks) {
      if (track.album_id != null && albumImages[track.album_id] === undefined) {
        onFetchAlbumImage({ id: track.album_id, title: track.album_title ?? "", artist_name: track.artist_name });
      }
      if (track.artist_id != null && artistImages[track.artist_id] === undefined) {
        onFetchArtistImage({ id: track.artist_id, name: track.artist_name ?? "Unknown" });
      }
    }
  }, [isOpen, results, albumImages, artistImages, onFetchAlbumImage, onFetchArtistImage]);

  // Scroll highlighted item into view
  useEffect(() => {
    if (highlightedIndex < 0 || !dropdownRef.current) return;
    const el = dropdownRef.current.querySelector(".central-search-result.highlighted") as HTMLElement | null;
    el?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex]);

  const artistOffset = 0;
  const albumOffset = results.artists.length;
  const trackOffset = results.artists.length + results.albums.length;

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

      {isOpen && items.length > 0 && (
        <div className="central-search-dropdown" ref={dropdownRef}>
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
                    <ArtistImage artist={artist} artistImages={artistImages} />
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
                    <AlbumImage album={album} albumImages={albumImages} artistImages={artistImages} />
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
                    <TrackImage track={track} albumImages={albumImages} artistImages={artistImages} />
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
          <div className="central-search-footer">
            <span>↵ open</span>
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
