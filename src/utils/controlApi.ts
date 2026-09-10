// Pure logic for the localhost control API's frontend dispatcher
// (hooks/useControlApi.ts). Everything here is synchronous and side-effect
// free so the request validation and decision rules are unit-testable without
// a webview — same split as probeControl.ts vs. the App.tsx probe dispatcher.
//
// The Rust side (src-tauri/src/control_api.rs) validates transport concerns
// (auth, JSON shape, path params); this file validates *semantics* — verb
// payload fields, index ranges, like-state values — and shapes the responses.

import type { QueueTrack, QueueMode } from "../types";
import type { Track } from "../types";
import type {
  GalleryPluginEntry, HomeShelfDisplayKind, HomeShelfItem, PluginAssistantTool,
  PluginManifestContributes, PluginState,
} from "../types/plugin";
import type { GallerySkinEntry, SkinInfo } from "../types/skin";
import { resolveShelfPlayAction } from "./homeShelfPlay";
import { stabilityTier } from "./pluginStability";

/** Payload of the `control-api-request` Tauri event. */
export interface ControlApiRequest {
  id: number;
  verb: string;
  payload: Record<string, unknown>;
}

/** Parse the event payload defensively — the emitter is our own backend, but a
 *  malformed request must become an error response, never a thrown render. */
export function parseControlRequest(raw: unknown): ControlApiRequest | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "number" || typeof r.verb !== "string") return null;
  const payload =
    typeof r.payload === "object" && r.payload !== null && !Array.isArray(r.payload)
      ? (r.payload as Record<string, unknown>)
      : {};
  return { id: r.id, verb: r.verb, payload };
}

export function clampVolume(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.min(1, Math.max(0, v));
}

/** Idempotent play/pause: the underlying handlePause() is a toggle, so it is
 *  fired only when the desired state differs from the current one (the same
 *  comparison the probe route makes — App.tsx runProbeCommand). */
export function decidePlayPause(desired: boolean, playing: boolean): "toggle" | "noop" {
  return desired === playing ? "noop" : "toggle";
}

/** Validate a queue-index list against the live queue length. Returns the
 *  deduplicated indices, or an error string naming what was wrong. */
export function validateIndices(value: unknown, queueLength: number): number[] | string {
  const nums = asNumberArray(value);
  if (!nums || nums.length === 0) return "indices must be a non-empty array of numbers";
  const unique = [...new Set(nums)];
  for (const i of unique) {
    if (!Number.isInteger(i) || i < 0 || i >= queueLength) {
      return `index ${i} is out of range (queue has ${queueLength} tracks)`;
    }
  }
  return unique;
}

export function asNumberArray(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  return value as number[];
}

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.length > 0);
}

/** `get_tracks_by_ids` does not promise request order — reorder its result to
 *  the caller's id order, dropping ids that resolved to nothing. */
export function orderTracksByIds(tracks: Track[], ids: number[]): Track[] {
  const byId = new Map(tracks.map((t) => [t.id, t]));
  return ids.map((id) => byId.get(id)).filter((t): t is Track => t !== undefined);
}

/** How an API enqueue resolves the duplicate question that the UI resolves
 *  with the banner: the caller answered in the request (`allowDuplicates`),
 *  and skips are *reported* instead of silently dropped. The findDuplicates
 *  check itself still runs — this only replaces the modal. */
export function partitionEnqueue(
  all: QueueTrack[],
  dup: { duplicates: QueueTrack[]; unique: QueueTrack[] },
  allowDuplicates: boolean,
): { toAdd: QueueTrack[]; skipped: number } {
  if (allowDuplicates) return { toAdd: all, skipped: 0 };
  return { toAdd: dup.unique, skipped: dup.duplicates.length };
}

export interface SerializedQueueTrack {
  index: number;
  /** The entry's cached library row id (`QueueTrack.libraryId`) — what
   *  /v1/tracks/{id}/tags etc. take. Null for external entries. */
  libraryId: number | null;
  title: string;
  artistName: string | null;
  albumTitle: string | null;
  durationSecs: number | null;
  path: string | null;
  liked: number;
  current: boolean;
}

export function serializeQueue(
  queue: QueueTrack[],
  index: number,
  mode: QueueMode,
): { index: number; mode: QueueMode; tracks: SerializedQueueTrack[] } {
  return {
    index,
    mode,
    tracks: queue.map((t, i) => ({
      index: i,
      libraryId: t.libraryId ?? null,
      title: t.title,
      artistName: t.artist_name ?? null,
      albumTitle: t.album_title ?? null,
      durationSecs: t.duration_secs ?? null,
      path: t.path ?? null,
      liked: t.liked,
      current: i === index,
    })),
  };
}

