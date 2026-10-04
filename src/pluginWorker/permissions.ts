// Permission vocabulary for worker-runtime plugins, and the gate the host
// bridge runs before forwarding any API call.
//
// A permission is a flat string so the consent UI can list it verbatim:
//
//   network:<host>     api.network.fetch / storage.cacheFile / storage.files.download
//   browse:<host>      api.network.openBrowseWindow
//   exec:<binary>      api.system.exec
//   library:read       reading tracks / albums / tags / history / likes / playlists
//   library:write      tags, likes, history import, file metadata, playlists, resync
//   files:read         reading embedded tags off local files
//   files:trash        moving a local file to the trash
//   playback:read      current track, position, queue, and playback events
//   playback:control   starting playback or changing the queue
//   system:open        opening URLs / files / folders with the OS
//   env:<NAME>         reading one environment variable
//   plugins:call       reaching other plugins (search, assistant tools, info chain)
//   assistant:host     the app's own assistant tools (api.assistant.host): the
//                      MCP catalog, gated again by the AI-control switches
//
// <host> is an exact hostname, "*.example.com" (subdomains only — list the apex
// separately), or "*" for any host.
//
// The table is fail-closed: a method missing from it is denied, so adding an API
// method without deciding its permission cannot silently widen what an
// unprivileged plugin can do. Methods scoped to the plugin itself (its own
// storage, its own registrations, its own UI) need no permission.

export type PermissionCheck = (args: unknown[]) => string | null;

const OWN = null;
const need = (perm: string): PermissionCheck => () => perm;
const byUrl = (prefix: string, argIndex: number): PermissionCheck => (args) => {
  const raw = args[argIndex];
  let host: string;
  try {
    const u = new URL(String(raw));
    if (u.protocol !== "https:" && u.protocol !== "http:") return `${prefix}:<non-http url>`;
    host = u.hostname.toLowerCase();
  } catch {
    return `${prefix}:<invalid url>`;
  }
  return `${prefix}:${host}`;
};

