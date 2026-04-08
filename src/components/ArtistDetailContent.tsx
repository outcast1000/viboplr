import { useState } from "react";
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
  onPlayTracks: (tracks: Track[], index: number) => void;
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
  onRefreshInfo: () => void;
  onAlbumContextMenu: (e: React.MouseEvent, albumId: number) => void;
  searchProviders: SearchProviderConfig[];
  artists: Artist[];
  invokeInfoFetch: (pluginId: string, infoTypeId: string, entity: InfoEntity) => Promise<InfoFetchResult>;
}

export function ArtistDetailContent({
  selectedArtist,
  artist,
  artistImagePath,
  artistTrackPopularity,
  sections,
  onToggleSection,
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
  onRefreshInfo,
  onAlbumContextMenu,
  searchProviders,
  artists,
  invokeInfoFetch,
}: ArtistDetailContentProps) {
  const [trackColumns, setTrackColumns] = useState<ColumnConfig[]>(ARTIST_DETAIL_COLUMNS);

  const resolveEntity = (kind: string, name: string) => {
    if (kind === "artist") {
      const match = artists.find(a => a.name.toLowerCase() === name.toLowerCase());
      if (!match) return undefined;
      const imgPath = artistImages[match.id];
      return { id: match.id, imageSrc: imgPath ? convertFileSrc(imgPath) : undefined };
    }
    return undefined;
  };

  return (
    <div className="artist-detail">
      <div className="artist-detail-top">
        <div className="artist-header">
          <div className="artist-avatar">
            {artistImagePath ? (
              <img className="artist-avatar-img" src={convertFileSrc(artistImagePath)} alt={artist?.name} />
            ) : (
              artist ? getInitials(artist.name) : "?"
            )}
          </div>
          <div className="artist-header-info">
            <h2>
              {artist?.name ?? "Unknown"}
              <span
                className={`detail-like-btn${artist?.liked === 1 ? " liked" : ""}`}
                onClick={() => onToggleArtistLike(selectedArtist)}
                title={artist?.liked === 1 ? "Unlike artist" : "Like artist"}
              >{artist?.liked === 1 ? "\u2665" : "\u2661"}</span>
              {sortedTracks.length > 0 && (
                <button
                  className="artist-play-btn"
                  title="Play All"
                  onClick={() => onPlayTracks(sortedTracks.filter(t => t.liked !== -1), 0)}
                >&#9654;</button>
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
                  onRefreshInfo();
                }}
              />
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
        <div className="section-wide">
          <InformationSections
            entity={artist ? { kind: "artist", name: artist.name, id: artist.id } : null}
            exclude={["artist_stats"]}
            invokeInfoFetch={invokeInfoFetch}
            onEntityClick={(kind, id) => {
              if (kind === "artist" && id) onArtistClick(id);
              if (kind === "album" && id) onAlbumClick(id);
            }}
            resolveEntity={resolveEntity}
          />
        </div>
      </div>

      {artistAlbums.length > 0 && (
        <div className="artist-section artist-albums-section">
          <div className="section-title section-header" onClick={() => onToggleSection("albums")}>
            <svg className={`section-chevron${sections.albums === false ? " collapsed" : ""}`} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            Albums
          </div>
          {sections.albums !== false && (
            <div className="album-scroll">
              {artistAlbums.map((a) => (
                <div key={a.id} className="album-card" onClick={() => onAlbumClick(a.id)} onContextMenu={(e) => onAlbumContextMenu(e, a.id)}>
                  <div className="album-card-art-wrapper">
                    <AlbumCardArt album={a} imagePath={albumImages[a.id]} onVisible={onFetchAlbumImage} />
                    <button className="album-card-play-btn" title="Play album" onClick={async (e) => {
                      e.stopPropagation();
                      const albumTracks = await invoke<Track[]>("get_tracks", { opts: { albumId: a.id } });
                      if (albumTracks.length > 0) onPlayTracks(albumTracks, 0);
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
          )}
        </div>
      )}

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
    </div>
  );
}
