// Frontend dispatcher for the localhost control API (src-tauri/src/control_api.rs).
//
// The Rust server bridges every verb it can't answer from the DB into the
// webview as a `control-api-request` event; this hook runs the matching
// canonical action (useQueue / usePlayback / useLikeActions / useTagActions)
// and replies via `control_api_respond`. Every handler answers — success or
// error — so the HTTP caller never waits out the server's 10s timeout on a
// thrown handler. Validation/serialization logic is pure and lives in
// utils/controlApi.ts; this file is only the wiring.
//
// Feedback rule: API-driven mutations raise no toasts — the "user" here is the
// HTTP caller, and failures return in the response body (conventions.md "User
// Feedback" applies to the requester, which is not the person at the screen).

import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { appErrorEntries } from "../utils/errorLog";
import { resolverLogEntries } from "../utils/resolverLog";
import { pluginLogEntries } from "../utils/pluginLog";
import { notificationLogEntries } from "../utils/notificationLog";
import { scrubPaths } from "../utils/diagnosticReport";
import { subscribe } from "../utils/tauriEvents";
import { useAssignRef, useLatestRef } from "./useLatestRef";
import type { QueueTrack, QueueMode, Track } from "../types";
import type { PlaylistContext } from "./useQueue";
import type {
  PluginState, ExtensionUpdate, PluginSearchProvider, PluginSearchResult,
  PluginMenuItem, PluginContextMenuTarget, PluginTargetKind, PluginTrack,
  HomeShelfDisplayKind, HomeShelfItem, HomeShelfResult,
} from "../types/plugin";
import type { SkinInfo } from "../types/skin";
import type { InfoEntity } from "../types/informationTypes";
import { buildEntityKey } from "../types/informationTypes";
import { cacheTtlForRow, decideCacheAction, fetchInfoThroughChain, type InvokeInfoFetch } from "../utils/infoFetchChain";
import { resolveShelfPlayAction } from "../utils/homeShelfPlay";
import { getPlaybackPosition } from "../playback/positionStore";
import { applyTag, removeTag } from "./useTagActions";
import { sameSong } from "./useLikeActions";
import { trackToQueueTrack, playlistTrackToQueueTrack, pluginTrackToQueueTrack, nextQueueKey, type PlaylistTrackRow } from "../queueEntry";
import { fetchLikeStates, applyLikeStates } from "../utils/likeReconcile";
import { toPlaylistTrackPayload } from "../utils/playlistPayload";
import { errorText } from "../utils/errorKind";
import {
  parseControlRequest,
  parsePlaybackSet,
  parseLikeState,
  resolveSkin,
  resolveSearchProvider,
  selectSearchTracks,
  resolveHomeShelf,
  serializeShelfItem,
  decidePlayPause,
  validateIndices,
  asNumberArray,
  asStringArray,
  orderTracksByIds,
  partitionEnqueue,
  serializeQueue,
  serializeStatus,
  type ControlApiRequest,
} from "../utils/controlApi";

export interface ControlApiDeps {
  appRestoring: boolean;
  view: string;
  queueHook: {
    queue: QueueTrack[];
    queueIndex: number;
    queueMode: QueueMode;
    setQueueMode: (mode: QueueMode) => void;
    setQueueIndex: (index: number) => void;
    playTracks: (tracks: QueueTrack[], startIndex: number, context?: PlaylistContext | null) => number;
    enqueueTracks: (tracks: QueueTrack[]) => void;
    findDuplicates: (tracks: QueueTrack[]) => { duplicates: QueueTrack[]; unique: QueueTrack[] };
    insertAtPosition: (tracks: QueueTrack[], position: number) => void;
    removeMultiple: (indices: number[]) => void;
    clearQueue: () => void;
    randomizeQueue: () => void;
  };
  playback: {
    playing: boolean;
    durationSecs: number | null;
    volume: number;
    muted: boolean;
    currentTrack: QueueTrack | null;
    handlePause: () => void;
    handleStop: () => void;
    handleSeek: (secs: number) => void;
    handleVolume: (level: number) => void;
    handlePlay: (track: QueueTrack, source?: "user" | "auto") => void;
  };
  /** App's handleNext — the same path the media keys take, so `next` at the
   *  end of the queue gets auto-continue instead of silently stopping. */
  next: () => void;
  previous: () => void;
  /** usePlayActions.startRadio — resolves with the station's track count,
   *  or null when nothing started. */
  startRadio: (seed: { title: string; artistName: string | null; coverPath: string | null }) => Promise<number | null>;
  /** usePlayActions.playWithBackfill — play the known head now, append the
   *  resolved tail behind the music (generation-guarded). */
  playWithBackfill: (opts: {
    head: QueueTrack[];
    context?: PlaylistContext | null;
    resolveTail: () => Promise<QueueTrack[]>;
    tailErrorMessage?: string;
  }) => Promise<QueueTrack[]>;
  plugins: {
    pluginStates: PluginState[];
    /** usePlugins.togglePlugin — set semantics, persists + reloads. */
    togglePlugin: (pluginId: string, enabled: boolean) => Promise<void>;
    /** The user-visibility-filtered provider list (same set Cmd+K offers). */
    searchProviders: PluginSearchProvider[];
    invokePluginSearch: (
      pluginId: string,
      providerId: string,
      query: string,
      limit: number,
    ) => Promise<PluginSearchResult>;
    invokeInfoFetch: InvokeInfoFetch;
    pluginNames?: Map<string, string>;
    /** Plugin home shelves (merged manifest + runtime, e.g. Spotify sections). */
    homeShelves: Array<{ pluginId: string; shelfId: string; title: string; displayKind: HomeShelfDisplayKind; limit: number }>;
    invokeHomeShelf: (pluginId: string, shelfId: string, limit: number) => Promise<HomeShelfResult>;
    invokeHomeShelfResolvePlay: (pluginId: string, shelfId: string, item: HomeShelfItem) => Promise<PluginTrack[]> | null;
    /** The user-visibility-filtered plugin context-menu items. */
    menuItems: PluginMenuItem[];
    dispatchContextMenuAction: (pluginId: string, actionId: string, target: PluginContextMenuTarget) => void;
    forwardDeepLink: (url: string) => void;
  };
  skins: {
    installedSkins: SkinInfo[];
    activeSkinId: string;
    applySkin: (id: string) => void;
  };
  extensions: {
    updates: ExtensionUpdate[];
    checking: boolean;
    lastChecked: number | null;
    checkForUpdates: (opts?: { silent?: boolean }) => Promise<unknown> | unknown;
  };
  mini: {
    miniMode: boolean;
    toggleMiniMode: () => Promise<void> | void;
  };
  window: {
    /** App's declarative fullscreen setter (the probe's) — no-ops when the
     *  state already matches; covers all three fullscreen surfaces. */
    setFullscreen: (on: boolean) => void;
    isFullscreen: () => boolean;
  };
  logging: {
    enabled: boolean;
    setEnabled: (on: boolean) => void;
    debug: boolean;
    setDebug: (on: boolean) => void;
  };
  collections: {
    /** useCollectionActions.resyncCollection — sets the same in-flight UI
     *  state the Collections view shows and rethrows failures so they land in
     *  the HTTP response. Resolves with the collection's name; the scan runs
     *  in the background. */
    resync: (collectionId: number, full?: boolean) => Promise<string>;
  };
  likeActions: {
    setTrackRating: (track: QueueTrack, likeState: number, source?: "like" | "dislike" | "set") => Promise<boolean>;
    setArtistLike: (name: string, likeState: number) => Promise<{ ok: boolean; mirrored: boolean }>;
    setAlbumLike: (title: string, artistName: string | undefined, likeState: number) => Promise<{ ok: boolean; mirrored: boolean }>;
    setTagLike: (name: string, likeState: number) => Promise<{ ok: boolean; mirrored: boolean }>;
  };
}

