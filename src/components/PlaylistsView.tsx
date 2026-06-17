import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { formatDuration } from "../utils";
import { save } from "@tauri-apps/plugin-dialog";
import { DeletePlaylistModal } from "./DeletePlaylistModal";
import type { PluginMenuItem, PluginContextMenuTarget } from "../types/plugin";
import type { PlaylistContext } from "../hooks/useQueue";
import type { QueueTrack } from "../types";
import { nextExternalKey } from "../queueEntry";
import type { ExportTrack } from "./MixtapeExportModal";
import { showNativeMenu, type MenuItemSpec } from "../nativeMenu";
import { DetailHero } from "./DetailHero";
import type { HeroOverflowItem } from "../utils/heroOverflow";
import playlistDefault from "../assets/playlist-default.png";
import { IconHeartFilled, IconThumbsDownFilled, IconRefresh, IconSparkles } from "./Icons";
import { isAuto, isProtectedSystem, playlistRank, parseRecipe, autoRecipeLabel, firstArtist } from "../utils/autoPlaylist";
import { useImageCache } from "../hooks/useImageCache";
import "./PlaylistsView.css";

interface Playlist {
  id: number;
  name: string;
  source: string | null;
  saved_at: number;
  image_path: string | null;
  track_count: number;
  description: string | null;
  metadata: string | null;
  system_kind: string | null;
}

interface PlaylistTrack {
  id: number;
  playlist_id: number;
  position: number;
  title: string;
  artist_name: string | null;
  album_name: string | null;
  duration_secs: number | null;
  source: string | null;
  image_path: string | null;
}

function formatDate(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}


function playlistTrackToMinimalTrack(t: PlaylistTrack): QueueTrack {
  return {
    key: nextExternalKey(),
    path: t.source ?? null,
    title: t.title,
    artist_name: t.artist_name,
    album_title: t.album_name,
    duration_secs: t.duration_secs ?? null,
    format: null,
    image_url: t.image_path ?? undefined,
    liked: 0,
  };
}

interface PlaylistsViewProps {
  searchQuery: string;
  onPlayTracks: (tracks: any[], startIndex: number, context?: PlaylistContext | null) => void;
  onEnqueueTracks: (tracks: any[]) => void;
  onExportAsMixtape?: (tracks: ExportTrack[], defaultTitle?: string, coverPath?: string | null, metadata?: Record<string, string> | null) => void;
  pluginMenuItems?: PluginMenuItem[];
  onPluginAction?: (pluginId: string, actionId: string, target: PluginContextMenuTarget) => void;
}

function isLocalPath(source: string | null): boolean {
  return !!source && source.startsWith("file://");
}

