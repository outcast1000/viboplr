import type { ReactNode } from "react";
import type { Track, View } from "../types";
import { IconSync } from "./Icons";

interface BreadcrumbProps {
  view: View;
  selectedArtist: number | null;
  selectedAlbum: number | null;
  selectedTag: number | null;
  selectedTrack: number | null;
  tracks: Track[];
  sortedTracks: Track[];
  onPlayAll: (tracks: Track[], startIndex: number) => void;
  onEnqueueAll: (tracks: Track[]) => void;
  syncWithPlaying: boolean;
  onToggleSync: () => void;
  hasPlayingTrack: boolean;
  children?: ReactNode;
}

export function Breadcrumb({
  view, selectedArtist, selectedAlbum, selectedTag, selectedTrack,
  tracks, sortedTracks,
  onPlayAll, onEnqueueAll,
  syncWithPlaying, onToggleSync, hasPlayingTrack,
  children,
}: BreadcrumbProps) {
  const inDetailView = selectedTrack !== null || selectedAlbum !== null || selectedArtist !== null || selectedTag !== null;

  return (
    <div className="breadcrumb">
      {selectedTrack !== null ? (
        <span>Track Details</span>
      ) : selectedAlbum !== null ? (
        <span>Album Details</span>
      ) : selectedArtist !== null ? (
        <span>Artist Details</span>
      ) : selectedTag !== null ? (
        <span>Tag Details</span>
      ) : view === "artists" ? (
        <span>All Artists</span>
      ) : view === "albums" ? (
        <span>All Albums</span>
      ) : view === "tags" ? (
        <span>All Tags</span>
      ) : view === "liked" ? (
        <span>Liked Tracks</span>
      ) : view === "history" ? (
        <span>History</span>
      ) : view === "collections" ? (
        <span>Collections</span>
      ) : (
        <span>All Tracks</span>
      )}
      <div className="breadcrumb-right">
        {inDetailView && hasPlayingTrack && (
          <button
            className={`sync-btn${syncWithPlaying ? " active" : ""}`}
            onClick={onToggleSync}
            title={syncWithPlaying ? "Stop following playback" : "Follow playback"}
          >
            <IconSync size={13} />
          </button>
        )}
        {tracks.length > 0 && selectedTag !== null && (
          <div className="breadcrumb-actions">
            <button className="action-btn" onClick={() => onPlayAll(sortedTracks.filter(t => t.liked !== -1), 0)}>Play All</button>
            <button className="action-btn action-btn-secondary" onClick={() => onEnqueueAll(sortedTracks.filter(t => t.liked !== -1))}>Queue All</button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
