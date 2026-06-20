// Context-menu spec builder, extracted from App.tsx.
// Pure: given a context-menu target and the app dependencies it needs, returns
// the MenuItemSpec[] to display (or null when there's nothing to show). App.tsx
// keeps a thin useCallback wrapper that owns setContextMenu + showNativeMenu.
import type { MenuItemSpec } from "../nativeMenu";
import type { ContextMenuTarget } from "../types/contextMenu";
import { toPluginTarget } from "../types/contextMenu";
import { buildPluginMenuSpecs } from "./pluginMenuGroups";
import { parseLibraryId, isLocalTrack } from "../queueEntry";
import type { useContextMenuActions } from "../hooks/useContextMenuActions";
import type { useLibrary } from "../hooks/useLibrary";
import type { usePlugins } from "../hooks/usePlugins";
import type { useQueue } from "../hooks/useQueue";
import type { useVideoLayout } from "../hooks/useVideoLayout";
import type { useImageCache } from "../hooks/useImageCache";

export interface ContextMenuDeps {
  contextMenuActions: ReturnType<typeof useContextMenuActions>;
  videoLayout: ReturnType<typeof useVideoLayout>;
  queueHook: ReturnType<typeof useQueue>;
  library: ReturnType<typeof useLibrary>;
  downloadProviderEntries: { id: string; name: string; interactive: boolean }[];
  plugins: ReturnType<typeof usePlugins>;
  handleDownloadFromProvider: (providerId: string, interactive: boolean) => void;
  artistImageCache: ReturnType<typeof useImageCache>;
  albumImageCache: ReturnType<typeof useImageCache>;
  tagImageCache: ReturnType<typeof useImageCache>;
  /** Opens the centered Retrieve modal (preview → Apply) for the Refresh Image action. */
  beginRetrieveImage: (kind: "artist" | "album" | "tag", name: string, artistName?: string | null) => void;
  setSearchInitialQuery: (q: string | null) => void;
  setSearchQueryKey: (fn: (k: number) => number) => void;
  setDeleteTagConfirm: (tags: { id: number; name: string }[] | null) => void;
  trashLabel: string;
  handleExportAsMixtapeRef: React.MutableRefObject<((trackIds: number[], defaultTitle?: string) => void) | null>;
}