export function PlaylistsView({ searchQuery, onPlayTracks, onEnqueueTracks, onExportAsMixtape, pluginMenuItems, onPluginAction }: PlaylistsViewProps) {
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [selectedPlaylist, setSelectedPlaylist] = useState<Playlist | null>(null);
  const [tracks, setTracks] = useState<PlaylistTrack[]>([]);
  const [deleteConfirm, setDeleteConfirm] = useState<Playlist | null>(null);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [refreshingAuto, setRefreshingAuto] = useState(false);
  const artistImages = useImageCache("artist");

  // Build the queue's PlaylistContext. Auto-playlists ("Made for you") store no
  // image_path, so fall back to the mix's first-artist image — the same raw path
  // autoCoverSrc resolves for the card — otherwise the queue banner cover is blank.
  const playlistContext = useCallback((pl: Playlist): PlaylistContext => {
    const metadata: Record<string, string> | null = pl.metadata ? JSON.parse(pl.metadata) : null;
    let imagePath = pl.image_path;
    if (!imagePath) {
      const artist = firstArtist(pl.metadata);
      imagePath = artist ? artistImages.getImage(artist) : null;
    }
    return {
      name: pl.name,
      imagePath,
      source: pl.source ?? "playlist",
      description: pl.description,
      metadata,
      remote: false,
    };
  }, [artistImages]);

  const loadPlaylists = useCallback(async () => {
    const rows = await invoke<Playlist[]>("get_playlists");
    setPlaylists(rows);
  }, []);

  // Force-regenerate the algorithmic mixes, then reload. The on-mount refresh
  // (24h-gated) lives in App.tsx; this is the user-initiated override.
  const handleRefreshAuto = useCallback(async () => {
    setRefreshingAuto(true);
    try {
      await invoke("ensure_auto_playlists", { force: true });
      await loadPlaylists();
    } catch (e) {
      console.error("Failed to refresh auto playlists:", e);
    } finally {
      setRefreshingAuto(false);
    }
  }, [loadPlaylists]);

  useEffect(() => {
    loadPlaylists();
  }, [loadPlaylists]);

  useEffect(() => {
    const unLikes = listen("entity-likes-changed", () => {
      loadPlaylists().catch(console.error);
      setSelectedPlaylist(prev => {
        if (prev && prev.system_kind) {
          invoke<PlaylistTrack[]>("get_playlist_tracks", { playlistId: prev.id })
            .then(setTracks)
            .catch(console.error);
        }
        return prev;
      });
    });
    // Reload when a playlist is saved/deleted anywhere (queue "Save as Playlist",
    // plugin saves, etc.) so a mounted Playlists view stays current.
    const unPlaylists = listen("playlists-changed", () => {
      loadPlaylists().catch(console.error);
    });
    return () => {
      unLikes.then(f => f()).catch(console.error);
      unPlaylists.then(f => f()).catch(console.error);
    };
  }, [loadPlaylists]);

  const openPlaylist = useCallback(async (pl: Playlist) => {
    setSelectedPlaylist(pl);
    const rows = await invoke<PlaylistTrack[]>("get_playlist_tracks", { playlistId: pl.id });
    setTracks(rows);
  }, []);

  const goBack = useCallback(() => {
    setSelectedPlaylist(null);
    setTracks([]);
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteConfirm) return;
    await invoke("delete_playlist_record", { playlistId: deleteConfirm.id });
    setDeleteConfirm(null);
    setSelectedPlaylist(null);
    setTracks([]);
    loadPlaylists();
  }, [deleteConfirm, loadPlaylists]);

  const handleExport = useCallback(async (pl: Playlist) => {
    const path = await save({
      defaultPath: `${pl.name}.m3u`,
      filters: [{ name: "Playlist", extensions: ["m3u"] }],
    });
    if (path) {
      await invoke("export_playlist_m3u", { playlistId: pl.id, path });
    }
  }, []);

  const handlePlayPlaylist = useCallback(async (e: React.MouseEvent, pl: Playlist) => {
    e.stopPropagation();
    const rows = await invoke<PlaylistTrack[]>("get_playlist_tracks", { playlistId: pl.id });
    if (rows.length > 0) {
      onPlayTracks(rows.map(playlistTrackToMinimalTrack), 0, playlistContext(pl));
    }
  }, [onPlayTracks, playlistContext]);

  const handleEnqueuePlaylist = useCallback(async (pl: Playlist) => {
    const rows = await invoke<PlaylistTrack[]>("get_playlist_tracks", { playlistId: pl.id });
    if (rows.length > 0) {
      onEnqueueTracks(rows.map(playlistTrackToMinimalTrack));
    }
  }, [onEnqueueTracks]);

  const showPlaylistMenu = useCallback(async (x: number, y: number, pl: Playlist) => {
    const specs: MenuItemSpec[] = [
      { kind: "item", text: "Play", action: () => handlePlayPlaylist({ stopPropagation: () => {} } as React.MouseEvent, pl) },
      { kind: "item", text: "Enqueue", action: () => handleEnqueuePlaylist(pl) },
      { kind: "item", text: "View / Edit", action: () => openPlaylist(pl) },
      { kind: "separator" },
      { kind: "item", text: "Export as M3U", action: () => handleExport(pl) },
    ];
    if (onExportAsMixtape) {
      specs.push({ kind: "item", text: "Export as Mixtape", action: async () => {
        try {
          const rows = await invoke<PlaylistTrack[]>("get_playlist_tracks", { playlistId: pl.id });
          if (rows.length === 0) return;
          const meta = pl.metadata ? JSON.parse(pl.metadata) as Record<string, string> : null;
          onExportAsMixtape(rows.map(t => ({
            title: t.title,
            artistName: t.artist_name || undefined,
            albumTitle: t.album_name || undefined,
            durationSecs: t.duration_secs || undefined,
            path: t.source || undefined,
            imageUrl: t.image_path || undefined,
          })), pl.name, pl.image_path, meta);
        } catch (e) {
          console.error("Failed to prepare mixtape export:", e);
        }
      }});
    }
    specs.push({ kind: "separator" });
    if (!isProtectedSystem(pl)) {
      specs.push({ kind: "item", text: "Delete", action: () => setDeleteConfirm(pl) });
    }
    if (pluginMenuItems && pluginMenuItems.length > 0) {
      const matching = pluginMenuItems.filter(item => item.targets.includes("playlist"));
      if (matching.length > 0) {
        specs.push({ kind: "separator" });
        matching.forEach(item => {
          specs.push({ kind: "item", text: item.label, action: () => onPluginAction?.(item.pluginId, item.id, { kind: "playlist", playlistId: pl.id, playlistName: pl.name }) });
        });
      }
    }
    await showNativeMenu(x, y, specs);
  }, [handlePlayPlaylist, handleEnqueuePlaylist, openPlaylist, handleExport, onExportAsMixtape, pluginMenuItems, onPluginAction]);

  const handleContextMenu = useCallback((e: React.MouseEvent, pl: Playlist) => {
    e.preventDefault();
    e.stopPropagation();
    showPlaylistMenu(e.clientX, e.clientY, pl);
  }, [showPlaylistMenu]);

  const handleMoreClick = useCallback((e: React.MouseEvent, pl: Playlist) => {
    e.stopPropagation();
    const rect = (e.target as HTMLElement).getBoundingClientRect();
    showPlaylistMenu(rect.left, rect.bottom + 4, pl);
  }, [showPlaylistMenu]);

  const imageUrl = useCallback(
    (imagePath: string | null) => {
      if (!imagePath) return undefined;
      return convertFileSrc(imagePath);
    },
    [],
  );

  // Auto-playlist covers come from the mix's first artist (recorded in metadata),
  // resolved through the canonical artist-image chain (cached → fetch → ready event).
  const autoCoverSrc = useCallback((pl: Playlist): string => {
    if (pl.image_path) return convertFileSrc(pl.image_path);
    const artist = firstArtist(pl.metadata);
    const resolved = artist ? artistImages.getImage(artist) : null;
    return resolved ? convertFileSrc(resolved) : playlistDefault;
  }, [artistImages]);

  // Resolve artwork for tracks lacking an explicit image_path, using the same
  // name-based chain as the queue: album image by name → artist image by name.
  const [resolvedImages, setResolvedImages] = useState<Record<string, string | null>>({});
  const resolvingRef = useRef<Set<string>>(new Set());

  const trackImageKey = useCallback((t: PlaylistTrack) => `${t.artist_name ?? ""}::${t.album_name ?? ""}::${t.title}`, []);

  const trackImageSrc = useCallback((t: PlaylistTrack): string => {
    if (t.image_path) return convertFileSrc(t.image_path);
    const resolved = resolvedImages[trackImageKey(t)];
    if (resolved) return convertFileSrc(resolved);
    return playlistDefault;
  }, [resolvedImages, trackImageKey]);

  useEffect(() => {
    for (const t of tracks) {
      if (t.image_path) continue;
      const key = trackImageKey(t);
      if (key in resolvedImages || resolvingRef.current.has(key)) continue;
      resolvingRef.current.add(key);
      (async () => {
        try {
          if (t.album_name) {
            const albumPath = await invoke<string | null>("get_entity_image", { kind: "album", name: t.album_name, artistName: t.artist_name ?? null });
            if (albumPath) { setResolvedImages(prev => ({ ...prev, [key]: albumPath })); return; }
          }
          if (t.artist_name) {
            const artistPath = await invoke<string | null>("get_entity_image", { kind: "artist", name: t.artist_name, artistName: null });
            if (artistPath) { setResolvedImages(prev => ({ ...prev, [key]: artistPath })); return; }
          }
          setResolvedImages(prev => ({ ...prev, [key]: null }));
        } catch (e) {
          console.error("Failed to resolve playlist track image:", e);
          setResolvedImages(prev => ({ ...prev, [key]: null }));
        }
      })();
    }
  }, [tracks, resolvedImages, trackImageKey]);

  // Hero background: the playlist cover if set, else a collage of up to 4 distinct
  // resolved track images (same idea as the artist hero's album collage).
  const heroBgImages = useMemo(() => {
    if (selectedPlaylist?.image_path) {
      const u = imageUrl(selectedPlaylist.image_path);
      return u ? [u] : [];
    }
    const out: string[] = [];
    const seen = new Set<string>();
    for (const t of tracks) {
      const path = t.image_path ?? resolvedImages[trackImageKey(t)];
      if (!path || seen.has(path)) continue;
      seen.add(path);
      out.push(convertFileSrc(path));
      if (out.length === 4) break;
    }
    return out;
  }, [selectedPlaylist, tracks, resolvedImages, trackImageKey, imageUrl]);

  // Filter by search query
  const filtered = (searchQuery
    ? playlists.filter((p) => p.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : playlists
  ).slice().sort((a, b) => playlistRank(a) - playlistRank(b));

  const deleteModal = deleteConfirm && (
    <DeletePlaylistModal
      playlistName={deleteConfirm.name}
      onConfirm={handleDeleteConfirm}
      onClose={() => setDeleteConfirm(null)}
    />
  );

  const folderErrorModal = folderError && (
    <div className="ds-modal-overlay">
      <div className="ds-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="ds-modal-title">Open Containing Folder</h2>
        <p className="delete-confirm-warning">{folderError}</p>
        <div className="ds-modal-actions">
          <button className="ds-btn ds-btn--ghost" onClick={() => setFolderError(null)}>OK</button>
        </div>
      </div>
    </div>
  );

  // Detail view
  if (selectedPlaylist) {
    const detailMeta: string[] = [
      `${tracks.length} ${tracks.length === 1 ? "track" : "tracks"}`,
    ];
    if (isAuto(selectedPlaylist)) detailMeta.push(`Updated ${formatDate(selectedPlaylist.saved_at)}`);
    else if (!selectedPlaylist.system_kind) detailMeta.push(`Saved ${formatDate(selectedPlaylist.saved_at)}`);

    const detailOverflowItems: HeroOverflowItem[] = [
      { kind: "action", id: "export-m3u", label: "Export as M3U", onClick: () => handleExport(selectedPlaylist) },
    ];
    if (onExportAsMixtape) {
      detailOverflowItems.push({
        kind: "action", id: "export-mixtape", label: "Export as Mixtape",
        onClick: () => {
          if (tracks.length === 0) return;
          const meta = selectedPlaylist.metadata ? JSON.parse(selectedPlaylist.metadata) as Record<string, string> : null;
          onExportAsMixtape(tracks.map(t => ({
            title: t.title,
            artistName: t.artist_name || undefined,
            albumTitle: t.album_name || undefined,
            durationSecs: t.duration_secs || undefined,
            path: t.source || undefined,
            imageUrl: t.image_path || undefined,
          })), selectedPlaylist.name, selectedPlaylist.image_path, meta);
        },
      });
    }
    if (isAuto(selectedPlaylist)) {
      detailOverflowItems.push({ kind: "divider" });
      detailOverflowItems.push({ kind: "action", id: "refresh", label: "Refresh mixes", onClick: () => handleRefreshAuto() });
    }
    if (!isProtectedSystem(selectedPlaylist)) {
      detailOverflowItems.push({ kind: "divider" });
      detailOverflowItems.push({ kind: "action", id: "delete", label: "Delete playlist", danger: true, onClick: () => setDeleteConfirm(selectedPlaylist) });
    }

    // Cover: the playlist's own image if set, else (for auto mixes) the first
    // artist's image. The latter also seeds the hero background when there are
    // no resolved track images to collage.
    const autoArtist = isAuto(selectedPlaylist) ? firstArtist(selectedPlaylist.metadata) : null;
    const autoArtistImg = autoArtist ? artistImages.getImage(autoArtist) : null;
    const detailArtSrc = selectedPlaylist.image_path
      ? imageUrl(selectedPlaylist.image_path)
      : autoArtistImg ? convertFileSrc(autoArtistImg) : playlistDefault;
    const detailBgImages = heroBgImages.length > 0
      ? heroBgImages
      : autoArtistImg ? [convertFileSrc(autoArtistImg)] : [];

    // Liked / Disliked Songs carry no image_path; give them the same branded
    // gradient + icon cover as their list shortcut instead of the generic disc.
    const detailArt = isProtectedSystem(selectedPlaylist) && !selectedPlaylist.image_path ? (
      <div className={`playlist-hero-system-cover playlist-hero-system-cover--${selectedPlaylist.system_kind}`}>
        {selectedPlaylist.system_kind === "liked"
          ? <IconHeartFilled size={88} />
          : <IconThumbsDownFilled size={88} />}
      </div>
    ) : (
      <img src={detailArtSrc} alt={selectedPlaylist.name} />
    );

    return (
      <div className="playlists-view">
        <DetailHero
          bgImages={detailBgImages}
          onBack={goBack}
          art={detailArt}
          artShape="square"
          eyebrow={isAuto(selectedPlaylist) ? "Made for you" : selectedPlaylist.system_kind ? "System playlist" : "Playlist"}
          title={selectedPlaylist.name}
          entityLabel="album"
          meta={detailMeta}
          onPlay={tracks.length > 0 ? () => onPlayTracks(tracks.map(playlistTrackToMinimalTrack), 0, playlistContext(selectedPlaylist)) : undefined}
          onEnqueue={tracks.length > 0 ? () => onEnqueueTracks(tracks.map(playlistTrackToMinimalTrack)) : undefined}
          overflowItems={detailOverflowItems}
        />
        <div className="playlists-tracks-table">
          <div className="playlists-tracks-header">
            <div className="playlists-col-num">#</div>
            <div className="playlists-col-title">Title</div>
            <div className="playlists-col-album">Album</div>
            <div className="playlists-col-duration">Duration</div>
          </div>
          {tracks.map((t) => (
            <div
              key={t.id}
              className="playlists-track-row"
              onDoubleClick={() => onPlayTracks([playlistTrackToMinimalTrack(t)], 0, selectedPlaylist ? playlistContext(selectedPlaylist) : null)}
              onContextMenu={(e) => {
              e.preventDefault();
              const specs: MenuItemSpec[] = [
                { kind: "item", text: "Play", action: () => onPlayTracks([playlistTrackToMinimalTrack(t)], 0, selectedPlaylist ? playlistContext(selectedPlaylist) : null) },
                { kind: "item", text: "Enqueue", action: () => onEnqueueTracks([playlistTrackToMinimalTrack(t)]) },
              ];
              if (isLocalPath(t.source)) {
                specs.push({ kind: "separator" });
                specs.push({ kind: "item", text: "Open Containing Folder", action: async () => {
                  try { await invoke("show_in_folder_path", { filePath: t.source! }); }
                  catch (err) { console.error("Failed to open containing folder:", err); setFolderError(String(err)); }
                }});
              }
              if (pluginMenuItems && pluginMenuItems.length > 0) {
                const matching = pluginMenuItems.filter(item => item.targets.includes("track"));
                if (matching.length > 0) {
                  specs.push({ kind: "separator" });
                  matching.forEach(item => {
                    specs.push({ kind: "item", text: item.label, action: () => onPluginAction?.(item.pluginId, item.id, { kind: "track", title: t.title, artistName: t.artist_name ?? undefined }) });
                  });
                }
              }
              showNativeMenu(e.clientX, e.clientY, specs);
            }}>
              <div className="playlists-col-num">
                <span className="playlists-track-index">{t.position + 1}</span>
                <button
                  className="playlists-track-play"
                  onClick={() => onPlayTracks([playlistTrackToMinimalTrack(t)], 0, selectedPlaylist ? playlistContext(selectedPlaylist) : null)}
                  title="Play"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 6.82v10.36c0 .79.87 1.27 1.54.84l8.14-5.18a1 1 0 0 0 0-1.69L9.54 5.98A.998.998 0 0 0 8 6.82z"/></svg>
                </button>
              </div>
              <div className="playlists-col-title">
                <img
                  className="playlists-track-thumb"
                  src={trackImageSrc(t)}
                  alt=""
                />
                <div className="playlists-track-text">
                  <span className="playlists-track-name">{t.title}</span>
                  {t.artist_name && <span className="playlists-track-artist">{t.artist_name}</span>}
                </div>
              </div>
              <div className="playlists-col-album">{t.album_name ?? ""}</div>
              <div className="playlists-col-duration">{formatDuration(t.duration_secs)}</div>
            </div>
          ))}
        </div>
        {folderErrorModal}
        {deleteModal}
      </div>
    );
  }

  // List view
  const protectedSystem = filtered.filter(isProtectedSystem);
  const autoPlaylists = filtered.filter(isAuto);
  const regularPlaylists = filtered.filter((p) => !p.system_kind);

  return (
    <div className="playlists-view">
      {filtered.length === 0 ? (
        <div className="playlists-empty">No saved playlists</div>
      ) : (
        <>
          {protectedSystem.length > 0 && (
            <div className="playlist-shortcuts">
              {protectedSystem.map((pl) => (
                <div
                  key={pl.id}
                  className={`playlist-shortcut playlist-shortcut--${pl.system_kind}`}
                  onClick={() => openPlaylist(pl)}
                  onContextMenu={(e) => handleContextMenu(e, pl)}
                >
                  <div className="playlist-shortcut-art">
                    {pl.system_kind === "liked"
                      ? <IconHeartFilled size={26} />
                      : <IconThumbsDownFilled size={26} />}
                  </div>
                  <div className="playlist-shortcut-name">{pl.name}</div>
                  <button className="playlist-shortcut-play" onClick={(e) => handlePlayPlaylist(e, pl)} title="Play">
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 6.82v10.36c0 .79.87 1.27 1.54.84l8.14-5.18a1 1 0 0 0 0-1.69L9.54 5.98A.998.998 0 0 0 8 6.82z"/></svg>
                  </button>
                </div>
              ))}
            </div>
          )}
          {autoPlaylists.length > 0 && (
            <div className="playlists-section">
              <div className="playlists-section-header">
                <h3 className="playlists-section-title">Made for you</h3>
                <button
                  className="ds-btn ds-btn--ghost ds-btn--sm"
                  onClick={handleRefreshAuto}
                  disabled={refreshingAuto}
                  title="Regenerate your mixes"
                >
                  {refreshingAuto ? <span className="ds-spinner ds-spinner--sm" /> : <IconRefresh size={15} />}
                  Refresh
                </button>
              </div>
              <div className="playlists-grid">
                {autoPlaylists.map((pl) => (
                  <div key={pl.id} className="playlist-card" onClick={() => openPlaylist(pl)} onContextMenu={(e) => handleContextMenu(e, pl)}>
                    <div className="playlist-card-art">
                      <img src={autoCoverSrc(pl)} alt="" />
                      <span className="playlist-card-auto-badge" title={autoRecipeLabel(parseRecipe(pl.metadata))}>
                        <IconSparkles size={13} />
                      </span>
                      <button className="playlist-card-more" onClick={(e) => handleMoreClick(e, pl)} title="More options">&#x22EF;</button>
                      <button className="playlist-card-play" onClick={(e) => handlePlayPlaylist(e, pl)} title="Play">
                        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 6.82v10.36c0 .79.87 1.27 1.54.84l8.14-5.18a1 1 0 0 0 0-1.69L9.54 5.98A.998.998 0 0 0 8 6.82z"/></svg>
                      </button>
                    </div>
                    <div className="playlist-card-info">
                      <div className="playlist-card-name">{pl.name}</div>
                    </div>
                    <div className="playlist-card-meta">
                      {`${pl.track_count} tracks · Updated ${formatDate(pl.saved_at)}`}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {regularPlaylists.length > 0 && (
            <div className="playlists-section">
              <div className="playlists-section-header">
                <h3 className="playlists-section-title">Saved playlists</h3>
              </div>
              <div className="playlists-grid">
                {regularPlaylists.map((pl) => (
                  <div key={pl.id} className="playlist-card" onClick={() => openPlaylist(pl)} onContextMenu={(e) => handleContextMenu(e, pl)}>
                    <div className="playlist-card-art">
                      <img src={pl.image_path ? imageUrl(pl.image_path) : playlistDefault} alt="" />
                      <button className="playlist-card-more" onClick={(e) => handleMoreClick(e, pl)} title="More options">&#x22EF;</button>
                      <button className="playlist-card-play" onClick={(e) => handlePlayPlaylist(e, pl)} title="Play">
                        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 6.82v10.36c0 .79.87 1.27 1.54.84l8.14-5.18a1 1 0 0 0 0-1.69L9.54 5.98A.998.998 0 0 0 8 6.82z"/></svg>
                      </button>
                    </div>
                    <div className="playlist-card-info">
                      <div className="playlist-card-name">{pl.name}</div>
                    </div>
                    <div className="playlist-card-meta">
                      {`${pl.track_count} tracks · ${formatDate(pl.saved_at)}`}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
      {deleteModal}
    </div>
  );
}
