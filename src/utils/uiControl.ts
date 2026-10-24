import type { View } from "../types";
import { isValidMode, type HeroEffectMode } from "../heroLooks";
import { SETTINGS_SECTION_IDS } from "./settingsSections";
import { MINI_RESTING_SIZES, MINI_WIDTH_SIZES, type MiniRestingSize, type MiniWidthSize } from "./miniSizes";
import type { RedactRule } from "./showcaseRedact";
import type { UiContext } from "./uiContext";

/**
 * Validation for the control API's **UI verbs** — `ui.navigate`, `ui.action`
 * and the window geometry fields — kept pure so the request contract is
 * asserted without a webview (`__tests__/uiControl.test.ts`). The dispatcher
 * (`useControlApi.ts`) turns a parsed command into calls on App's handlers.
 *
 * These verbs move what is *on screen* and nothing else: no library row, file,
 * like or setting changes through them (the exceptions, `heroLook` and the
 * window's `miniSize` / `miniWidth`, write the same preferences the
 * detail-page dropdown and the mini player's own menu write). That is why they need
 * no assistant write scope. They exist so an assistant — or
 * `scripts/capture-site-media.mjs` — can put the app on a given page with a
 * given panel open, which before this took scripted mouse clicks.
 *
 * `ui.input` (generic click / type / key, further down) is the exception to
 * all of that and is gated accordingly — see its section.
 *
 * Every parser throws `Error` with a caller-facing message; the dispatcher
 * maps that to a 400.
 */

/** Views a caller may switch to directly. Detail views (`artists`, `albums`,
 *  `tags`) are reached by naming the entity instead — they mean nothing
 *  without a selection. `library` is accepted as an alias for `search`, which
 *  is what the Library view is called internally. */
export const NAVIGABLE_VIEWS = [
  "home", "search", "history", "nowplaying", "playlists", "collections", "extensions", "settings",
] as const satisfies readonly View[];

export type NavigableView = (typeof NAVIGABLE_VIEWS)[number];

export type NavigateTarget =
  | { kind: "view"; view: NavigableView }
  | { kind: "artist"; name: string }
  | { kind: "album"; name: string; artistName?: string }
  | { kind: "tag"; name: string }
  | { kind: "track"; title: string; artistName?: string; albumTitle?: string }
  | { kind: "settings"; section?: string }
  | { kind: "plugin"; pluginId: string; viewId: string; query?: string };

const TARGET_KEYS = ["view", "artist", "album", "tag", "track", "settings", "pluginView"] as const;