/** api path → what it needs. `null` = scoped to the plugin itself, always allowed. */
export const PERMISSION_TABLE: Record<string, PermissionCheck | null> = {
  "log": OWN,

  "library.getTrackCount": need("library:read"),
  "library.getTracks": need("library:read"),
  "library.ftsTracks": need("library:read"),
  "library.ftsArtists": need("library:read"),
  "library.ftsAlbums": need("library:read"),
  "library.ftsTags": need("library:read"),
  "library.getArtists": need("library:read"),
  "library.getAlbums": need("library:read"),
  "library.getTags": need("library:read"),
  "library.getTrackById": need("library:read"),
  "library.getArtistById": need("library:read"),
  "library.getAlbumById": need("library:read"),
  "library.getTagById": need("library:read"),
  "library.getHistory": need("library:read"),
  "library.getHistoryPlayCount": need("library:read"),
  "library.getHistoryPlaysPage": need("library:read"),
  "library.getMostPlayed": need("library:read"),
  "library.getMostPlayedArtists": need("library:read"),
  "library.findDuplicates": need("library:read"),
  "library.getTrackLikeStates": need("library:read"),
  "library.onTrackAdded": need("library:read"),
  "library.onTrackRemoved": need("library:read"),
  "library.onScanComplete": need("library:read"),
  "library.recordHistoryPlaysBatch": need("library:write"),
  "library.applyTags": need("library:write"),
  "library.applyTagsBulk": need("library:write"),
  "library.removeTags": need("library:write"),
  "library.bulkUpdateTracks": need("library:write"),
  // Gated twice: the permission, then the host's own Replace dialog per call.
  "library.replaceTrackFile": need("library:write"),
  "library.setTrackLikesBatch": need("library:write"),

  "playback.getCurrentTrack": need("playback:read"),
  "playback.isPlaying": need("playback:read"),
  "playback.getPosition": need("playback:read"),
  "playback.getQueue": need("playback:read"),
  "playback.onQueueChanged": need("playback:read"),
  "playback.onTrackStarted": need("playback:read"),
  "playback.onTrackScrobbled": need("playback:read"),
  "playback.onTrackLiked": need("playback:read"),
  "playback.playTrack": need("playback:control"),
  "playback.playTracks": need("playback:control"),
  "playback.insertTrack": need("playback:control"),
  "playback.insertTracks": need("playback:control"),
  "playback.playWithBackfill": need("playback:control"),
  "playback.onStreamResolve": OWN,
  "playback.onResolveStreamByUri": OWN,
  "playback.onResolveStoryboard": OWN,

  "collections.getLocalCollections": need("library:read"),
  "collections.resync": need("library:write"),
  "collections.trashPath": need("files:trash"),

  "contextMenu.onAction": OWN,
  "contextMenu.registerItem": OWN,
  "contextMenu.unregisterItem": OWN,

  "ui.setViewData": OWN,
  "ui.showNotification": OWN,
  "ui.onAction": OWN,
  "ui.navigateToView": OWN,
  "ui.requestAction": OWN,
  "ui.setBadge": OWN,
  "ui.setViewHeader": OWN,

  "storage.get": OWN,
  "storage.set": OWN,
  "storage.delete": OWN,
  "storage.cacheFile": byUrl("network", 2),
  "storage.getCachePath": OWN,
  "storage.listCacheDirs": OWN,
  "storage.deleteCacheDir": OWN,
  "storage.files.writeJson": OWN,
  "storage.files.readJson": OWN,
  "storage.files.writeText": OWN,
  "storage.files.readText": OWN,
  "storage.files.download": byUrl("network", 1),
  "storage.files.getPath": OWN,
  "storage.files.exists": OWN,
  "storage.files.list": OWN,
  "storage.files.remove": OWN,
  "storage.files.copy": OWN,
  "storage.files.move": OWN,

  "network.fetch": byUrl("network", 0),
  "network.openUrl": need("system:open"),
  "network.onDeepLink": OWN,
  "network.openBrowseWindow": byUrl("browse", 0),

  "informationTypes.onFetch": OWN,
  "informationTypes.searchValues": need("library:read"),
  "informationTypes.getValuesForEntity": need("library:read"),
  "informationTypes.getValue": need("library:read"),
  "informationTypes.fetch": need("plugins:call"),

  "home.onFetchShelf": OWN,
  "home.registerShelf": OWN,
  "home.unregisterShelf": OWN,
  "home.onItemClick": OWN,
  "home.onResolvePlay": OWN,

  "search.onQuery": OWN,
  "search.registerProvider": OWN,
  "search.unregisterProvider": OWN,
  "search.listProviders": need("plugins:call"),
  "search.query": need("plugins:call"),

  "plugins.list": need("plugins:call"),

  "assistant.registerTool": OWN,
  "assistant.unregisterTool": OWN,
  "assistant.onTool": OWN,
  "assistant.setInstructions": OWN,
  "assistant.listTools": need("plugins:call"),
  "assistant.invoke": need("plugins:call"),
  "assistant.host.listTools": need("assistant:host"),
  "assistant.host.instructions": need("assistant:host"),
  "assistant.host.invoke": need("assistant:host"),

  "nowPlayingInfo.registerItem": OWN,
  "nowPlayingInfo.unregisterItem": OWN,
  "nowPlayingInfo.onFetch": OWN,

  "imageProviders.onFetch": OWN,

  "downloads.reportProgress": OWN,
  "downloads.onResolveByUri": OWN,
  "downloads.onResolveByMetadata": OWN,
  "downloads.onInteractiveSearch": OWN,
  "downloads.onInteractiveResolve": OWN,
  "downloads.onGetQualities": OWN,

  "playlists.save": need("library:write"),
  "playlists.list": need("library:read"),
  "playlists.delete": need("library:write"),
  "playlists.getTracks": need("library:read"),

  "scheduler.register": OWN,
  "scheduler.unregister": OWN,
  "scheduler.complete": OWN,
  "scheduler.onDue": OWN,

  "system.exec": (args) => `exec:${String(args[0])}`,
  "system.getDependency": OWN,
  "system.readAudioTags": need("files:read"),
  "system.openPath": need("system:open"),
  "system.revealPath": need("system:open"),

  "env.get": (args) => `env:${String(args[0])}`,
};

function hostMatches(pattern: string, host: string): boolean {
  if (pattern === "*") return true;
  if (pattern.startsWith("*.")) return host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1;
  return pattern === host;
}

/** Does the granted set cover `required`? Host-scoped kinds match by pattern. */
export function isGranted(granted: readonly string[], required: string): boolean {
  const colon = required.indexOf(":");
  const kind = colon === -1 ? required : required.slice(0, colon);
  if (kind === "network" || kind === "browse") {
    const host = required.slice(colon + 1);
    if (host.startsWith("<")) return false; // invalid / non-http URL: never grantable
    return granted.some((g) => g.startsWith(`${kind}:`) && hostMatches(g.slice(kind.length + 1).toLowerCase(), host));
  }
  return granted.includes(required);
}