function bad(message: string): never {
  throw new Error(message);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Resolve request trackIds to library tracks, preserving request order. */
async function resolveTracks(payload: Record<string, unknown>): Promise<Track[]> {
  const ids = asNumberArray(payload.trackIds);
  if (!ids) bad("trackIds must be a non-empty array of numbers");
  const tracks = await invoke<Track[]>("get_tracks_by_ids", { ids });
  const ordered = orderTracksByIds(tracks, ids);
  if (ordered.length === 0) bad("no library tracks found for the given trackIds");
  return ordered;
}

// Info-type rows as the backend returns them (same tuples useInformationTypes reads):
// [type_id, name, display_kind, ttl, sort_order, providers: [plugin_id, integer_id][], description]
type InfoTypeRow = [string, string, string, number, number, Array<[string, number]>, string];
// [integer_id, type_id, value, status, fetched_at]
type InfoValueRow = [number, string, string, string, number];

/** Build an InfoEntity from verb payload fields, resolving the library id
 *  best-effort (some plugin handlers key on `entity.id`; 0 = not in library,
 *  which every provider already tolerates — restored queues fetch that way). */
async function resolveInfoEntity(payload: Record<string, unknown>): Promise<InfoEntity> {
  const kind = payload.kind;
  if (kind !== "track" && kind !== "artist" && kind !== "album" && kind !== "tag") {
    bad('kind must be "track", "artist", "album" or "tag"');
  }
  const name = optionalString(payload.name) ?? optionalString(payload.title)
    ?? bad("name (or title) is required");
  const artistName = optionalString(payload.artistName);
  const albumTitle = optionalString(payload.albumTitle);
  let id = 0;
  try {
    if (kind === "track") {
      id = (await invoke<{ id: number } | null>("find_track_by_metadata", {
        title: name, artistName: artistName ?? null, albumName: albumTitle ?? null,
      }))?.id ?? 0;
    } else if (kind === "artist") {
      id = (await invoke<{ id: number } | null>("find_artist_by_name", { name }))?.id ?? 0;
    } else if (kind === "album") {
      id = (await invoke<{ id: number } | null>("find_album_by_name", {
        title: name, artistName: artistName ?? null,
      }))?.id ?? 0;
    } else {
      id = (await invoke<{ id: number } | null>("find_tag_by_name", { name }))?.id ?? 0;
    }
  } catch (e) {
    console.error("Control API: entity id lookup failed:", e);
  }
  return { kind, name, id, artistName, albumTitle };
}

function parseInfoValue(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return null; }
}

/** Convert plugin tracks for the queue and reconcile their like state against
 *  the durable store — the same pairing App's plugin-playback bridge runs. */
async function toReconciledQueueTracks(tracks: PluginTrack[]): Promise<QueueTrack[]> {
  const qts = tracks.map(pluginTrackToQueueTrack);
  const states = await fetchLikeStates(qts);
  return applyLikeStates(qts, states);
}

/** Playlist mutations apply only to user playlists — auto/system rows are
 *  regenerated by the app, so an edit would silently vanish. */
async function assertUserPlaylist(playlistId: number): Promise<void> {
  const playlists = await invoke<Array<{ id: number; system_kind: string | null }>>("get_playlists");
  const playlist = playlists.find((p) => p.id === playlistId);
  if (!playlist) bad(`playlist ${playlistId} not found`);
  if (playlist.system_kind) bad("system playlists are managed by the app and can't be edited");
}

/** How many plugin-search results the dispatcher keeps for play-search.
 *  Session-only, insertion-ordered (Map), oldest evicted past the cap — the
 *  cache is what lets results be played WITHOUT the API ever accepting
 *  arbitrary track URIs off the wire. */
const SEARCH_CACHE_CAP = 8;

