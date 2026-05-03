import { useCallback, useEffect, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { getInitials } from "../utils";
import type { Artist, Album, Track, ColumnConfig, SortField } from "../types";
import type { PlaylistContext } from "../hooks/useQueue";
import type { SearchProviderConfig } from "../searchProviders";
import { ARTIST_DETAIL_COLUMNS } from "../hooks/useLibrary";
import { AlbumCardArt } from "./AlbumCardArt";
import { ImageActions } from "./ImageActions";
import { LikeDislikeButtons } from "./LikeDislikeButtons";
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
  onPlayTracks: (tracks: Track[], index: number, context?: PlaylistContext | null) => void;
  onTrackContextMenu: (e: React.MouseEvent, track: Track, selectedTrackIds: Set<string>) => void;
  onArtistClick: (id: number) => void;
  onAlbumClick: (id: number) => void;
  onSort: (field: SortField) => void;
  sortIndicator: (field: SortField) => string;
  onToggleLike: (track: Track) => void;
  onToggleDislike: (track: Track) => void;
  onTrackDragStart: (tracks: Track[]) => void;
  onDeleteTracks?: (trackIds: number[]) => void;
  onToggleArtistLike: (artistId: number) => void;
  onToggleArtistDislike: (artistId: number) => void;
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
  onToggleArtistDislike,
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
      if (match) return { id: match.id ?? undefined };
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
            {sortedTracks.length > 0 && (
              <button
                className="detail-art-play"
                title="Play All"
                onClick={() => onPlayTracks(sortedTracks.filter(t => t.liked !== -1), 0, { name: artist?.name ?? "Unknown", imagePath: artistImagePath, source: "artist" })}
              >
                <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 6.82v10.36c0 .79.87 1.27 1.54.84l8.14-5.18a1 1 0 0 0 0-1.69L9.54 5.98A.998.998 0 0 0 8 6.82z"/></svg>
              </button>
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
              <LikeDislikeButtons
                liked={artist?.liked ?? 0}
                onToggleLike={() => onToggleArtistLike(selectedArtist)}
                onToggleDislike={() => onToggleArtistDislike(selectedArtist)}
                entityLabel="artist"
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
                        if (albumTracks.length > 0) onPlayTracks(albumTracks, 0, { name: a.title, imagePath: albumImages[a.id] ?? null });
                      }}><svg viewBox="0 0 24 24" width="25" height="25" fill="white" style={{marginLeft: 2}}><path d="M8 6.82v10.36c0 .79.87 1.27 1.54.84l8.14-5.18a1 1 0 0 0 0-1.69L9.54 5.98A.998.998 0 0 0 8 6.82z"/></svg></button>
                    </div>
                    <div className="album-card-body">
                      <div className="album-card-title" title={a.title}>{a.title}</div>
                      <div className="album-card-info">
                        {a.year ? String(a.year) : ""}
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
