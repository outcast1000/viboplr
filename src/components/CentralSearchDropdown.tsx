import { useRef, useEffect, useState } from "react";
import type { Track, SearchAllResults, SearchResultItem } from "../types";
import type { PluginSearchSection } from "../utils/centralSearchPlugins";
import { resolveImageUrl } from "../utils/resolveImageUrl";
import { AlbumCardArt } from "./AlbumCardArt";
import { ArtistCardArt } from "./ArtistCardArt";
import { TrackArtFallback } from "./TrackArtFallback";
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
  /** Sidebar views of the active plugins, offered when the library has no match
   *  — for a streaming-only setup this search can never hit, and an empty box
   *  reads as a broken search rather than "your music isn't indexed here". */
  pluginViews: Array<{ pluginId: string; viewId: string; label: string }>;
  onOpenPluginView: (pluginId: string, viewId: string) => void;
  /** Plugin-catalog sections, laid out by `buildPluginSearchSections`. Each row
   *  carries its own `itemIndex`, so this component never re-derives one. */
  pluginSections: PluginSearchSection[];
}

// Track art mirrors the queue's chain (queue.md "Image Resolution"): album image
// → artist image → the shared audio/video placeholder (SpinningDisc / FilmReel).
// Album and artist rows reuse the library's AlbumCardArt / ArtistCardArt so their
// miss-state placeholders (title letter / artist initials) match everywhere.
function TrackImage({ track, getAlbumImage, getArtistImage }: {
  track: Track;
  getAlbumImage: (title: string, artistName?: string | null) => string | null;
  getArtistImage: (name: string) => string | null;
}) {
  const albumPath = track.album_title ? getAlbumImage(track.album_title, track.artist_name) : null;
  const artistPath = track.artist_name ? getArtistImage(track.artist_name) : null;
  const imagePath = albumPath || artistPath;
  if (imagePath) {
    return <img className="result-img" src={resolveImageUrl(imagePath)} alt="" />;
  }
  return (
    <span className="result-img-fallback">
      <TrackArtFallback track={track} size={18} />
    </span>
  );
}

/**
 * One plugin catalog's rows. A provider starts as a single "Search … on X" offer
 * because the host never queries plugin catalogs on its own (see
 * `PluginSearchAPI`) — activating that row is what runs it, and the results
 * replace it in place.
 *
 * `row.itemIndex` comes from the same walk that built the keyboard's item list,
 * so highlight state is read, never computed here. Display-only rows carry null
 * and are inert.
 */
function PluginSection({
  section,
  query,
  highlightedIndex,
  onActivate,
}: {
  section: PluginSearchSection;
  query: string;
  highlightedIndex: number;
  onActivate: (row: PluginSearchSection["rows"][number]) => void;
}) {
  return (
    <>
      <div className="search-section-header">{section.name}</div>
      {section.rows.map((row) => {
        if (row.kind === "run") {
          return (
            <div
              key={row.key}
              className={`central-search-result ${row.itemIndex === highlightedIndex ? "highlighted" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                onActivate(row);
              }}
            >
              <div className="result-info">
                <div className="result-title">
                  Search “{query}” on {section.name}
                </div>
                <div className="result-subtitle">Not searched yet — this one costs a moment</div>
              </div>
              <span className="result-action">→</span>
            </div>
          );
        }
        if (row.kind === "loading") {
          return (
            <div key={row.key} className="central-search-status">
              <span className="ds-spinner ds-spinner--sm" />
              Searching {section.name}…
            </div>
          );
        }
        if (row.kind === "empty") {
          return (
            <div key={row.key} className="central-search-status">
              No results on {section.name}.
            </div>
          );
        }
        if (row.kind === "error") {
          return (
            <div key={row.key} className="central-search-status">
              {section.name} search failed{row.message ? `: ${row.message}` : "."}
            </div>
          );
        }
        const track = row.track!;
        return (
          <div
            key={row.key}
            className={`central-search-result ${row.itemIndex === highlightedIndex ? "highlighted" : ""}`}
            onMouseDown={(e) => {
              e.preventDefault();
              onActivate(row);
            }}
          >
            <div className="result-art">
              {track.image_url ? (
                <img className="result-img" src={track.image_url} alt="" />
              ) : (
                // First-letter placeholder, same fallback the library rows use
                // when no artwork resolves. A plugin result has no library row
                // to look an image up from, so there's no image chain to run.
                <span className="result-img-fallback">{track.title.charAt(0).toUpperCase()}</span>
              )}
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
        );
      })}
    </>
  );
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
  pluginViews,
  onOpenPluginView,
  pluginSections,
}: CentralSearchDropdownProps) {
  const internalRef = useRef<HTMLInputElement>(null);
  const inputRef = externalInputRef ?? internalRef;
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [placeholder, setPlaceholder] = useState(randomPlaceholder);
  const [focused, setFocused] = useState(false);
  // `items` now spans library rows AND plugin rows, so the library's own count
  // has to come from `results` — an empty library with providers registered
  // still has items (their offer rows).
  const libraryCount = results.tracks.length + results.albums.length + results.artists.length;
  // The library half of this search matched nothing. That used to render an
  // empty box, which reads as "search is broken" — worst for a streaming-only
  // setup, where the library can never match. Say so, then let the plugin
  // sections below offer the catalogs that can.
  const showNoMatches = isOpen && libraryCount === 0 && query.trim() !== "";
  const showDropdown = isOpen && (items.length > 0 || showNoMatches);
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
                      <AlbumCardArt album={album} imagePath={getAlbumImage(album.title, album.artist_name)} />
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
                    <div className="result-art result-art-round">
                      <ArtistCardArt artist={artist} imagePath={getArtistImage(artist.name)} />
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
            {showNoMatches && (
              <div className="central-search-nomatch">
                <div className="central-search-nomatch-text">
                  Nothing in your library matches “{query.trim()}”.
                </div>
                {/* Only offer the plugin *views* when no plugin can be searched
                    from here. A search provider is strictly better — its results
                    land in this dropdown instead of sending the user off to
                    retype the query somewhere else — so when one exists, the
                    sections below are the answer and these buttons would be
                    noise. */}
                {pluginSections.length === 0 && pluginViews.length > 0 && (
                  <>
                    <div className="central-search-nomatch-hint">
                      This searches music on this machine — try one of your sources:
                    </div>
                    <div className="central-search-nomatch-actions">
                      {pluginViews.map((v) => (
                        <button
                          key={`${v.pluginId}:${v.viewId}`}
                          className="ds-btn ds-btn--secondary ds-btn--sm"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            onOpenPluginView(v.pluginId, v.viewId);
                            onClose();
                          }}
                        >
                          {v.label}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
            {pluginSections.map((section) => (
              <PluginSection
                key={section.providerKey}
                section={section}
                query={query.trim()}
                highlightedIndex={highlightedIndex}
                onActivate={(row) =>
                  onResultClick(
                    row.kind === "run"
                      ? { kind: "plugin-run", providerKey: section.providerKey, name: section.name }
                      : { kind: "plugin-track", providerKey: section.providerKey, track: row.track! },
                  )
                }
              />
            ))}
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
