import { useCallback, useEffect, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { getInitials } from "../utils";
import type { Artist, Album, Track, ColumnConfig, SortField } from "../types";
import type { SearchProviderConfig } from "../searchProviders";
import { ARTIST_DETAIL_COLUMNS } from "../hooks/useLibrary";
import { AlbumCardArt } from "./AlbumCardArt";
import { ImageActions } from "./ImageActions";
import { TrackList } from "./TrackList";
import { InformationSections } from "./InformationSections";
import { TitleLineInfo } from "./TitleLineInfo";
import type { InfoEntity, InfoFetchResult } from "../types/informationTypes";
import { store } from "../store";

interface ArtistDetailContentProps {
  selectedArtist: number;
  artist: Artist | undefined;
  artistImagePath: string | null;
  artistTrackPopularity: Record<number, number>;
  sections: Record<string, boolean>;
  onToggleSection: (key: string) => void;
  sortedTracks: Track[];
  artistAlbums: Album[];
  artistImages: Record<number, string | null>;
  albumImages: Record<number, string | null>;
  onFetchAlbumImage: (album: Album) => void;
  onSetArtistImage: (images: Record<number, string | null>) => void;
  onForceFetchArtistImage: (entity: { id: number; name: string }) => void;
  currentTrack: Track | null;
  playing: boolean;
  highlightedIndex: number;
  sortField: SortField | null;
  trackListRef: React.RefObject<HTMLDivElement | null>;
  onPlayTracks: (tracks: Track[], index: number, context?: { name: string; coverPath?: string | null; coverUrl?: string | null } | null) => void;
  onTrackContextMenu: (e: React.MouseEvent, track: Track, selectedTrackIds: Set<number>) => void;
  onArtistClick: (id: number) => void;
  onAlbumClick: (id: number) => void;
  onSort: (field: SortField) => void;
  sortIndicator: (field: SortField) => string;
  onToggleLike: (track: Track) => void;
  onToggleDislike: (track: Track) => void;
  onTrackDragStart: (tracks: Track[]) => void;
  onDeleteTracks?: (trackIds: number[]) => void;
  onToggleArtistLike: (artistId: number) => void;
  onToggleArtistHate: (artistId: number) => void;
  onAlbumContextMenu: (e: React.MouseEvent, albumId: number) => void;
  searchProviders: SearchProviderConfig[];
  artists: Artist[];
  invokeInfoFetch: (pluginId: string, infoTypeId: string, entity: InfoEntity, onFetchUrl?: (url: string) => void) => Promise<InfoFetchResult>;
  pluginNames?: Map<string, string>;
  onInfoTrackContextMenu?: (e: React.MouseEvent, trackInfo: { trackId?: number; title: string; artistName: string | null }) => void;
  onEntityContextMenu?: (e: React.MouseEvent, info: { kind: "track" | "artist" | "album"; id?: number; name: string; artistName?: string | null }) => void;
}

export function ArtistDetailContent({
  selectedArtist,
  artist,
  artistImagePath,
  artistTrackPopularity,
  sections: _sections,
  onToggleSection: _onToggleSection,
  sortedTracks,
  artistAlbums,
  artistImages,
  albumImages,
  onFetchAlbumImage,
  onSetArtistImage,
  onForceFetchArtistImage,
  currentTrack,
  playing,
  highlightedIndex,
  sortField,
  trackListRef,
  onPlayTracks,
  onTrackContextMenu,
  onArtistClick,
  onAlbumClick,
  onSort,
  sortIndicator,
  onToggleLike,
  onToggleDislike,
  onTrackDragStart,
  onDeleteTracks,
  onToggleArtistLike,
  onToggleArtistHate,
  onAlbumContextMenu,
  searchProviders,
  artists,
  invokeInfoFetch,
  pluginNames,
  onInfoTrackContextMenu,
  onEntityContextMenu,
}: ArtistDetailContentProps) {
  const [trackColumns, setTrackColumns] = useState<ColumnConfig[]>(ARTIST_DETAIL_COLUMNS);
  const [headerTabOrder, setHeaderTabOrder] = useState<string[]>([]);
  const [belowTabOrder, setBelowTabOrder] = useState<string[]>([]);

  useEffect(() => {
    store.get<string[]>("artistDetailHeaderTabOrder").then(saved => {
      if (saved && saved.length > 0) setHeaderTabOrder(saved);
    });
    store.get<string[]>("artistDetailBelowTabOrder").then(saved => {
      if (saved && saved.length > 0) setBelowTabOrder(saved);
    });
  }, []);

  const handleHeaderTabOrderChange = useCallback((order: string[]) => {
    setHeaderTabOrder(order);
    store.set("artistDetailHeaderTabOrder", order);
  }, []);

  const handleBelowTabOrderChange = useCallback((order: string[]) => {
    setBelowTabOrder(order);
    store.set("artistDetailBelowTabOrder", order);
  }, []);

  const resolveEntity = (kind: string, name: string) => {
    if (kind === "artist") {
      const match = artists.find(a => a.name.toLowerCase() === name.toLowerCase());
      if (!match) return undefined;
      const imgPath = artistImages[match.id];
      return { id: match.id, imageSrc: imgPath ? convertFileSrc(imgPath) : undefined };
    }
    if (kind === "track") {
      // name format: "trackName|||artistName" or just "trackName"
      const [trackName, artistName] = name.includes("|||") ? name.split("|||") : [name, artist?.name];
      const match = sortedTracks.find(t =>
        t.title.toLowerCase() === trackName.toLowerCase() &&
        (!artistName || (t.artist_name ?? "").toLowerCase() === artistName.toLowerCase())
      );
      if (match) return { id: match.id };
    }
    return undefined;
  };

  const handleInfoAction = useCallback((actionId: string, payload?: unknown) => {
    if (actionId === "play-track") {
      const t = payload as Track | undefined;
      if (t) onPlayTracks([t], 0);
    }
  }, [onPlayTracks]);

  return (
    <div className="artist-detail">
      <div
        className="artist-detail-top"
        style={artistImagePath ? { '--artist-bg': `url(${convertFileSrc(artistImagePath)})` } as React.CSSProperties : undefined}
      >
        <div className="artist-header">
          <div className="artist-avatar">
            {artistImagePath ? (
              <img className="artist-avatar-img" src={convertFileSrc(artistImagePath)} alt={artist?.name} />
            ) : (
              artist ? getInitials(artist.name) : "?"
            )}
            <ImageActions
              entityId={selectedArtist}
              entityType="artist"
              entityName={artist?.name}
              imagePath={artistImagePath}
              providers={searchProviders}
              onImageSet={(id, path) => onSetArtistImage({ ...artistImages, [id]: path })}
              onImageRemoved={(id) => {
                onSetArtistImage({ ...artistImages, [id]: null });
              }}
              onRefresh={() => {
                if (!artist) return;
                onForceFetchArtistImage({ id: selectedArtist, name: artist.name });
              }}
            />
          </div>
          <div className="artist-header-info">
            <h2>
              {artist?.name ?? "Unknown"}
              <button
                className={`detail-love-btn${artist?.liked === 1 ? " liked" : ""}`}
                onClick={() => onToggleArtistLike(selectedArtist)}
                title={artist?.liked === 1 ? "Unlike artist" : "Love artist"}
              >
                {artist?.liked === 1
                  ? <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
                  : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>}
              </button>
              <button
                className={`detail-hate-btn${artist?.liked === -1 ? " hated" : ""}`}
                onClick={() => onToggleArtistHate(selectedArtist)}
                title={artist?.liked === -1 ? "Remove hate" : "Hate artist"}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/></svg>
              </button>
              {sortedTracks.length > 0 && (
                <button
                  className="artist-play-btn"
                  title="Play All"
                  onClick={() => onPlayTracks(sortedTracks.filter(t => t.liked !== -1), 0, { name: artist?.name ?? "Unknown", coverPath: artistImagePath })}
                >&#9654;</button>
              )}
            </h2>
            <span className="artist-meta">{artist?.track_count ?? 0} tracks</span>
            <span className="artist-bio-stats">
              <TitleLineInfo
                entity={artist ? { kind: "artist", name: artist.name, id: artist.id } : null}
                invokeInfoFetch={invokeInfoFetch}
              />
            </span>
          </div>
        </div>
      </div>
      <div className="section-wide">
        <InformationSections
          entity={artist ? { kind: "artist", name: artist.name, id: artist.id } : null}
          exclude={["artist_stats"]}
          placement="header"
          customTabs={artistAlbums.length > 0 ? [{
            id: "albums",
            name: "Albums",
            content: (
              <div className="album-scroll">
                {artistAlbums.map((a) => (
                  <div key={a.id} className="album-card" onClick={() => onAlbumClick(a.id)} onContextMenu={(e) => onAlbumContextMenu(e, a.id)}>
                    <div className="album-card-art-wrapper">
                      <AlbumCardArt album={a} imagePath={albumImages[a.id]} onVisible={onFetchAlbumImage} />
                      <button className="album-card-play-btn" title="Play album" onClick={async (e) => {
                        e.stopPropagation();
                        const albumTracks = await invoke<Track[]>("get_tracks", { opts: { albumId: a.id } });
                        if (albumTracks.length > 0) onPlayTracks(albumTracks, 0, { name: a.title, coverPath: albumImages[a.id] ?? null });
                      }}>&#9654;</button>
                    </div>
                    <div className="album-card-body">
                      <div className="album-card-title" title={a.title}>{a.title}</div>
                      <div className="album-card-info">
                        {a.year ? `${a.year} \u00B7 ` : ""}{a.track_count} tracks
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ),
          }] : undefined}
          invokeInfoFetch={invokeInfoFetch}
          pluginNames={pluginNames}
          tabOrder={headerTabOrder}
          onTabOrderChange={handleHeaderTabOrderChange}
          onEntityClick={(kind, id) => {
            if (kind === "artist" && id) onArtistClick(id);
            if (kind === "album" && id) onAlbumClick(id);
          }}
          onAction={handleInfoAction}
          resolveEntity={resolveEntity}
          onTrackContextMenu={onInfoTrackContextMenu}
          onEntityContextMenu={onEntityContextMenu}
        />
      </div>

      <div className="artist-section">
        <div className="section-title">All Tracks</div>
        <TrackList
          tracks={sortedTracks}
          currentTrack={currentTrack}
          playing={playing}
          highlightedIndex={highlightedIndex}
          sortField={sortField}
          trackListRef={trackListRef}
          columns={trackColumns}
          onColumnsChange={setTrackColumns}
          onDoubleClick={onPlayTracks}
          onContextMenu={onTrackContextMenu}
          onArtistClick={onArtistClick}
          onAlbumClick={onAlbumClick}
          onSort={onSort}
          sortIndicator={sortIndicator}
          onToggleLike={onToggleLike}
          onToggleDislike={onToggleDislike}
          onTrackDragStart={onTrackDragStart}
          onDeleteTracks={onDeleteTracks}
          trackPopularity={artistTrackPopularity}
          emptyMessage="No tracks found for this artist."
        />
      </div>

      <div className="section-wide">
        <InformationSections
          entity={artist ? { kind: "artist", name: artist.name, id: artist.id } : null}
          exclude={["artist_stats"]}
          placement="below"
          invokeInfoFetch={invokeInfoFetch}
          pluginNames={pluginNames}
          tabOrder={belowTabOrder}
          onTabOrderChange={handleBelowTabOrderChange}
          onEntityClick={(kind, id) => {
            if (kind === "artist" && id) onArtistClick(id);
            if (kind === "album" && id) onAlbumClick(id);
          }}
          onAction={handleInfoAction}
          resolveEntity={resolveEntity}
          onTrackContextMenu={onInfoTrackContextMenu}
          onEntityContextMenu={onEntityContextMenu}
        />
      </div>
    </div>
  );
}