export interface StatusInput {
  playing: boolean;
  positionSecs: number;
  durationSecs: number | null;
  volume: number;
  muted: boolean;
  queueLength: number;
  queueIndex: number;
  queueMode: QueueMode;
  view: string;
  currentTrack: QueueTrack | null;
}

export function serializeStatus(input: StatusInput) {
  const t = input.currentTrack;
  return {
    playing: input.playing,
    positionSecs: input.positionSecs,
    durationSecs: input.durationSecs,
    volume: input.volume,
    muted: input.muted,
    queueLength: input.queueLength,
    queueIndex: input.queueIndex,
    queueMode: input.queueMode,
    view: input.view,
    currentTrack: t
      ? {
          libraryId: t.libraryId ?? null,
          title: t.title,
          artistName: t.artist_name ?? null,
          albumTitle: t.album_title ?? null,
          durationSecs: t.duration_secs ?? null,
          path: t.path ?? null,
          liked: t.liked,
        }
      : null,
  };
}

/** Resolve a plugin search provider from a caller-supplied key: the full
 *  "pluginId:providerId", or a bare providerId / pluginId / display name when
 *  that alone is unambiguous. Returns the provider, or an error string naming
 *  the ambiguity/miss (with the valid keys, so an assistant can self-correct). */
export function resolveSearchProvider<T extends { pluginId: string; providerId: string; name: string }>(
  providers: T[],
  key: string,
): T | string {
  const exact = providers.find((p) => `${p.pluginId}:${p.providerId}` === key);
  if (exact) return exact;
  const lower = key.toLowerCase();
  const loose = providers.filter(
    (p) => p.providerId === key || p.pluginId === key || p.name.toLowerCase() === lower,
  );
  if (loose.length === 1) return loose[0];
  const roster = providers.map((p) => `${p.pluginId}:${p.providerId}`).join(", ");
  return loose.length === 0
    ? `no search provider matches "${key}" (available: ${roster || "none"})`
    : `"${key}" is ambiguous — use the full key (matches: ${loose.map((p) => `${p.pluginId}:${p.providerId}`).join(", ")})`;
}

/** Pick tracks from a cached search result. `indices` optional = all. */
export function selectSearchTracks(
  tracks: QueueTrack[],
  indices: unknown,
): QueueTrack[] | string {
  if (indices === undefined) return tracks;
  const picked = validateIndices(indices, tracks.length);
  if (typeof picked === "string") return picked;
  return picked.map((i) => tracks[i]);
}

/** Resolve a plugin home shelf from a caller key: full "pluginId:shelfId",
 *  or an unambiguous bare shelfId / pluginId / title. Same contract (and
 *  error shape) as resolveSearchProvider. */
export function resolveHomeShelf<T extends { pluginId: string; shelfId: string; title: string }>(
  shelves: T[],
  key: string,
): T | string {
  const exact = shelves.find((s) => `${s.pluginId}:${s.shelfId}` === key);
  if (exact) return exact;
  const lower = key.toLowerCase();
  const loose = shelves.filter(
    (s) => s.shelfId === key || s.pluginId === key || s.title.toLowerCase() === lower,
  );
  if (loose.length === 1) return loose[0];
  const roster = shelves.map((s) => `${s.pluginId}:${s.shelfId}`).join(", ");
  return loose.length === 0
    ? `no plugin shelf matches "${key}" (available: ${roster || "none"})`
    : `"${key}" is ambiguous — use the full key (matches: ${loose.map((s) => `${s.pluginId}:${s.shelfId}`).join(", ")})`;
}

/** One home-shelf card, summarized for the API: what it is, whether the play
 *  verb can act on it, and how many tracks it ships (0 for lazy cards, which
 *  still play — the resolver fills them in). */
export function serializeShelfItem(
  displayKind: HomeShelfDisplayKind,
  item: HomeShelfItem,
  index: number,
): { index: number; name: string; subtitle: string | null; playable: boolean; shippedTracks: number; partial: boolean; libraryId: number | null } {
  const it = item as {
    name?: string; subtitle?: string | null; libraryId?: number;
    tracks?: unknown[]; partial?: boolean; track?: { title: string; artist_name?: string | null };
  };
  const action = resolveShelfPlayAction(displayKind, item);
  const name = displayKind === "track-rows"
    ? it.track?.title ?? "?"
    : it.name ?? "?";
  const subtitle = displayKind === "track-rows"
    ? it.track?.artist_name ?? null
    : it.subtitle ?? null;
  const lazy = displayKind === "playlist-cards" || displayKind === "album-cards";
  return {
    index,
    name,
    subtitle,
    // A card with an empty track list is still playable when its shelf has a
    // resolve-play handler; the dispatcher checks that at play time.
    playable: action.kind !== "none" || (lazy && (it.tracks?.length ?? 0) === 0),
    shippedTracks: it.tracks?.length ?? (displayKind === "track-rows" ? 1 : 0),
    partial: it.partial === true,
    libraryId: it.libraryId ?? null,
  };
}