function str(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function optStr(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return str(value, field);
}

/** Parse a `ui.navigate` body. Exactly one target key — a request can only
 *  land on one page, and silently picking one of several would hide a bug in
 *  the caller. */
export function parseNavigateTarget(payload: Record<string, unknown>): NavigateTarget {
  const present = TARGET_KEYS.filter((k) => payload[k] !== undefined);
  if (present.length !== 1) {
    throw new Error(`navigate needs exactly one of: ${TARGET_KEYS.join(", ")}`);
  }
  const key = present[0];
  switch (key) {
    case "view": {
      const raw = str(payload.view, "view").toLowerCase();
      const view = raw === "library" ? "search" : raw;
      if (!(NAVIGABLE_VIEWS as readonly string[]).includes(view)) {
        throw new Error(`view must be one of: library, ${NAVIGABLE_VIEWS.join(", ")} (open artists/albums/tags by name)`);
      }
      return { kind: "view", view: view as NavigableView };
    }
    case "artist":
      return { kind: "artist", name: str(payload.artist, "artist") };
    case "album": {
      const artistName = optStr(payload.artistName, "artistName");
      return { kind: "album", name: str(payload.album, "album"), ...(artistName ? { artistName } : {}) };
    }
    case "tag":
      return { kind: "tag", name: str(payload.tag, "tag") };
    case "track": {
      const artistName = optStr(payload.artistName, "artistName");
      const albumTitle = optStr(payload.albumTitle, "albumTitle");
      return {
        kind: "track",
        title: str(payload.track, "track"),
        ...(artistName ? { artistName } : {}),
        ...(albumTitle ? { albumTitle } : {}),
      };
    }
    case "settings": {
      if (payload.settings === true) return { kind: "settings" };
      const section = str(payload.settings, "settings");
      if (!SETTINGS_SECTION_IDS.includes(section)) {
        throw new Error(`settings must be true or one of: ${SETTINGS_SECTION_IDS.join(", ")}`);
      }
      return { kind: "settings", section };
    }
    case "pluginView": {
      const pv = payload.pluginView;
      if (typeof pv !== "object" || pv === null || Array.isArray(pv)) {
        throw new Error("pluginView must be an object: { pluginId, viewId, query? }");
      }
      const o = pv as Record<string, unknown>;
      const query = optStr(o.query, "pluginView.query");
      return {
        kind: "plugin",
        pluginId: str(o.pluginId, "pluginView.pluginId"),
        viewId: str(o.viewId, "pluginView.viewId"),
        ...(query ? { query } : {}),
      };
    }
  }
}

export type UiAction =
  | { action: "queuePanel"; open: boolean }
  | { action: "nowPlayingAbout"; open: boolean }
  | { action: "nowPlayingLyrics"; open: boolean }
  | { action: "eqPanel"; open: boolean }
  | { action: "bitPerfect"; on: boolean }
  | { action: "bitPerfectConfirm" }
  | { action: "heroLook"; look: HeroEffectMode }
  | { action: "showcase"; on: boolean; redact: RedactRule[] }
  | { action: "bulkEdit"; trackIds: number[] }
  | { action: "download" }
  | { action: "closeModals" }
  | { action: "search"; query: string }
  | { action: "scroll"; to: "top" | "bottom" | number; smooth: boolean };

export const UI_ACTIONS = [
  "queuePanel", "nowPlayingAbout", "nowPlayingLyrics", "eqPanel", "bitPerfect", "bitPerfectConfirm",
  "heroLook", "showcase", "bulkEdit", "download", "closeModals", "search", "scroll",
] as const;

function bool(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

/** Parse a `ui.action` body: `{ action, ...fields }`. */
export function parseUiAction(payload: Record<string, unknown>): UiAction {
  const action = payload.action;
  switch (action) {
    case "queuePanel":
    case "nowPlayingAbout":
    case "nowPlayingLyrics":
    case "eqPanel":
      return { action, open: bool(payload.open, "open") };
    case "bitPerfect":
      return { action, on: bool(payload.on, "on") };
    case "showcase":
      return { action, on: bool(payload.on, "on"), redact: parseRedact(payload.redact) };
    case "bitPerfectConfirm":
    case "download":
    case "closeModals":
      return { action };
    case "search": {
      // The central search box with this text typed — results open as the
      // user would see them. An empty query closes it.
      if (typeof payload.query !== "string") throw new Error("query must be a string");
      return { action, query: payload.query };
    }
    case "heroLook": {
      if (!isValidMode(payload.look)) {
        throw new Error("look must be disabled, random, by-artist or a look id (late-night, silent-film, daydream, broadcast, aurora-drift, light-leak, prism-bloom, minimal)");
      }
      return { action, look: payload.look };
    }
    case "bulkEdit": {
      const ids = payload.trackIds;
      if (!Array.isArray(ids) || ids.length === 0 || !ids.every((n) => Number.isInteger(n) && n > 0)) {
        throw new Error("trackIds must be a non-empty array of library track ids");
      }
      return { action, trackIds: ids as number[] };
    }
    case "scroll": {
      const to = payload.to;
      if (to !== "top" && to !== "bottom" && !(typeof to === "number" && Number.isFinite(to) && to >= 0)) {
        throw new Error('to must be "top", "bottom" or a pixel offset >= 0');
      }
      const smooth = payload.smooth === undefined ? false : bool(payload.smooth, "smooth");
      return { action, to, smooth };
    }
    default:
      throw new Error(`action must be one of: ${UI_ACTIONS.join(", ")}`);
  }
}

// --- Generic input (`ui.query` / `ui.input`) ---
//
// Unlike everything above, `ui.input` can do whatever a person can do by
// clicking, so it sits behind its own assistant scope ("Click and type",
// checked in Rust) — and the webview refuses it on the surfaces that grant
// trust (`INPUT_PROTECTED_MODALS`, plus `data-ui-input-protected` regions:
// Settings → AI control and the Extensions view). The DOM half — finding
// elements, dispatching events, the cursor — is `utils/uiInput.ts`.

/** What a target may be. `any` = every kind below. */
export const UI_TARGET_ROLES = ["any", "button", "field", "checkbox", "link", "tab", "option"] as const;
export type UiTargetRole = (typeof UI_TARGET_ROLES)[number];

/** An element, named the way a person would: by role + accessible name
 *  (aria-label, label, text), or by `data-testid` for things with no name.
 *  `index` picks one of several equal matches (0-based, in document order). */
export interface UiTarget {
  testId?: string;
  role: UiTargetRole;
  name?: string;
  index?: number;
}

export interface KeyCombo {
  /** `KeyboardEvent.key` */
  key: string;
  /** `KeyboardEvent.code`, "" when the key has none worth naming. */
  code: string;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

export type UiInput =
  | { kind: "click"; target: UiTarget; moveMs: number }
  | { kind: "type"; target: UiTarget; text: string; replace: boolean; charMs: number; moveMs: number }
  | { kind: "key"; keys: KeyCombo };

export interface UiQuery {
  target: UiTarget;
  limit: number;
}

export const UI_INPUT_KINDS = ["click", "type", "key"] as const;
/** Longest text one `type` may enter. */
export const MAX_TYPE_TEXT = 500;
/** The typing budget: `text.length × charMs` must fit in it, because the HTTP
 *  bridge waits 30s and the cursor glide comes on top. */
export const MAX_TYPE_DURATION_MS = 15000;
export const DEFAULT_CHAR_MS = 40;
export const MAX_CHAR_MS = 200;
export const DEFAULT_MOVE_MS = 400;
export const MAX_MOVE_MS = 2000;
export const DEFAULT_QUERY_LIMIT = 20;
export const MAX_QUERY_LIMIT = 100;

/** Dialogs that grant trust — installs, permissions, programs, the setup
 *  wizard (it installs plugins). While one is open, no input is delivered at
 *  all: the user's click there is the consent, and a click the assistant
 *  makes must never stand in for it. Names as `GET /v1/ui` reports them. */
export const INPUT_PROTECTED_MODALS = [
  "onboarding",
  "extension-install",
  "plugin-permissions",
  "unsigned-programs",
  "program-install",
  "program-run",
  "tool-install",
  "tool-definition-consent",
  "tool-unverified",
] as const;

/** The refusal for the open modals, or null when input may proceed. */
export function inputBlockedByModals(modals: readonly string[]): string | null {
  const open = modals.find((m) => (INPUT_PROTECTED_MODALS as readonly string[]).includes(m));
  return open
    ? `the "${open}" dialog is open — it asks the user for consent, so only the user can answer it`
    : null;
}

function intIn(value: unknown, field: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${field} must be an integer from ${min} to ${max}`);
  }
  return value as number;
}

/** Parse a target. `requireOne` (click/type) wants something to find; a
 *  query may name only a role, to list what is on screen. */
export function parseUiTarget(value: unknown, requireOne: boolean): UiTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("target must be an object: { name, role? } or { testId }");
  }
  const t = value as Record<string, unknown>;
  const role = t.role === undefined ? "any" : t.role;
  if (!(UI_TARGET_ROLES as readonly unknown[]).includes(role)) {
    throw new Error(`target.role must be one of: ${UI_TARGET_ROLES.join(", ")}`);
  }
  const out: UiTarget = { role: role as UiTargetRole };
  const testId = optStr(t.testId, "target.testId");
  const name = optStr(t.name, "target.name");
  if (testId) out.testId = testId;
  if (name) out.name = name;
  if (requireOne && !testId && !name) throw new Error("target needs a name or a testId");
  if (t.index !== undefined) out.index = intIn(t.index, "target.index", 0, 999, 0);
  return out;
}

const NAMED_KEYS: Record<string, string> = {
  enter: "Enter", return: "Enter", escape: "Escape", esc: "Escape", tab: "Tab",
  backspace: "Backspace", delete: "Delete", space: " ", arrowup: "ArrowUp", up: "ArrowUp",
  arrowdown: "ArrowDown", down: "ArrowDown", arrowleft: "ArrowLeft", left: "ArrowLeft",
  arrowright: "ArrowRight", right: "ArrowRight", home: "Home", end: "End",
  pageup: "PageUp", pagedown: "PageDown",
};

/** `KeyboardEvent.code` for a key: letters and digits by position, named keys
 *  by name, punctuation left empty (no handler here reads it). */
function keyCode(key: string): string {
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  if (key === " ") return "Space";
  if (key.length > 1) return key;
  return "";
}

/**
 * Parse a chord like `"Mod+K"`, `"Shift+Tab"`, `"Escape"`. `Mod` (or
 * `CmdOrCtrl`) is Cmd on macOS and Ctrl elsewhere, so one request works on
 * both — the in-app shortcuts accept either.
 */
export function parseKeyCombo(value: unknown, isMac: boolean): KeyCombo {
  if (typeof value !== "string" || value.trim() === "") throw new Error('keys must be a chord such as "Mod+K" or "Escape"');
  const parts = value.split("+").map((p) => p.trim());
  // "Mod++" means the plus key itself.
  if (parts.length > 1 && parts[parts.length - 1] === "" && parts[parts.length - 2] === "") parts.splice(-2, 2, "+");
  const last = parts.pop() ?? "";
  const combo: KeyCombo = { key: "", code: "", meta: false, ctrl: false, alt: false, shift: false };
  for (const raw of parts) {
    switch (raw.toLowerCase()) {
      case "mod": case "cmdorctrl":
        if (isMac) combo.meta = true; else combo.ctrl = true;
        break;
      case "meta": case "cmd": case "command": combo.meta = true; break;
      case "ctrl": case "control": combo.ctrl = true; break;
      case "alt": case "option": case "opt": combo.alt = true; break;
      case "shift": combo.shift = true; break;
      default: throw new Error(`unknown modifier "${raw}" — use Mod, Cmd, Ctrl, Alt or Shift`);
    }
  }
  const named = NAMED_KEYS[last.toLowerCase()];
  if (named) combo.key = named;
  else if (/^f([1-9]|1[0-2])$/i.test(last)) combo.key = last.toUpperCase();
  // A letter reports lower case unless Shift is held, as a real press does —
  // "Mod+K" must arrive as key "k", which is what the shortcut handler sees.
  else if (/^[a-z]$/i.test(last)) combo.key = combo.shift ? last.toUpperCase() : last.toLowerCase();
  else if ([...last].length === 1) combo.key = last;
  else throw new Error(`unknown key "${last}"`);
  combo.code = keyCode(combo.key);
  return combo;
}

/** Parse a `ui.input` body. */
export function parseUiInput(payload: Record<string, unknown>, isMac: boolean): UiInput {
  const kind = payload.kind;
  switch (kind) {
    case "click":
      return { kind, target: parseUiTarget(payload.target, true), moveMs: intIn(payload.moveMs, "moveMs", 0, MAX_MOVE_MS, DEFAULT_MOVE_MS) };
    case "type": {
      if (typeof payload.text !== "string") throw new Error("text must be a string");
      const text = payload.text;
      if ([...text].length > MAX_TYPE_TEXT) throw new Error(`text may be at most ${MAX_TYPE_TEXT} characters`);
      const charMs = intIn(payload.charMs, "charMs", 0, MAX_CHAR_MS, DEFAULT_CHAR_MS);
      if ([...text].length * charMs > MAX_TYPE_DURATION_MS) {
        throw new Error(`typing would take over ${MAX_TYPE_DURATION_MS / 1000}s — lower charMs or send less text`);
      }
      if (payload.replace !== undefined && typeof payload.replace !== "boolean") throw new Error("replace must be a boolean");
      return {
        kind, target: parseUiTarget(payload.target, true), text, charMs,
        replace: payload.replace === true,
        moveMs: intIn(payload.moveMs, "moveMs", 0, MAX_MOVE_MS, DEFAULT_MOVE_MS),
      };
    }
    case "key":
      return { kind, keys: parseKeyCombo(payload.keys, isMac) };
    default:
      throw new Error(`kind must be one of: ${UI_INPUT_KINDS.join(", ")}`);
  }
}

/** Parse a `ui.query` body: a target (role alone lists that role's named
 *  elements on screen) and how many matches to return. */
export function parseUiQuery(payload: Record<string, unknown>): UiQuery {
  return {
    target: parseUiTarget(payload.target ?? {}, false),
    limit: intIn(payload.limit, "limit", 1, MAX_QUERY_LIMIT, DEFAULT_QUERY_LIMIT),
  };
}

/** Most rules a showcase accepts — redaction walks every text node per rule. */
export const MAX_REDACT_RULES = 20;
/** Shortest text a rule may match: anything shorter would hit ordinary words. */
export const MIN_REDACT_TEXT = 3;

/**
 * `showcase.redact`: strings to hide while showcase is on — a user name in a
 * plugin header, a personal playlist title. Each entry is a string (replaced
 * with `•••`) or `{ text, replacement }`. Absent means none.
 */
export function parseRedact(value: unknown): RedactRule[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("redact must be an array of strings or { text, replacement } objects");
  if (value.length > MAX_REDACT_RULES) throw new Error(`redact takes at most ${MAX_REDACT_RULES} entries`);
  return value.map((entry, i) => {
    const rule = typeof entry === "string" ? { text: entry, replacement: undefined }
      : entry && typeof entry === "object" ? entry as Record<string, unknown>
      : null;
    if (!rule || typeof rule.text !== "string") throw new Error(`redact[${i}] must be a string or { text, replacement }`);
    if (rule.text.trim().length < MIN_REDACT_TEXT) throw new Error(`redact[${i}] must be at least ${MIN_REDACT_TEXT} characters`);
    if (rule.replacement !== undefined && typeof rule.replacement !== "string") {
      throw new Error(`redact[${i}].replacement must be a string`);
    }
    return { text: rule.text, replacement: rule.replacement ?? "•••" };
  });
}

export interface MiniSizes {
  miniSize?: MiniRestingSize;
  miniWidth?: MiniWidthSize;
}

/** The mini-player half of `window.set`: resting layout and width preset.
 *  Either may be given alone; both persist like the mini player's own menu. */
export function parseMiniSizes(payload: Record<string, unknown>): MiniSizes | null {
  const out: MiniSizes = {};
  if (payload.miniSize !== undefined) {
    if (!(MINI_RESTING_SIZES as readonly unknown[]).includes(payload.miniSize)) {
      throw new Error(`miniSize must be one of: ${MINI_RESTING_SIZES.join(", ")}`);
    }
    out.miniSize = payload.miniSize as MiniRestingSize;
  }
  if (payload.miniWidth !== undefined) {
    if (!(MINI_WIDTH_SIZES as readonly unknown[]).includes(payload.miniWidth)) {
      throw new Error(`miniWidth must be one of: ${MINI_WIDTH_SIZES.join(", ")}`);
    }
    out.miniWidth = payload.miniWidth as MiniWidthSize;
  }
  return out.miniSize || out.miniWidth ? out : null;
}

export interface WindowGeometry {
  width?: number;
  height?: number;
  x?: number;
  y?: number;
}

/** Smallest window the main layout survives (sidebar + content + bar). */
export const MIN_WINDOW_WIDTH = 640;
export const MIN_WINDOW_HEIGHT = 400;

/**
 * The geometry half of `window.set`, in **logical** pixels (what the OS and
 * every screenshot tool's points mean). Size and position travel as pairs: a
 * lone `width` would leave the caller guessing what height it gets.
 */
export function parseWindowGeometry(payload: Record<string, unknown>): WindowGeometry | null {
  const has = (k: string) => payload[k] !== undefined;
  if (!has("width") && !has("height") && !has("x") && !has("y")) return null;
  if (has("width") !== has("height")) throw new Error("width and height must be given together");
  if (has("x") !== has("y")) throw new Error("x and y must be given together");
  const out: WindowGeometry = {};
  if (has("width")) {
    const w = payload.width, h = payload.height;
    if (!Number.isInteger(w) || !Number.isInteger(h)) throw new Error("width and height must be integers");
    if ((w as number) < MIN_WINDOW_WIDTH || (h as number) < MIN_WINDOW_HEIGHT) {
      throw new Error(`window must be at least ${MIN_WINDOW_WIDTH}x${MIN_WINDOW_HEIGHT}`);
    }
    out.width = w as number;
    out.height = h as number;
  }
  if (has("x")) {
    const x = payload.x, y = payload.y;
    if (!Number.isInteger(x) || !Number.isInteger(y)) throw new Error("x and y must be integers");
    out.x = x as number;
    out.y = y as number;
  }
  return out;
}

export interface UiStateInput {
  view: string;
  /** Library ids of the open detail page's entity (null = none open). */
  selectedArtistId: number | null;
  selectedAlbumId: number | null;
  selectedTagId: number | null;
  /** The open track page: `lib:<id>` for a library row, `entry:<key>` for
   *  an id-less queue entry. */
  selectedTrack: string | null;
  settingsSection: string | null;
  queueCollapsed: boolean;
  nowPlayingAbout: boolean;
  lyricsHidden: boolean;
  eqPanel: boolean;
  modals: string[];
  showcase: boolean;
  heroLook: HeroEffectMode;
  bitPerfect: { on: boolean; tone: string } | null;
  /** What the user is looking at — the same answer plugins get (utils/uiContext.ts). */
  context: UiContext;
}

/** The `GET /v1/ui` snapshot. A capture script polls it to know the page it
 *  asked for has actually landed before taking a picture. `context` is what a
 *  plugin's `api.ui.getContext()` returns, by name. */
export function buildUiState(input: UiStateInput) {
  return {
    view: input.view,
    selection: {
      artistId: input.selectedArtistId,
      albumId: input.selectedAlbumId,
      tagId: input.selectedTagId,
      track: input.selectedTrack,
    },
    settingsSection: input.settingsSection,
    panels: {
      queueCollapsed: input.queueCollapsed,
      nowPlayingAbout: input.nowPlayingAbout,
      lyricsHidden: input.lyricsHidden,
      eqPanel: input.eqPanel,
    },
    modals: input.modals,
    showcase: input.showcase,
    heroLook: input.heroLook,
    bitPerfect: input.bitPerfect,
    context: input.context,
  };
}