/** How a permission is shown to the user when they're asked to approve it. */
export interface PermissionDescription {
  label: string;
  detail: string;
  /** Worth a second look: reaches outside the app, or changes the user's data. */
  sensitive: boolean;
}

function hostLabel(host: string): string {
  if (host === "*") return "any website";
  if (host.startsWith("*.")) return `any ${host.slice(2)} address`;
  return host;
}

/** Plain-language description of one permission, for the consent UI. */
export function describePermission(perm: string): PermissionDescription {
  const colon = perm.indexOf(":");
  const kind = colon === -1 ? perm : perm.slice(0, colon);
  const arg = colon === -1 ? "" : perm.slice(colon + 1);
  switch (kind) {
    case "network":
      return {
        label: `Connect to ${hostLabel(arg)}`,
        detail: "Send requests to this site and read its answers.",
        sensitive: arg === "*",
      };
    case "browse":
      return {
        label: `Open browser windows on ${hostLabel(arg)}`,
        detail: "Load pages there and run scripts inside them, including sites you're signed in to.",
        sensitive: true,
      };
    case "exec":
      return { label: `Run ${arg}`, detail: "Start this program on your computer.", sensitive: true };
    case "env":
      if (arg) {
        return { label: `Read the ${arg} environment variable`, detail: "Environment variables can hold secrets such as API keys.", sensitive: true };
      }
      break;
  }
  switch (perm) {
    case "library:read":
      return { label: "Read your library", detail: "Tracks, albums, artists, tags, play history, likes and playlists.", sensitive: false };
    case "library:write":
      return { label: "Change your library", detail: "Edit tags and file metadata, likes, play history and playlists.", sensitive: true };
    case "files:read":
      return { label: "Read tags from your music files", detail: "Title, artist, album and similar fields.", sensitive: false };
    case "files:trash":
      return { label: "Move files to the trash", detail: "Only files inside your local collections.", sensitive: true };
    case "playback:read":
      return { label: "See what's playing", detail: "The current track, playback position and queue.", sensitive: false };
    case "playback:control":
      return { label: "Control playback", detail: "Start playing and change the queue.", sensitive: false };
    case "system:open":
      return { label: "Open links and files", detail: "Hand them to your browser or other apps.", sensitive: false };
    case "plugins:call":
      return { label: "Use your other plugins", detail: "Their searches, tools and information.", sensitive: false };
    case "assistant:host":
      return {
        label: "Control Viboplr like an AI assistant",
        detail: "Use the tools an AI assistant gets when AI control is on. Changes still need the switches you've turned on in Settings → AI control.",
        sensitive: true,
      };
  }
  return { label: perm, detail: "Not recognised by this version of Viboplr, so it grants nothing.", sensitive: false };
}

/**
 * What the plugin asks for that the user hasn't approved yet. A worker plugin
 * runs only when this is empty — see the approval gate in usePlugins. The
 * manifest is the ceiling: an approval left over from an older version that
 * asked for more grants nothing beyond what the current manifest requests.
 */
export function pendingPermissions(requested: readonly string[], approved: readonly string[]): string[] {
  const ok = new Set(approved);
  return Array.from(new Set(requested)).filter((p) => !ok.has(p));
}

/**
 * The host patterns a grant's `network:` permissions cover, for the Rust side
 * (`plugin_worker::NetworkScope`), which holds every redirect hop to them — the
 * gate here only ever sees the URL the plugin asked for.
 */
export function networkHosts(granted: readonly string[]): string[] {
  return granted.filter((g) => g.startsWith("network:")).map((g) => g.slice("network:".length).toLowerCase());
}

export class PermissionError extends Error {
  constructor(readonly pluginId: string, readonly path: string, readonly required: string) {
    super(`Permission denied: plugin "${pluginId}" needs "${required}" to call api.${path} — declare it in manifest.permissions`);
    this.name = "PermissionError";
  }
}

/** Throws `PermissionError` unless `granted` allows calling `path` with `args`. */
export function checkPermission(pluginId: string, granted: readonly string[], path: string, args: unknown[]): void {
  if (!(path in PERMISSION_TABLE)) {
    throw new PermissionError(pluginId, path, `<no permission defined for api.${path}>`);
  }
  const check = PERMISSION_TABLE[path];
  if (check === null) return;
  const required = check(args);
  if (required !== null && !isGranted(granted, required)) {
    throw new PermissionError(pluginId, path, required);
  }
}