/** Resolve a skin by id, falling back to a case-insensitive name match —
 *  assistants will usually have the display name ("Midnight"), not the slug. */
export function resolveSkin<T extends { id: string; name: string }>(
  installed: T[],
  idOrName: string,
): T | null {
  const byId = installed.find((s) => s.id === idOrName);
  if (byId) return byId;
  const n = idOrName.toLowerCase();
  return installed.find((s) => s.name.toLowerCase() === n) ?? null;
}

// --- Extension capabilities + gallery ---------------------------------------

/** Live (runtime-merged, user-visibility-filtered) counts for the contribution
 *  kinds that can be registered at runtime — what the plugin can actually do
 *  through this API *right now*, which may differ from the manifest in both
 *  directions (yt-dlp registers its search provider only when its binary is
 *  present; a user can hide an item in Extensions → Contributions). */
export interface LiveCapabilityCounts {
  searchProviders: number;
  homeShelves: number;
  contextMenuItems: number;
  assistantTools: number;
}

/** Compact per-plugin capability summary for `extensions.list`. Runtime-capable
 *  kinds report the live count; manifest-only kinds report the declaration.
 *  Zero-valued keys are omitted so an agent scans flags, not a matrix. */
export function summarizeCapabilities(
  contributes: PluginManifestContributes | undefined,
  live: LiveCapabilityCounts,
): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {};
  const set = (key: string, count: number | undefined) => {
    if (count && count > 0) out[key] = count;
  };
  set("searchProviders", live.searchProviders);
  set("homeShelves", live.homeShelves);
  set("contextMenuItems", live.contextMenuItems);
  set("assistantTools", live.assistantTools);
  set("downloadProviders", contributes?.downloadProviders?.length);
  set("streamResolvers", contributes?.streamResolvers?.length);
  set("informationTypes", contributes?.informationTypes?.length);
  set("imageProviders", contributes?.imageProviders?.length);
  set("sidebarViews", contributes?.sidebarItems?.length);
  set("visualizers", contributes?.visualizers?.length);
  set("eventHooks", contributes?.eventHooks?.length);
  if (contributes?.settingsPanel) out.settingsPanel = true;
  return out;
}

/** The manifest's `contributes` block reshaped for `extensions.get`: stable,
 *  agent-relevant fields only (ids, names, targets, entities) — no icons,
 *  orders or display detail. These are *declarations*; the `live` block on the
 *  same response says what is registered and user-visible right now. */
export function describeContributes(contributes: PluginManifestContributes | undefined) {
  const c = contributes;
  return {
    searchProviders: (c?.searchProviders ?? []).map((p) => ({ id: p.id, name: p.name })),
    downloadProviders: (c?.downloadProviders ?? []).map((p) => ({ id: p.id, name: p.name })),
    streamResolvers: (c?.streamResolvers ?? []).map((r) => ({ id: r.id, name: r.name })),
    informationTypes: (c?.informationTypes ?? []).map((t) => ({
      id: t.id, name: t.name, entity: t.entity, displayKind: t.displayKind,
    })),
    imageProviders: (c?.imageProviders ?? []).map((p) => ({ entity: p.entity })),
    homeShelves: (c?.homeShelves ?? []).map((s) => ({ id: s.id, title: s.title, displayKind: s.displayKind })),
    contextMenuItems: (c?.contextMenuItems ?? []).map((m) => ({ id: m.id, label: m.label, targets: m.targets })),
    sidebarViews: (c?.sidebarItems ?? []).map((s) => ({ id: s.id, label: s.label })),
    visualizers: (c?.visualizers ?? []).map((v) => ({ id: v.id, name: v.name })),
    eventHooks: c?.eventHooks ?? [],
    settingsPanel: c?.settingsPanel ? { id: c.settingsPanel.id, label: c.settingsPanel.label } : null,
    assistant: c?.assistant
      ? {
          instructions: c.assistant.instructions ?? null,
          tools: (c.assistant.tools ?? []).map((t) => ({ name: t.name, description: t.description })),
        }
      : null,
  };
}

/** The assistant-tool roster, grouped per plugin: every registered tool plus
 *  the plugin's instructions (prose for the model). A plugin with
 *  instructions but no tools still gets an entry — the instructions may
 *  explain its other surfaces (search providers, actions, deep links). */