export function useControlApi(deps: ControlApiDeps) {
  const depsRef = useLatestRef(deps);
  const searchCacheRef = useRef(new Map<string, { tracks: QueueTrack[]; label: string }>());
  const searchSeqRef = useRef(1);
  const shelfCacheRef = useRef(new Map<string, {
    shelf: { pluginId: string; shelfId: string; title: string; displayKind: HomeShelfDisplayKind };
    items: HomeShelfItem[];
  }>());
  const shelfSeqRef = useRef(1);

  // Tell the backend bridged routes may dispatch — once, after restore, so a
  // request can never race the queue/track restore (same gate the deep-link
  // path respects). The ready flag lives on backend state independent of
  // whether the server is currently running, so this is unconditional.
  const readySentRef = useRef(false);
  useEffect(() => {
    if (deps.appRestoring || readySentRef.current) return;
    readySentRef.current = true;
    invoke("control_api_client_ready").catch((e) =>
      console.error("Control API: failed to signal client ready:", e));
  }, [deps.appRestoring]);

  async function dispatch(verb: string, payload: Record<string, unknown>): Promise<unknown> {
    const d = depsRef.current;
    switch (verb) {
      case "status":
        return serializeStatus({
          playing: d.playback.playing,
          positionSecs: getPlaybackPosition(),
          durationSecs: d.playback.durationSecs,
          volume: d.playback.volume,
          muted: d.playback.muted,
          queueLength: d.queueHook.queue.length,
          queueIndex: d.queueHook.queueIndex,
          queueMode: d.queueHook.queueMode,
          view: d.view,
          currentTrack: d.playback.currentTrack,
        });

      case "queue.get":
        return serializeQueue(d.queueHook.queue, d.queueHook.queueIndex, d.queueHook.queueMode);

      case "playback.set": {
        const parsed = parsePlaybackSet(payload);
        if (typeof parsed === "string") bad(parsed);
        if (parsed.volume !== undefined) d.playback.handleVolume(parsed.volume);
        if (parsed.seekSecs !== undefined) d.playback.handleSeek(parsed.seekSecs);
        if (parsed.play !== undefined && decidePlayPause(parsed.play, d.playback.playing) === "toggle") {
          d.playback.handlePause(); // the underlying handler is a toggle
        }
        if (parsed.mode !== undefined) d.queueHook.setQueueMode(parsed.mode);
        if (parsed.action === "next") d.next();
        else if (parsed.action === "prev") d.previous();
        else if (parsed.action === "stop") d.playback.handleStop();
        // Transport state updates through React on the next render, so a
        // fresh snapshot here would still show the pre-command values — the
        // caller reads GET /v1/status for the settled state.
        return { ok: true };
      }

      case "queue.play": {
        const tracks = (await resolveTracks(payload)).map(trackToQueueTrack);
        d.queueHook.playTracks(tracks, 0, {
          name: optionalString(payload.contextName) ?? "Control API",
          source: "control-api",
        });
        return { queued: tracks.length };
      }

      case "queue.add": {
        const mode = payload.mode ?? "end";
        if (mode !== "end" && mode !== "next") bad('mode must be "end" or "next"');
        const tracks = (await resolveTracks(payload)).map(trackToQueueTrack);
        // The findDuplicates check every enqueue entry point runs (queue.md);
        // the API resolves the banner's question programmatically instead of
        // popping a modal over a user who didn't act — skips are reported.
        const dup = d.queueHook.findDuplicates(tracks);
        const { toAdd, skipped } = partitionEnqueue(tracks, dup, payload.allowDuplicates === true);
        if (toAdd.length > 0) {
          if (mode === "next") d.queueHook.insertAtPosition(toAdd, d.queueHook.queueIndex + 1);
          else d.queueHook.enqueueTracks(toAdd);
        }
        return { added: toAdd.length, skippedDuplicates: skipped };
      }

      case "queue.remove": {
        const indices = validateIndices(payload.indices, d.queueHook.queue.length);
        if (typeof indices === "string") bad(indices);
        d.queueHook.removeMultiple(indices);
        return { removed: indices.length };
      }

      case "queue.clear":
        d.queueHook.clearQueue();
        return { ok: true };

      case "queue.jump": {
        const index = payload.index;
        if (typeof index !== "number" || !Number.isInteger(index)
          || index < 0 || index >= d.queueHook.queue.length) {
          bad(`index must be an integer in [0, ${d.queueHook.queue.length - 1}]`);
        }
        // The same two calls the queue panel's row-play makes (App.tsx onPlay).
        const track = d.queueHook.queue[index];
        d.queueHook.setQueueIndex(index);
        d.playback.handlePlay(track);
        return { ok: true, index, title: track.title };
      }

      case "queue.randomize": {
        // Same gates the queue-header button applies (queue.md): a one-shot
        // reorder, meaningless under 2 tracks and disabled in repeat-one.
        if (d.queueHook.queueMode === "repeat-one") bad("randomize is disabled in repeat-one mode");
        if (d.queueHook.queue.length < 2) bad("the queue needs at least 2 tracks to randomize");
        d.queueHook.randomizeQueue();
        return { ok: true, queueLength: d.queueHook.queue.length };
      }

      case "radio.start": {
        let title = optionalString(payload.title);
        let artistName = optionalString(payload.artistName) ?? null;
        if (payload.trackId !== undefined) {
          if (typeof payload.trackId !== "number") bad("trackId must be a number");
          const [track] = await invoke<Track[]>("get_tracks_by_ids", { ids: [payload.trackId] });
          if (!track) bad(`track ${payload.trackId} not found`);
          title = track.title;
          artistName = track.artist_name ?? null;
        }
        if (!title) bad("radio needs a seed: trackId, or title (+ artistName)");
        // Canonical startRadio: builds the station, replaces the queue with a
        // "Radio: …" context, resolves the banner cover after playback starts.
        const queued = await d.startRadio({ title, artistName, coverPath: null });
        if (queued === null) bad(`couldn't start radio — "${title}" isn't in the library`);
        return { queued, station: `Radio: ${title}` };
      }

      case "likes.set": {
        const likeState = parseLikeState(payload.likeState);
        if (likeState === null) bad("likeState must be -1, 0 or 1");
        const kind = payload.kind;
        if (kind === "track") {
          const title = optionalString(payload.title) ?? bad("track likes need a title");
          const candidate: QueueTrack = {
            key: nextQueueKey(),
            path: null,
            title,
            artist_name: optionalString(payload.artistName) ?? null,
            album_title: optionalString(payload.albumTitle) ?? null,
            duration_secs: null,
            format: null,
            liked: 0,
          };
          // Prefer a live copy (queue / now playing) so the optimistic mirror
          // starts from its real prior state and keeps its key identity.
          const existing = [d.playback.currentTrack, ...d.queueHook.queue]
            .find((t): t is QueueTrack => t !== null && sameSong(t, candidate));
          const ok = await d.likeActions.setTrackRating(existing ?? candidate, likeState);
          if (!ok) bad("like write failed or is already in flight — retry");
          return { ok: true, likeState };
        }
        if (kind === "artist" || kind === "tag") {
          const name = optionalString(payload.name) ?? bad(`${kind} likes need a name`);
          const result = kind === "artist"
            ? await d.likeActions.setArtistLike(name, likeState)
            : await d.likeActions.setTagLike(name, likeState);
          if (!result.ok) bad("like write failed — retry");
          return { ok: true, likeState, mirrored: result.mirrored };
        }
        if (kind === "album") {
          const title = optionalString(payload.title) ?? bad("album likes need a title");
          const result = await d.likeActions.setAlbumLike(title, optionalString(payload.artistName), likeState);
          if (!result.ok) bad("like write failed — retry");
          return { ok: true, likeState, mirrored: result.mirrored };
        }
        return bad('kind must be "track", "artist", "album" or "tag"');
      }

      // --- Info values (lyrics, bios, similar, …) + entity images ---

      case "info.get": {
        // Cached values + the registered-type roster for one entity. Reads
        // only — a stale/missing value is reported, never fetched from here.
        const entity = await resolveInfoEntity(payload);
        const entityKey = buildEntityKey(entity);
        const types = await invoke<InfoTypeRow[]>("info_get_types_for_entity", { entity: entity.kind });
        const cached = await invoke<InfoValueRow[]>("info_get_values_for_entity", { entityKey });
        const cacheMap = new Map(cached.map(([integerId, typeId, value, status, fetchedAt]) =>
          [typeId, { integerId, value, status, fetchedAt }]));
        const now = Math.floor(Date.now() / 1000);
        return {
          entityKey,
          sections: types.map(([typeId, name, displayKind, ttl, , providers]) => {
            const c = cacheMap.get(typeId);
            return {
              typeId,
              name,
              displayKind,
              status: c?.status ?? null,
              fetchedAt: c?.fetchedAt ?? null,
              fresh: c
                ? decideCacheAction(c.status, c.fetchedAt, cacheTtlForRow(providers, c.integerId, c.status, ttl), now) === "render"
                : false,
              value: c?.status === "ok" ? parseInfoValue(c.value) : null,
            };
          }),
        };
      }

      case "info.fetch": {
        // One info type for one entity: fresh cache is served as-is, anything
        // else walks the SAME provider chain the detail pages run
        // (fetchInfoThroughChain), so the result lands in the shared cache.
        const typeId = optionalString(payload.typeId)
          ?? bad("typeId is required (GET /v1/info/entity lists the registered types)");
        const entity = await resolveInfoEntity(payload);
        const entityKey = buildEntityKey(entity);
        const types = await invoke<InfoTypeRow[]>("info_get_types_for_entity", { entity: entity.kind });
        const row = types.find(([id]) => id === typeId)
          ?? bad(`type "${typeId}" is not registered for ${entity.kind} entities (available: ${types.map((t) => t[0]).join(", ") || "none"})`);
        const [, name, displayKind, ttl, , providers] = row;

        const cached = await invoke<InfoValueRow[]>("info_get_values_for_entity", { entityKey });
        const c = cached.find(([, id]) => id === typeId);
        const now = Math.floor(Date.now() / 1000);
        // Local (`core:`) rows and misses on a type with a local provider
        // expire daily — the answer can change on disk. See cacheTtlForRow.
        if (c && decideCacheAction(c[3], c[4], cacheTtlForRow(providers, c[0], c[3], ttl), now) === "render") {
          return { typeId, name, displayKind, status: "ok", source: "cache", value: parseInfoValue(c[2]) };
        }
        if (providers.length === 0) bad(`no providers registered for "${typeId}" — is the plugin enabled?`);
        const { result } = await fetchInfoThroughChain({
          typeId, providers, entity, entityKey,
          invokeInfoFetch: d.plugins.invokeInfoFetch,
          pluginNames: d.plugins.pluginNames,
        });
        return {
          typeId,
          name,
          displayKind,
          status: result.status,
          source: "fetch",
          value: result.status === "ok" ? result.value : null,
        };
      }

      case "lyrics.get": {
        // Sugar over info.fetch(typeId: "lyrics"), defaulting to what's playing.
        let title = optionalString(payload.title);
        let artistName = optionalString(payload.artistName);
        let albumTitle = optionalString(payload.albumTitle);
        if (!title) {
          const t = d.playback.currentTrack
            ?? bad("nothing is playing — pass title (and artistName)");
          title = t.title;
          artistName = t.artist_name ?? undefined;
          albumTitle = t.album_title ?? undefined;
        }
        return await dispatch("info.fetch", {
          kind: "track", title, artistName, albumTitle, typeId: "lyrics",
        });
      }

      case "images.fetch": {
        // Kick the Rust image worker's provider-chain resolve — the same
        // commands the UI's Retrieve buttons invoke. Async by nature (the
        // worker emits *-image-ready events); the caller re-GETs the image.
        const kind = payload.kind;
        const name = optionalString(payload.name) ?? bad("name is required");
        const artistName = optionalString(payload.artistName);
        if (kind === "artist") await invoke("fetch_artist_image", { artistName: name });
        else if (kind === "album") await invoke("fetch_album_image", { albumTitle: name, artistName: artistName ?? null });
        else if (kind === "tag") await invoke("fetch_tag_image", { tagName: name });
        else bad('kind must be "artist", "album" or "tag"');
        return { started: true, note: "resolving through the image provider chain — retry GET /v1/images/{kind} in a few seconds" };
      }

      // --- Plugin catalog search (Spotify, YouTube, …) ---

      case "search.providers":
        return {
          providers: d.plugins.searchProviders.map((p) => ({
            key: `${p.pluginId}:${p.providerId}`,
            pluginId: p.pluginId,
            providerId: p.providerId,
            name: p.name,
          })),
        };

      case "search.plugin": {
        const query = optionalString(payload.query) ?? bad("query is required");
        const providerKey = optionalString(payload.provider)
          ?? bad('provider is required (a key from GET /v1/search/providers, e.g. "ytdlp:youtube")');
        const limit = typeof payload.limit === "number"
          ? Math.min(100, Math.max(1, Math.floor(payload.limit)))
          : 30;
        const provider = resolveSearchProvider(d.plugins.searchProviders, providerKey);
        if (typeof provider === "string") bad(provider);
        const result = await d.plugins.invokePluginSearch(
          provider.pluginId, provider.providerId, query, limit,
        );
        if (result.status === "error") bad(result.message ?? "provider search failed");
        if (result.status === "empty" || result.tracks.length === 0) {
          return { searchId: null, provider: `${provider.pluginId}:${provider.providerId}`, tracks: [] };
        }
        const tracks = result.tracks.map(pluginTrackToQueueTrack);
        const searchId = `s${searchSeqRef.current++}`;
        searchCacheRef.current.set(searchId, { tracks, label: `${provider.name}: ${query}` });
        while (searchCacheRef.current.size > SEARCH_CACHE_CAP) {
          const oldest = searchCacheRef.current.keys().next().value;
          if (oldest === undefined) break;
          searchCacheRef.current.delete(oldest);
        }
        return {
          searchId,
          provider: `${provider.pluginId}:${provider.providerId}`,
          tracks: tracks.map((t, i) => ({
            index: i,
            title: t.title,
            artistName: t.artist_name ?? null,
            albumTitle: t.album_title ?? null,
            durationSecs: t.duration_secs ?? null,
            video: t.format === "mp4",
          })),
        };
      }

      case "queue.playSearch": {
        const searchId = optionalString(payload.searchId)
          ?? bad("searchId is required (from POST /v1/search/plugin)");
        const entry = searchCacheRef.current.get(searchId);
        if (!entry) bad(`unknown or expired searchId "${searchId}" — re-run the search`);
        const selected = selectSearchTracks(entry.tracks, payload.indices);
        if (typeof selected === "string") bad(selected);
        const mode = payload.mode ?? "play";
        if (mode !== "play" && mode !== "end" && mode !== "next") {
          bad('mode must be "play", "end" or "next"');
        }
        // Fresh keys per use: playing the same cached result twice must not
        // collide two queue entries on one React key.
        const tracks = selected.map((t) => ({ ...t, key: nextQueueKey() }));
        if (mode === "play") {
          d.queueHook.playTracks(tracks, 0, { name: entry.label, source: "control-api" });
          return { queued: tracks.length, name: entry.label };
        }
        const dup = d.queueHook.findDuplicates(tracks);
        const { toAdd, skipped } = partitionEnqueue(tracks, dup, payload.allowDuplicates === true);
        if (toAdd.length > 0) {
          if (mode === "next") d.queueHook.insertAtPosition(toAdd, d.queueHook.queueIndex + 1);
          else d.queueHook.enqueueTracks(toAdd);
        }
        return { added: toAdd.length, skippedDuplicates: skipped, name: entry.label };
      }

      // --- Window control ---

      case "window.get": {
        const w = getCurrentWindow();
        const [visible, minimized, maximized] = await Promise.all([
          w.isVisible(), w.isMinimized(), w.isMaximized(),
        ]);
        return {
          visible, minimized, maximized,
          fullscreen: d.window.isFullscreen(),
          mini: d.mini.miniMode,
        };
      }

      case "window.set": {
        const fields = ["visible", "minimized", "maximized", "fullscreen", "mini", "focus"] as const;
        for (const f of fields) {
          if (payload[f] !== undefined && typeof payload[f] !== "boolean") bad(`${f} must be a boolean`);
        }
        if (fields.every((f) => payload[f] === undefined)) {
          bad(`window.set needs at least one of: ${fields.join(", ")}`);
        }
        // Ordering mirrors the probe dispatcher: restore before anything else
        // (a miniaturized webview is throttled), leave fullscreen early and
        // enter it late, minimize/hide absolutely last.
        const w = getCurrentWindow();
        if (payload.minimized === false) await w.unminimize();
        if (payload.visible === true) await w.show();
        if (payload.fullscreen === false) d.window.setFullscreen(false);
        if (typeof payload.mini === "boolean" && payload.mini !== d.mini.miniMode) {
          await d.mini.toggleMiniMode();
        }
        if (payload.maximized === true) await w.maximize();
        if (payload.maximized === false) await w.unmaximize();
        if (payload.fullscreen === true) d.window.setFullscreen(true);
        if (payload.focus === true) await w.setFocus();
        if (payload.minimized === true) await w.minimize();
        if (payload.visible === false) await w.hide();
        // Best-effort snapshot — an OS window animation can lag these reads.
        const [visible, minimized, maximized] = await Promise.all([
          w.isVisible(), w.isMinimized(), w.isMaximized(),
        ]);
        return { visible, minimized, maximized, fullscreen: d.window.isFullscreen(), mini: d.mini.miniMode };
      }

      // --- Logs ---

      case "logs.frontend": {
        // The always-on in-memory ring buffers: uncaught frontend errors,
        // stream-resolver activity, plugin api.log lines, and recent toasts —
        // the last two are how a fire-and-forget verb's outcome (a failed
        // "Watch YouTube video" search, say) becomes readable after the fact.
        // Home dir scrubbed — an assistant may relay these lines into an issue.
        const facts = await invoke<{ homeDir?: string | null }>("collect_diagnostics")
          .catch((e) => { console.error("Control API: collect_diagnostics failed:", e); return null; });
        const home = facts?.homeDir ?? null;
        const scrub = <T,>(entries: T[]): T[] =>
          JSON.parse(scrubPaths(JSON.stringify(entries), home)) as T[];
        return {
          errors: scrub(appErrorEntries()),
          resolverLog: scrub(resolverLogEntries()),
          pluginLog: scrub(pluginLogEntries()),
          notifications: scrub(notificationLogEntries()),
        };
      }

      case "logs.set": {
        if (payload.enabled === undefined && payload.debug === undefined) {
          bad("logs.set needs enabled and/or debug (booleans)");
        }
        if (payload.enabled !== undefined) {
          if (typeof payload.enabled !== "boolean") bad("enabled must be a boolean");
          d.logging.setEnabled(payload.enabled);
        }
        if (payload.debug !== undefined) {
          if (typeof payload.debug !== "boolean") bad("debug must be a boolean");
          d.logging.setDebug(payload.debug);
        }
        return {
          enabled: (payload.enabled as boolean | undefined) ?? d.logging.enabled,
          debug: (payload.debug as boolean | undefined) ?? d.logging.debug,
          note: "file logging takes effect on the next app launch; debug logging is live",
        };
      }

      // --- Plugin home shelves (e.g. Spotify sections) ---

      case "home.shelves":
        // Plugin shelves only — the library-derived built-ins are covered by
        // /v1/history and /v1/picks.
        return {
          shelves: d.plugins.homeShelves.map((s) => ({
            key: `${s.pluginId}:${s.shelfId}`,
            pluginId: s.pluginId,
            shelfId: s.shelfId,
            title: s.title,
            displayKind: s.displayKind,
          })),
        };

      case "home.shelf": {
        const key = optionalString(payload.shelf)
          ?? bad('shelf is required (a key from GET /v1/home/shelves)');
        const shelf = resolveHomeShelf(d.plugins.homeShelves, key);
        if (typeof shelf === "string") bad(shelf);
        const limit = typeof payload.limit === "number"
          ? Math.min(100, Math.max(1, Math.floor(payload.limit)))
          : shelf.limit;
        const result = await d.plugins.invokeHomeShelf(shelf.pluginId, shelf.shelfId, limit);
        if (result.status === "error") bad(result.message ?? "shelf fetch failed");
        if (result.status === "empty" || result.items.length === 0) {
          return { fetchId: null, shelf: `${shelf.pluginId}:${shelf.shelfId}`, items: [] };
        }
        const fetchId = `h${shelfSeqRef.current++}`;
        shelfCacheRef.current.set(fetchId, { shelf, items: result.items });
        while (shelfCacheRef.current.size > SEARCH_CACHE_CAP) {
          const oldest = shelfCacheRef.current.keys().next().value;
          if (oldest === undefined) break;
          shelfCacheRef.current.delete(oldest);
        }
        return {
          fetchId,
          shelf: `${shelf.pluginId}:${shelf.shelfId}`,
          title: shelf.title,
          items: result.items.map((item, i) => serializeShelfItem(shelf.displayKind, item, i)),
        };
      }

      case "home.play": {
        const fetchId = optionalString(payload.fetchId)
          ?? bad("fetchId is required (from POST /v1/home/shelf)");
        const entry = shelfCacheRef.current.get(fetchId);
        if (!entry) bad(`unknown or expired fetchId "${fetchId}" — re-fetch the shelf`);
        const index = payload.index;
        if (typeof index !== "number" || !Number.isInteger(index)
          || index < 0 || index >= entry.items.length) {
          bad(`index must be an integer in [0, ${entry.items.length - 1}]`);
        }
        const item = entry.items[index];
        const { pluginId, shelfId, displayKind } = entry.shelf;
        // The same decision the Home page's play button runs.
        const action = resolveShelfPlayAction(displayKind, item);

        if (action.kind === "album-id" || action.kind === "artist-id") {
          const tracks = action.kind === "album-id"
            ? await invoke<Track[]>("get_tracks", { opts: { albumId: action.id } })
            : await invoke<Track[]>("get_tracks_by_artist", { artistId: action.id });
          if (tracks.length === 0) bad("that entity has no tracks");
          const name = (item as { name?: string }).name ?? entry.shelf.title;
          d.queueHook.playTracks(tracks.map(trackToQueueTrack), 0, { name, source: "control-api" });
          return { queued: tracks.length, name };
        }
        if (action.kind === "radio") {
          const queued = await d.startRadio({
            title: action.seed.title,
            artistName: action.seed.artist_name,
            coverPath: action.coverUrl ?? null,
          });
          if (queued === null) bad("couldn't start that station");
          return { queued, name: `Radio: ${action.seed.title}` };
        }

        const context: PlaylistContext = {
          name: action.kind === "tracks" && action.context?.name
            ? action.context.name
            : (item as { name?: string }).name ?? entry.shelf.title,
          imagePath: action.kind === "tracks" ? action.context?.imagePath ?? null : null,
          source: action.kind === "tracks" ? action.context?.source ?? "control-api" : "control-api",
        };

        if (action.kind === "tracks" && action.tracks.length > 0 && !action.partial) {
          const tracks = await toReconciledQueueTracks(action.tracks);
          d.queueHook.playTracks(tracks, 0, context);
          return { queued: tracks.length, name: context.name };
        }
        // Lazy or partial card: the shelf's resolve-play handler owns the list.
        const resolve = d.plugins.invokeHomeShelfResolvePlay(pluginId, shelfId, item);
        if (action.kind === "tracks" && action.partial && action.tracks.length > 0) {
          // Play the shipped head now, backfill the remainder behind the music.
          const head = await toReconciledQueueTracks(action.tracks);
          const appended = await d.playWithBackfill({
            head,
            context,
            resolveTail: async () => resolve ? toReconciledQueueTracks(await resolve) : [],
          });
          return { queued: head.length + appended.length, name: context.name, backfilled: appended.length };
        }
        if (!resolve) bad("this card ships no tracks and its shelf has no resolver");
        const resolved = await resolve;
        if (!resolved || resolved.length === 0) bad("the shelf resolved no tracks for this card");
        const tracks = await toReconciledQueueTracks(resolved);
        d.queueHook.playTracks(tracks, 0, context);
        return { queued: tracks.length, name: context.name };
      }

      // --- Plugin context-menu actions ---

      case "actions.list": {
        const target = optionalString(payload.target);
        const actions = d.plugins.menuItems
          .filter((m) => !target || m.targets.includes(target as PluginTargetKind))
          .map((m) => ({ actionId: m.id, pluginId: m.pluginId, label: m.label, targets: m.targets }));
        return { actions };
      }

      case "actions.invoke": {
        const actionId = optionalString(payload.actionId) ?? bad("actionId is required (see GET /v1/actions)");
        const pluginId = optionalString(payload.pluginId);
        const matches = d.plugins.menuItems.filter(
          (m) => m.id === actionId && (!pluginId || m.pluginId === pluginId),
        );
        if (matches.length === 0) {
          bad(`no plugin action "${actionId}" (available: ${d.plugins.menuItems.map((m) => m.id).join(", ") || "none"})`);
        }
        if (matches.length > 1) {
          bad(`"${actionId}" is ambiguous — pass pluginId (matches: ${matches.map((m) => m.pluginId).join(", ")})`);
        }
        const action = matches[0];
        const kind = (optionalString(payload.kind) ?? "track") as PluginTargetKind;
        if (!action.targets.includes(kind)) {
          bad(`"${actionId}" doesn't target ${kind} (targets: ${action.targets.join(", ")})`);
        }
        const target: PluginContextMenuTarget = { kind };
        if (typeof payload.trackId === "number") {
          const track = await invoke<Track>("get_track_by_id", { trackId: payload.trackId });
          target.trackId = payload.trackId;
          target.title = track.title;
          target.artistName = track.artist_name ?? undefined;
          target.albumTitle = track.album_title ?? undefined;
          target.isLocal = track.path?.startsWith("file://") ?? false;
        } else {
          target.title = optionalString(payload.title) ?? optionalString(payload.name);
          target.artistName = optionalString(payload.artistName);
          target.albumTitle = optionalString(payload.albumTitle);
        }
        const trackIds = asNumberArray(payload.trackIds);
        if (trackIds) target.trackIds = trackIds;
        if (kind === "track" && !target.trackId && !target.title) {
          bad("a track target needs a trackId or a title");
        }
        d.plugins.dispatchContextMenuAction(action.pluginId, actionId, target);
        // Effects (a view opening, playback starting, a job running) land in
        // the app — the dispatch itself is fire-and-forget by contract.
        return { invoked: true, pluginId: action.pluginId, actionId, note: "effects appear in the app" };
      }

      // --- Deep-link forwarding (plugin-defined verbs) ---

      case "plugins.deepLink": {
        const pluginId = payload.pluginId as string;
        const plugin = d.plugins.pluginStates.find((p) => p.id === pluginId)
          ?? bad(`plugin "${pluginId}" is not installed`);
        if (!plugin.enabled) bad(`plugin "${pluginId}" is disabled`);
        let path = optionalString(payload.path) ?? "";
        path = path.replace(/^\/+/, "");
        if (path.includes("://")) bad("path must be a plain path under the plugin's scope, not a URL");
        // The scoped form — delivered only to this plugin (plugins.md: the
        // broadcast form would hand the payload to every installed plugin).
        const url = `viboplr://plugin/${pluginId}/${path}`;
        d.plugins.forwardDeepLink(url);
        return { delivered: true, url };
      }

      // --- Extensions & skins ---
      // Read + reversible controls only. Install and delete are deliberate
      // NON-goals: installing a plugin grants it everything the app can do
      // (plugins.md), so an install verb would turn the control-API token into
      // an arbitrary-code-execution escalation. Do not add them.

      case "extensions.list":
        return {
          plugins: d.plugins.pluginStates.map((p) => ({
            id: p.id,
            name: p.manifest?.name ?? p.id,
            version: p.manifest?.version ?? null,
            description: p.manifest?.description ?? null,
            enabled: p.enabled,
            status: p.status,
            builtin: p.builtin === true,
            dev: p.dev === true,
          })),
          skins: d.skins.installedSkins.map((s) => ({
            id: s.id,
            name: s.name,
            type: s.type,
            source: s.source,
            active: s.id === d.skins.activeSkinId,
          })),
          // Reflects the LAST check (automatic ~30s after launch, then daily,
          // or a POST /extensions/check-updates) — not a live probe.
          updates: d.extensions.updates.map((u) => ({
            id: u.id,
            kind: u.kind,
            name: u.name,
            currentVersion: u.currentVersion,
            latestVersion: u.latestVersion,
            status: u.status,
          })),
          checking: d.extensions.checking,
          updatesCheckedAt: d.extensions.lastChecked,
        };

      case "extensions.setEnabled": {
        const pluginId = payload.pluginId as string;
        if (typeof payload.enabled !== "boolean") bad("enabled must be a boolean");
        const plugin = d.plugins.pluginStates.find((p) => p.id === pluginId);
        if (!plugin) bad(`plugin "${pluginId}" is not installed`);
        if (plugin.enabled === payload.enabled) {
          return { ok: true, id: pluginId, enabled: plugin.enabled, changed: false };
        }
        await d.plugins.togglePlugin(pluginId, payload.enabled);
        return { ok: true, id: pluginId, enabled: payload.enabled, changed: true };
      }

      case "extensions.checkUpdates": {
        // Fire-and-forget: a full check fans out per-extension network fetches
        // and can outlive the 10s bridge timeout. Results land in the app's
        // update state and show up in the next extensions.list.
        void Promise.resolve(d.extensions.checkForUpdates({ silent: true }))
          .catch((e) => console.error("Control API: extension update check failed:", e));
        return { started: true };
      }

      case "skins.apply": {
        const idOrName = optionalString(payload.id) ?? optionalString(payload.name)
          ?? bad("skins.apply needs an id or name");
        const skin = resolveSkin(d.skins.installedSkins, idOrName);
        if (!skin) {
          bad(`skin "${idOrName}" is not installed (installed: ${d.skins.installedSkins.map((s) => s.id).join(", ")})`);
        }
        d.skins.applySkin(skin.id);
        return { ok: true, id: skin.id, name: skin.name };
      }

      case "tags.edit": {
        const trackId = payload.trackId;
        if (typeof trackId !== "number") bad("trackId must be a number");
        const add = asStringArray(payload.add);
        const remove = asStringArray(payload.remove);
        if (add.length === 0 && remove.length === 0) bad("tags.edit needs add and/or remove");
        let tags = (await invoke<Array<{ name: string }>>("get_tags_for_track", { trackId })).map((t) => t.name);
        for (const name of remove) tags = await removeTag(trackId, tags, name);
        for (const name of add) tags = await applyTag(trackId, name);
        return { tags };
      }

      case "collections.rescan": {
        const collectionId = payload.collectionId;
        if (typeof collectionId !== "number") bad("collectionId must be a number");
        const full = payload.full === true;
        // resync_collection validates the id and kind itself and spawns the
        // scan in the background — this answer means "started", not
        // "finished"; progress lands in the library and in GET /collections'
        // last_synced_at.
        const name = await d.collections.resync(collectionId, full);
        return { started: true, name, full };
      }

      case "playlists.create": {
        const name = optionalString(payload.name) ?? bad("playlists need a name");
        const tracks = payload.trackIds !== undefined
          ? (await resolveTracks(payload)).map(toPlaylistTrackPayload)
          : [];
        const playlistId = await invoke<number>("save_playlist_record", {
          name,
          source: "control-api",
          imageUrl: null,
          description: optionalString(payload.description) ?? null,
          metadata: null,
          tracks,
        });
        return { playlistId, added: tracks.length };
      }

      case "playlists.play": {
        const playlistId = payload.playlistId as number;
        // Playing is read-only, so system/auto playlists are allowed here —
        // only edits are gated by assertUserPlaylist.
        const playlists = await invoke<Array<{
          id: number; name: string; image_path: string | null;
          source: string | null; description: string | null;
        }>>("get_playlists");
        const playlist = playlists.find((p) => p.id === playlistId);
        if (!playlist) bad(`playlist ${playlistId} not found`);
        const rows = await invoke<PlaylistTrackRow[]>("get_playlist_tracks", { playlistId });
        if (rows.length === 0) bad("playlist is empty");
        // Same conversion + like reconcile the Playlists view runs.
        const likeStates = await fetchLikeStates(rows);
        const tracks = applyLikeStates(rows.map(playlistTrackToQueueTrack), likeStates);
        d.queueHook.playTracks(tracks, 0, {
          name: playlist.name,
          imagePath: playlist.image_path ?? null,
          source: playlist.source ?? "playlist",
          description: playlist.description ?? null,
        });
        return { queued: tracks.length, name: playlist.name };
      }

      case "playlists.enqueue": {
        // Additive, so system/auto playlists are allowed (like playlists.play —
        // nothing about the playlist itself is edited).
        const playlistId = payload.playlistId as number;
        const mode = payload.mode ?? "end";
        if (mode !== "end" && mode !== "next") bad('mode must be "end" or "next"');
        const playlists = await invoke<Array<{ id: number; name: string }>>("get_playlists");
        const playlist = playlists.find((p) => p.id === playlistId);
        if (!playlist) bad(`playlist ${playlistId} not found`);
        const rows = await invoke<PlaylistTrackRow[]>("get_playlist_tracks", { playlistId });
        if (rows.length === 0) bad("playlist is empty");
        const likeStates = await fetchLikeStates(rows);
        const tracks = applyLikeStates(rows.map(playlistTrackToQueueTrack), likeStates);
        // Same duplicate semantics as queue.add: the check runs, the answer is
        // programmatic (skip + report, or allowDuplicates).
        const dup = d.queueHook.findDuplicates(tracks);
        const { toAdd, skipped } = partitionEnqueue(tracks, dup, payload.allowDuplicates === true);
        if (toAdd.length > 0) {
          if (mode === "next") d.queueHook.insertAtPosition(toAdd, d.queueHook.queueIndex + 1);
          else d.queueHook.enqueueTracks(toAdd);
        }
        return { added: toAdd.length, skippedDuplicates: skipped, name: playlist.name };
      }

      case "playlists.append": {
        const playlistId = payload.playlistId as number;
        await assertUserPlaylist(playlistId);
        const tracks = (await resolveTracks(payload)).map(toPlaylistTrackPayload);
        return await invoke("append_playlist_tracks", {
          playlistId,
          tracks,
          allowDuplicates: payload.allowDuplicates === true,
        });
      }

      case "playlists.removeTracks": {
        const playlistId = payload.playlistId as number;
        await assertUserPlaylist(playlistId);
        const rowIds = asNumberArray(payload.playlistTrackIds)
          ?? bad("playlistTrackIds must be a non-empty array of playlist-row ids (from GET /v1/playlists/{id}/tracks)");
        await invoke("remove_playlist_tracks", { playlistId, trackIds: rowIds });
        return { removed: rowIds.length };
      }

      case "playlists.reorder": {
        const playlistId = payload.playlistId as number;
        await assertUserPlaylist(playlistId);
        const orderedIds = asNumberArray(payload.orderedIds)
          ?? bad("orderedIds must be the full permutation of playlist-row ids");
        await invoke("reorder_playlist_tracks", { playlistId, orderedIds });
        return { ok: true };
      }

      case "playlists.rename": {
        const playlistId = payload.playlistId as number;
        await assertUserPlaylist(playlistId);
        const name = optionalString(payload.name) ?? bad("rename needs a name");
        await invoke("update_playlist_meta", {
          playlistId,
          name,
          description: optionalString(payload.description) ?? null,
        });
        return { ok: true };
      }

      default:
        bad(`unknown verb "${verb}"`);
    }
  }

  const handleRef = useRef(async (_req: ControlApiRequest) => {});
  useAssignRef(handleRef, async (req: ControlApiRequest) => {
    let ok = true;
    let result: unknown;
    try {
      result = await dispatch(req.verb, req.payload);
    } catch (e) {
      ok = false;
      result = errorText(e);
      console.error(`Control API: ${req.verb} failed:`, e);
    }
    try {
      await invoke("control_api_respond", { id: req.id, ok, result });
    } catch (e) {
      console.error("Control API: failed to deliver response:", e);
    }
  });

  useEffect(() => {
    const stop = subscribe<unknown>("control-api-request", (event) => {
      const req = parseControlRequest(event.payload);
      if (!req) {
        console.error("Control API: malformed request event:", event.payload);
        return;
      }
      handleRef.current(req).catch((e) => console.error("Control API: handler crashed:", e));
    });
    return stop;
  }, []);
}
