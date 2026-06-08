import { useRef, useEffect } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Track, Album, Artist, SearchAllResults, SearchResultItem } from "../types";
import "./MiniSearchPanel.css";

interface MiniSearchPanelProps {
  query: string;
  onQueryChange: (q: string) => void;
  results: SearchAllResults;
  items: SearchResultItem[];
  highlightedIndex: number;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onResultClick: (item: SearchResultItem, enqueue: boolean) => void;
  getAlbumImage: (title: string, artistName?: string | null) => string | null;
  getArtistImage: (name: string) => string | null;
}

function ArtistImg({ artist, getArtistImage }: { artist: Artist; getArtistImage: (n: string) => string | null }) {
  const p = getArtistImage(artist.name);
  if (p) return <img className="mini-result-img mini-result-img-round" src={convertFileSrc(p)} alt="" />;
  return <span className="mini-result-img-fallback mini-result-img-round">{(artist.name[0] ?? "?").toUpperCase()}</span>;
}

function AlbumImg({ album, getAlbumImage, getArtistImage }: {
  album: Album; getAlbumImage: (t: string, a?: string | null) => string | null; getArtistImage: (n: string) => string | null;
}) {
  const p = getAlbumImage(album.title, album.artist_name) || (album.artist_name ? getArtistImage(album.artist_name) : null);
  if (p) return <img className="mini-result-img" src={convertFileSrc(p)} alt="" />;
  return <span className="mini-result-img-fallback">{(album.title[0] ?? "?").toUpperCase()}</span>;
}

function TrackImg({ track, getAlbumImage, getArtistImage }: {
  track: Track; getAlbumImage: (t: string, a?: string | null) => string | null; getArtistImage: (n: string) => string | null;
}) {
  const p = (track.album_title ? getAlbumImage(track.album_title, track.artist_name) : null)
    || (track.artist_name ? getArtistImage(track.artist_name) : null);
  if (p) return <img className="mini-result-img" src={convertFileSrc(p)} alt="" />;
  return <span className="mini-result-img-fallback">{(track.title[0] ?? "?").toUpperCase()}</span>;
}

export function MiniSearchPanel({
  query, onQueryChange, results, items, highlightedIndex,
  onKeyDown, onResultClick, getAlbumImage, getArtistImage,
}: MiniSearchPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Focus the input as soon as the panel mounts, and place the cursor at the end
  // of the seeded first character.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    const len = el.value.length;
    el.setSelectionRange(len, len);
  }, []);

  useEffect(() => {
    if (highlightedIndex < 0 || !listRef.current) return;
    const el = listRef.current.querySelector(".mini-result.highlighted") as HTMLElement | null;
    el?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex]);

  // Item ordering matches useMiniSearch.items: tracks, then albums, then artists.
  const trackOffset = 0;
  const albumOffset = results.tracks.length;
  const artistOffset = results.tracks.length + results.albums.length;
  const hasResults = items.length > 0;

  return (
    <div className="mini-search-panel" onMouseDown={(e) => e.stopPropagation()}>
      <div className="mini-search-input-wrapper">
        <svg className="mini-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          ref={inputRef}
          type="text"
          placeholder="Search…"
          autoComplete="off" autoCorrect="off" spellCheck={false}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>

      <div className="mini-search-results" ref={listRef}>
        {results.tracks.length > 0 && <div className="mini-search-section">Tracks</div>}
        {results.tracks.map((track, i) => (
          <div
            key={`t-${track.id}`}
            className={`mini-result ${trackOffset + i === highlightedIndex ? "highlighted" : ""}`}
            onMouseDown={(e) => { e.preventDefault(); onResultClick({ kind: "track", data: track }, e.metaKey || e.ctrlKey); }}
          >
            <div className="mini-result-art"><TrackImg track={track} getAlbumImage={getAlbumImage} getArtistImage={getArtistImage} /></div>
            <div className="mini-result-info">
              <div className="mini-result-title">{track.title}</div>
              <div className="mini-result-subtitle">{track.artist_name}{track.artist_name && track.album_title ? " · " : ""}{track.album_title}</div>
            </div>
          </div>
        ))}

        {results.albums.length > 0 && <div className="mini-search-section">Albums</div>}
        {results.albums.map((album, i) => (
          <div
            key={`al-${album.id}`}
            className={`mini-result ${albumOffset + i === highlightedIndex ? "highlighted" : ""}`}
            onMouseDown={(e) => { e.preventDefault(); onResultClick({ kind: "album", data: album }, e.metaKey || e.ctrlKey); }}
          >
            <div className="mini-result-art"><AlbumImg album={album} getAlbumImage={getAlbumImage} getArtistImage={getArtistImage} /></div>
            <div className="mini-result-info">
              <div className="mini-result-title">{album.title}</div>
              <div className="mini-result-subtitle">{album.artist_name}{album.artist_name && album.year ? " · " : ""}{album.year ?? ""}</div>
            </div>
          </div>
        ))}

        {results.artists.length > 0 && <div className="mini-search-section">Artists</div>}
        {results.artists.map((artist, i) => (
          <div
            key={`ar-${artist.id}`}
            className={`mini-result ${artistOffset + i === highlightedIndex ? "highlighted" : ""}`}
            onMouseDown={(e) => { e.preventDefault(); onResultClick({ kind: "artist", data: artist }, e.metaKey || e.ctrlKey); }}
          >
            <div className="mini-result-art"><ArtistImg artist={artist} getArtistImage={getArtistImage} /></div>
            <div className="mini-result-info">
              <div className="mini-result-title">{artist.name}</div>
              <div className="mini-result-subtitle">Artist · {artist.track_count} tracks</div>
            </div>
          </div>
        ))}

        {query.trim() && !hasResults && <div className="mini-search-empty">No results</div>}
      </div>
    </div>
  );
}