export function buildAssistantRoster(
  tools: PluginAssistantTool[],
  instructions: Map<string, string>,
  pluginNames: Map<string, string>,
): Array<{
  pluginId: string;
  name: string;
  instructions: string | null;
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> | null }>;
}> {
  const byPlugin = new Map<string, PluginAssistantTool[]>();
  for (const t of tools) {
    const list = byPlugin.get(t.pluginId) ?? [];
    list.push(t);
    byPlugin.set(t.pluginId, list);
  }
  const pluginIds = [...new Set([...byPlugin.keys(), ...instructions.keys()])].sort();
  return pluginIds.map((pluginId) => ({
    pluginId,
    name: pluginNames.get(pluginId) ?? pluginId,
    instructions: instructions.get(pluginId) ?? null,
    tools: (byPlugin.get(pluginId) ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema ?? null,
    })),
  }));
}

/** Gallery plugin entries annotated against the installed set. Read-only
 *  discovery: install/delete stays a permanent non-goal of the API, so this
 *  exists for *recommendations* — the user installs from the Extensions view. */
export function annotateGalleryPlugins(
  entries: GalleryPluginEntry[],
  pluginStates: Array<Pick<PluginState, "id" | "enabled"> & { manifest?: { version?: string } }>,
) {
  const installed = new Map(pluginStates.map((p) => [p.id, p]));
  return entries.map((e) => {
    const inst = installed.get(e.id);
    return {
      id: e.id,
      name: e.name,
      author: e.author,
      description: e.description,
      version: e.version ?? null,
      minAppVersion: e.minAppVersion ?? null,
      recommended: e.recommended === true,
      stability: stabilityTier(e.stability),
      installed: inst !== undefined,
      installedVersion: inst?.manifest?.version ?? null,
      enabled: inst?.enabled ?? null,
    };
  });
}

export function annotateGallerySkins(
  entries: GallerySkinEntry[],
  installedSkins: Array<Pick<SkinInfo, "id" | "name">>,
  activeSkinId: string,
) {
  const byId = new Set(installedSkins.map((s) => s.id));
  const byName = new Set(installedSkins.map((s) => s.name.toLowerCase()));
  return entries.map((e) => {
    const installed = byId.has(e.id) || byName.has(e.name.toLowerCase());
    return {
      id: e.id,
      name: e.name,
      author: e.author,
      type: e.type,
      version: e.version,
      recommended: e.recommended === true,
      installed,
      active: installed && e.id === activeSkinId,
    };
  });
}

export type LikeState = -1 | 0 | 1;

export function parseLikeState(value: unknown): LikeState | null {
  return value === -1 || value === 0 || value === 1 ? value : null;
}

export type PlaybackAction = "next" | "prev" | "stop";

const QUEUE_MODES: readonly QueueMode[] = ["normal", "repeat-all", "repeat-one"];

export interface PlaybackSetPayload {
  play?: boolean;
  action?: PlaybackAction;
  seekSecs?: number;
  volume?: number;
  mode?: QueueMode;
}

/** Validate the `playback.set` payload; returns the typed payload or an error
 *  string. At least one field must be present — an empty set is a caller bug
 *  worth surfacing, not a silent 200. */
export function parsePlaybackSet(payload: Record<string, unknown>): PlaybackSetPayload | string {
  const out: PlaybackSetPayload = {};
  if (payload.play !== undefined) {
    if (typeof payload.play !== "boolean") return "play must be a boolean";
    out.play = payload.play;
  }
  if (payload.action !== undefined) {
    if (payload.action !== "next" && payload.action !== "prev" && payload.action !== "stop") {
      return 'action must be "next", "prev" or "stop"';
    }
    out.action = payload.action;
  }
  if (payload.seekSecs !== undefined) {
    if (typeof payload.seekSecs !== "number" || !Number.isFinite(payload.seekSecs) || payload.seekSecs < 0) {
      return "seekSecs must be a non-negative number";
    }
    out.seekSecs = payload.seekSecs;
  }
  if (payload.volume !== undefined) {
    if (typeof payload.volume !== "number" || !Number.isFinite(payload.volume)) {
      return "volume must be a number between 0 and 1";
    }
    out.volume = clampVolume(payload.volume);
  }
  if (payload.mode !== undefined) {
    if (!QUEUE_MODES.includes(payload.mode as QueueMode)) {
      return 'mode must be "normal", "repeat-all" or "repeat-one"';
    }
    out.mode = payload.mode as QueueMode;
  }
  if (Object.keys(out).length === 0) {
    return "playback.set needs at least one of: play, action, seekSecs, volume, mode";
  }
  return out;
}
