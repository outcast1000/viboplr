import type { Artist, Album, Tag, Track, View } from "../types";

interface BreadcrumbProps {
  view: View;
  selectedArtist: number | null;
  selectedAlbum: number | null;
  selectedTag: number | null;
  artists: Artist[];
  albums: Album[];
  tags: Tag[];
  tracks: Track[];
  sortedTracks: Track[];
  onSetSelectedArtist: (id: number | null) => void;
  onSetSelectedAlbum: (id: number | null) => void;
  onSetSelectedTag: (id: number | null) => void;
  onSetView: (view: View) => void;
  onPlayAll: (tracks: Track[], startIndex: number) => void;
  onEnqueueAll: (tracks: Track[]) => void;
}

export function Breadcrumb({
  view, selectedArtist, selectedAlbum, selectedTag,
  artists, albums, tags, tracks, sortedTracks,
  onSetSelectedArtist, onSetSelectedAlbum, onSetSelectedTag,
  onSetView,
  onPlayAll, onEnqueueAll,
}: BreadcrumbProps) {
  return (
    <div className="breadcrumb">
      {view === "artists" && selectedArtist === null ? (
        <span>All Artists</span>
      ) : view === "artists" && selectedArtist !== null && selectedAlbum === null ? (
        <>
          <span className="breadcrumb-link" onClick={() => { onSetSelectedArtist(null); onSetView("artists"); }}>Artists</span>
          <span className="breadcrumb-sep"> {"\u203A"} </span>
          <span>{artists.find(a => a.id === selectedArtist)?.name ?? "Unknown"}</span>
        </>
      ) : view === "albums" && selectedAlbum === null ? (
        <span>All Albums</span>
      ) : selectedArtist !== null && selectedAlbum !== null ? (
        <>
          <span className="breadcrumb-link" onClick={() => { onSetSelectedArtist(null); onSetSelectedAlbum(null); onSetView("artists"); }}>Artists</span>
          <span className="breadcrumb-sep"> {"\u203A"} </span>
          <span className="breadcrumb-link" onClick={() => { onSetSelectedAlbum(null); onSetView("artists"); }}>{artists.find(a => a.id === selectedArtist)?.name ?? "Unknown"}</span>
          <span className="breadcrumb-sep"> {"\u203A"} </span>
          <span>{albums.find(a => a.id === selectedAlbum)?.title ?? "Album"}</span>
        </>
      ) : view === "tags" && selectedTag === null ? (
        <span>All Tags</span>
      ) : selectedTag !== null ? (
        <>
          <span className="breadcrumb-link" onClick={() => { onSetSelectedTag(null); onSetView("tags"); }}>Tags</span>
          <span className="breadcrumb-sep"> {"\u203A"} </span>
          <span>{tags.find(t => t.id === selectedTag)?.name ?? "Tag"}</span>
        </>
      ) : selectedAlbum !== null ? (
        <>
          <span className="breadcrumb-link" onClick={() => { onSetSelectedAlbum(null); onSetView("albums"); }}>Albums</span>
          <span className="breadcrumb-sep"> {"\u203A"} </span>
          <span>{albums.find(a => a.id === selectedAlbum)?.title ?? "Album"}</span>
        </>
      ) : view === "liked" ? (
        <span>Liked Tracks</span>
      ) : view === "history" ? (
        <span>History</span>
      ) : view === "collections" ? (
        <span>Collections</span>
      ) : view === "tidal" ? (
        <span>TIDAL</span>
      ) : (
        <span>All Tracks</span>
      )}
      {tracks.length > 0 && (selectedTag !== null || (view === "artists" && selectedArtist !== null)) && (
        <div className="breadcrumb-actions">
          <button className="action-btn" onClick={() => onPlayAll(sortedTracks.filter(t => t.liked !== -1), 0)}>Play All</button>
          <button className="action-btn action-btn-secondary" onClick={() => onEnqueueAll(sortedTracks.filter(t => t.liked !== -1))}>Queue All</button>
        </div>
      )}
    </div>
  );
}
