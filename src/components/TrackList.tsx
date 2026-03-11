import type { Track, SortField } from "../types";
import { isVideoTrack, formatDuration } from "../utils";

interface TrackListProps {
  tracks: Track[];
  currentTrack: Track | null;
  highlightedIndex: number;
  sortField: SortField | null;
  trackListRef: React.RefObject<HTMLDivElement | null>;
  onDoubleClick: (tracks: Track[], index: number) => void;
  onContextMenu: (e: React.MouseEvent, track: Track) => void;
  onArtistClick: (artistId: number) => void;
  onAlbumClick: (albumId: number) => void;
  onSort: (field: SortField) => void;
  sortIndicator: (field: SortField) => string;
  emptyMessage?: string;
}

export function TrackList({
  tracks, currentTrack, highlightedIndex,
  sortField, trackListRef,
  onDoubleClick, onContextMenu, onArtistClick, onAlbumClick,
  onSort, sortIndicator,
  emptyMessage = "No tracks found.",
}: TrackListProps) {
  return (
    <div className="track-list" ref={trackListRef}>
      <div className="track-header">
        <span className={`col-num sortable ${sortField === "num" ? "sorted" : ""}`} onClick={() => onSort("num")}>{`#${sortIndicator("num")}`}</span>
        <span className={`col-title sortable ${sortField === "title" ? "sorted" : ""}`} onClick={() => onSort("title")}>{`Title${sortIndicator("title")}`}</span>
        <span className={`col-artist sortable ${sortField === "artist" ? "sorted" : ""}`} onClick={() => onSort("artist")}>{`Artist${sortIndicator("artist")}`}</span>
        <span className={`col-album sortable ${sortField === "album" ? "sorted" : ""}`} onClick={() => onSort("album")}>{`Album${sortIndicator("album")}`}</span>
        <span className={`col-duration sortable ${sortField === "duration" ? "sorted" : ""}`} onClick={() => onSort("duration")}>{`Duration${sortIndicator("duration")}`}</span>
      </div>
      {tracks.map((t, i) => (
        <div
          key={t.id}
          className={`track-row ${currentTrack?.id === t.id ? "playing" : ""} ${highlightedIndex === i ? "highlighted" : ""}`}
          onDoubleClick={() => onDoubleClick(tracks, i)}
          onContextMenu={(e) => onContextMenu(e, t)}
        >
          <span className="col-num">
            {isVideoTrack(t) ? "\uD83C\uDFAC" : (t.track_number || i + 1)}
          </span>
          <span className="col-title">{t.title}</span>
          <span className="col-artist">
            {t.artist_id ? (
              <span className="track-link" onClick={(e) => { e.stopPropagation(); onArtistClick(t.artist_id!); }}>{t.artist_name || "Unknown"}</span>
            ) : (t.artist_name || "Unknown")}
          </span>
          <span className="col-album">
            {t.album_id ? (
              <span className="track-link" onClick={(e) => { e.stopPropagation(); onAlbumClick(t.album_id!); }}>{t.album_title || "Unknown"}</span>
            ) : (t.album_title || "Unknown")}
          </span>
          <span className="col-duration">{formatDuration(t.duration_secs)}</span>
        </div>
      ))}
      {tracks.length === 0 && (
        <div className="empty">{emptyMessage}</div>
      )}
    </div>
  );
}