/** Build the native context-menu specs for a target. Returns null if empty. */
export function buildContextMenuSpecs(target: ContextMenuTarget, d: ContextMenuDeps): MenuItemSpec[] | null {
    const specs: MenuItemSpec[] = [];

    if (target.kind === "video") {
      (["contain", "fit-width", "fit-height", "fill"] as const).forEach(mode => {
        specs.push({ kind: "check", text: mode === "contain" ? "Contain" : mode === "fit-width" ? "Fit Width" : mode === "fit-height" ? "Fit Height" : "Fill", checked: target.fitMode === mode, action: () => d.videoLayout.setFitMode(mode) });
      });
      specs.push({ kind: "separator" });
      (["top", "bottom", "left", "right"] as const).forEach(side => {
        specs.push({ kind: "check", text: side[0].toUpperCase() + side.slice(1), checked: target.dockSide === side, action: () => d.videoLayout.setDockSide(side) });
      });
    } else if (target.kind === "queue-multi") {
      const count = target.indices.length;
      const selectedTracks = target.indices.map(i => d.queueHook.queue[i]).filter(Boolean);

      // Queue operations — always available
      if (d.contextMenuActions.handleQueueRemove) {
        specs.push({ kind: "item", text: count > 1 ? `Remove ${count} tracks` : "Remove", action: d.contextMenuActions.handleQueueRemove });
      }
      if (d.contextMenuActions.handleQueueKeepOnly) {
        specs.push({ kind: "item", text: count > 1 ? `Keep only ${count} tracks` : "Keep only", action: d.contextMenuActions.handleQueueKeepOnly });
      }
      if (d.contextMenuActions.handleQueueMoveToTop) {
        specs.push({ kind: "item", text: "Move to top", action: d.contextMenuActions.handleQueueMoveToTop });
      }
      if (d.contextMenuActions.handleQueueMoveToBottom) {
        specs.push({ kind: "item", text: "Move to bottom", action: d.contextMenuActions.handleQueueMoveToBottom });
      }

      // Single-track actions
      if (count === 1) {
        if (target.firstTrack.isLocal) {
          specs.push({ kind: "separator" });
          specs.push({ kind: "item", text: "Open Containing Folder", action: d.contextMenuActions.handleShowInFolder });
        }
        const locateTrack = () => {
          const track = d.queueHook.queue[target.indices[0]];
          if (track) {
            d.library.handleLocateTrack(track.title, track.artist_name, track.album_title, () => {
              d.setSearchInitialQuery(track.title);
              d.setSearchQueryKey(k => k + 1);
              d.library.setView("search");
              d.library.setSelectedArtist(null);
              d.library.setSelectedAlbum(null);
              d.library.setSelectedTag(null);
            });
          }
        };
        specs.push({ kind: "item", text: "Details", action: locateTrack });

        // Find in YouTube — works by metadata, any track type
        specs.push({ kind: "item", text: "Find in YouTube", action: () => {
          const track = d.queueHook.queue[target.indices[0]];
          if (track) {
            d.contextMenuActions.watchOnYoutube(track.title, track.artist_name, track.duration_secs ?? null);
          }
        }});

        // Start radio from this track (single track only)
        specs.push({ kind: "item", text: "Start radio from this track", action: () => {
          const track = d.queueHook.queue[target.indices[0]];
          if (track) {
            d.contextMenuActions.startRadio({
              title: track.title,
              artistName: track.artist_name,
              coverPath: track.image_url ?? null,
            });
          }
        }});

        // View Details — needs d.library ID
        if (target.trackIds[0] != null) {
          specs.push({ kind: "item", text: "View Details", action: () => d.library.handleTrackClick(`lib:${target.trackIds[0]}`) });
        }
      }

      // Move to Trash — local tracks only
      if (d.contextMenuActions.handleDeleteRequest) {
        const localDeletable = selectedTracks.filter(t => isLocalTrack(t) && parseLibraryId(t.key) != null);
        if (localDeletable.length > 0) {
          specs.push({ kind: "separator" });
          const deleteLabel = localDeletable.length === 1 ? `Move to ${d.trashLabel}` : `Move ${localDeletable.length} local tracks to ${d.trashLabel}`;
          specs.push({ kind: "item", text: deleteLabel, action: d.contextMenuActions.handleDeleteRequest });
        }
      }

      // Download — non-local tracks only
      if (d.downloadProviderEntries.length > 0) {
        const downloadable = selectedTracks.filter(t => !isLocalTrack(t));
        if (downloadable.length > 0) {
          const dlItems: MenuItemSpec[] = [];
          dlItems.push({ kind: "item", text: "Download (auto)", action: () => {
            if (downloadable.length === 1) d.contextMenuActions.handleDownloadTrack(downloadable[0]);
            else d.contextMenuActions.handleDownloadMulti(downloadable);
          }});
          d.downloadProviderEntries.forEach(entry => {
            dlItems.push({ kind: "item", text: `Download from ${entry.name}${entry.interactive ? "..." : ""}`, action: () => d.handleDownloadFromProvider(entry.id, entry.interactive) });
          });
          specs.push({ kind: "separator" });
          const dlLabel = downloadable.length === 1 ? "Download" : `Download ${downloadable.length} tracks`;
          specs.push({ kind: "submenu", text: dlLabel, items: dlItems });
        }
      }

      // Plugin actions
      const pluginTargetKind = count === 1 ? "track" : "multi-track";
      const matching = d.plugins.menuItems.filter(item => item.targets.includes(pluginTargetKind as "track" | "multi-track"));
      const pluginSpecs = buildPluginMenuSpecs(matching, toPluginTarget(target), d.plugins.dispatchContextMenuAction);
      if (pluginSpecs.length > 0) {
        specs.push({ kind: "separator" });
        specs.push(...pluginSpecs);
      }
    } else if (target.kind === "multi-album" || target.kind === "multi-artist" || target.kind === "multi-tag") {
      const count = target.kind === "multi-album" ? target.albumIds.length
                  : target.kind === "multi-artist" ? target.artistIds.length
                  : target.tagIds.length;
      const label = target.kind === "multi-album" ? "albums" : target.kind === "multi-artist" ? "artists" : "tags";
      specs.push({ kind: "item", text: `Play ${count} ${label}`, action: d.contextMenuActions.handleContextPlay });
      specs.push({ kind: "item", text: `Enqueue ${count} ${label}`, action: d.contextMenuActions.handleContextEnqueue });
      if (target.kind === "multi-tag") {
        const tagsToDelete = target.tagIds.map(id => {
          const tag = d.library.tags.find(t => t.id === id);
          return { id, name: tag?.name ?? "Unknown" };
        });
        specs.push({ kind: "separator" });
        specs.push({ kind: "item", text: `Delete ${count} tags`, action: () => {
          d.setDeleteTagConfirm(tagsToDelete);
        }});
      }
    } else {
      const isMulti = target.kind === "multi-track";
      const hasId = target.kind === "artist" ? !!target.artistId
                  : target.kind === "album" ? !!target.albumId
                  : target.kind === "track" ? !!target.trackId
                  : target.kind === "tag" ? !!target.tagId
                  : true;

      if (hasId) {
        specs.push({ kind: "item", text: isMulti ? `Play ${target.trackIds.length} tracks` : "Play", action: d.contextMenuActions.handleContextPlay });
        specs.push({ kind: "item", text: isMulti ? `Enqueue ${target.trackIds.length} tracks` : "Enqueue", action: d.contextMenuActions.handleContextEnqueue });
      }
      if (hasId && (target.kind === "artist" || target.kind === "album" || target.kind === "tag")) {
        const refreshAction = target.kind === "artist"
          ? () => d.beginRetrieveImage("artist", target.name)
          : target.kind === "album"
          ? () => d.beginRetrieveImage("album", target.title, target.artistName)
          : target.kind === "tag"
          ? () => d.beginRetrieveImage("tag", target.name)
          : null;
        if (refreshAction) {
          specs.push({ kind: "item", text: "Retrieve Image", action: refreshAction });
        }
      }
      if (d.contextMenuActions.handleBulkEdit && (isMulti || (target.kind === "track" && target.trackId))) {
        specs.push({ kind: "item", text: "Edit Properties", action: d.contextMenuActions.handleBulkEdit });
      }
      if (target.kind === "track" && target.isLocal) {
        specs.push({ kind: "item", text: "Open Containing Folder", action: d.contextMenuActions.handleShowInFolder });
      }
      if (target.kind === "track" && target.trackId && d.contextMenuActions.handleWatchOnYoutube) {
        specs.push({ kind: "item", text: "Find in YouTube", action: d.contextMenuActions.handleWatchOnYoutube });
      }
      if (target.kind === "track" && target.title) {
        specs.push({ kind: "item", text: "Start radio from this track", action: () => {
          if (target.kind !== "track") return;
          d.contextMenuActions.startRadio({
            title: target.title,
            artistName: target.artistName,
            coverPath: null,
          });
        }});
      }
      if (target.kind === "track" && target.trackId) {
        specs.push({ kind: "item", text: "View Details", action: () => d.library.handleTrackClick(`lib:${target.trackId}`) });
      }
      if (d.contextMenuActions.handleDeleteRequest && (target.kind === "track" && target.isLocal || target.kind === "multi-track")) {
        if (target.kind === "track") {
          specs.push({ kind: "separator" });
          specs.push({ kind: "item", text: `Move to ${d.trashLabel}`, action: d.contextMenuActions.handleDeleteRequest });
        } else {
          const localCount = d.library.tracks.filter(t => target.trackIds.includes(t.id!) && isLocalTrack(t)).length;
          if (localCount > 0) {
            specs.push({ kind: "separator" });
            specs.push({ kind: "item", text: `Move ${localCount} local track${localCount > 1 ? "s" : ""} to ${d.trashLabel}`, action: d.contextMenuActions.handleDeleteRequest });
          }
        }
      }
      if (target.kind === "track" && !target.isLocal && d.downloadProviderEntries.length > 0) {
        const dlItems: MenuItemSpec[] = [];
        dlItems.push({ kind: "item", text: "Download (auto)", action: () => {
          if (target.trackId) {
            const track = d.library.tracks.find(tr => tr.id === target.trackId);
            if (track) d.contextMenuActions.handleDownloadTrack(track);
          }
        }});
        d.downloadProviderEntries.forEach(entry => {
          dlItems.push({ kind: "item", text: `Download from ${entry.name}${entry.interactive ? "..." : ""}`, action: () => d.handleDownloadFromProvider(entry.id, entry.interactive) });
        });
        specs.push({ kind: "separator" });
        specs.push({ kind: "submenu", text: "Download", items: dlItems });
      }
      if (target.kind === "album" && target.albumId && d.downloadProviderEntries.length > 0) {
        specs.push({ kind: "separator" });
        specs.push({ kind: "item", text: "Download Album", action: () => {
          const albumTracks = d.library.tracks.filter(tr => tr.album_id === target.albumId);
          if (albumTracks.length) d.contextMenuActions.handleDownloadMulti(albumTracks);
        }});
      }
      if (isMulti && d.downloadProviderEntries.length > 0) {
        const dlItems: MenuItemSpec[] = [];
        dlItems.push({ kind: "item", text: "Download (auto)", action: () => {
          const idSet = new Set(target.trackIds);
          const selected = d.library.tracks.filter(tr => tr.id != null && idSet.has(tr.id));
          d.contextMenuActions.handleDownloadMulti(selected);
        }});
        d.downloadProviderEntries.forEach(entry => {
          dlItems.push({ kind: "item", text: `Download from ${entry.name}${entry.interactive ? "..." : ""}`, action: () => d.handleDownloadFromProvider(entry.id, entry.interactive) });
        });
        specs.push({ kind: "separator" });
        specs.push({ kind: "submenu", text: `Download ${target.trackIds.length} tracks`, items: dlItems });
      }
      const targetKind = target.kind as string;
      const matching = d.plugins.menuItems.filter(item => item.targets.includes(targetKind as "track" | "album" | "artist" | "multi-track"));
      const pluginSpecs = buildPluginMenuSpecs(matching, toPluginTarget(target), d.plugins.dispatchContextMenuAction);
      if (pluginSpecs.length > 0) {
        specs.push({ kind: "separator" });
        specs.push(...pluginSpecs);
      }
      if (isMulti && d.handleExportAsMixtapeRef.current) {
        specs.push({ kind: "separator" });
        specs.push({ kind: "item", text: "Export as Mixtape", action: () => d.handleExportAsMixtapeRef.current?.(target.trackIds) });
      }
      if (target.kind === "tag" && target.tagId) {
        specs.push({ kind: "separator" });
        specs.push({ kind: "item", text: "Delete Tag", action: () => {
          d.setDeleteTagConfirm([{ id: target.tagId, name: target.name }]);
        }});
      }
    }

  return specs.length === 0 ? null : specs;
}
