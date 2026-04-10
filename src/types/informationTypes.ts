// Information Type system types

export type InfoEntityKind = "artist" | "album" | "track" | "tag";

export type InfoStatus = "ok" | "not_found" | "error";

export type DisplayKind =
  | "rich_text"
  | "html"
  | "entity_list"
  | "entity_cards"
  | "stat_grid"
  | "lyrics"
  | "tag_list"
  | "ranked_list"
  | "annotated_text"
  | "annotations"
  | "key_value"
  | "image_gallery"
  | "title_line";

/** Declared in plugin manifest contributes.informationTypes */
export interface InfoTypeDeclaration {
  id: string;
  name: string;
  entity: InfoEntityKind;
  displayKind: DisplayKind;
  ttl: number;
  order: number;
  priority: number;
}

/** Entity passed to plugin onFetch handlers */
export interface InfoEntity {
  kind: InfoEntityKind;
  name: string;
  id: number;
  artistName?: string;
  albumTitle?: string;
}

/** Result returned by plugin onFetch handlers */
export type InfoFetchResult =
  | { status: "ok"; value: Record<string, unknown> }
  | { status: "not_found" }
  | { status: "error" };

/** Provider in a fallback chain */
export interface InfoProvider {
  pluginId: string;
  integerId: number;
}

/** Registered info type with provider chain (from DB, grouped by type_id) */
export interface RegisteredInfoType {
  typeId: string;
  name: string;
  displayKind: DisplayKind;
  ttl: number;
  sortOrder: number;
  providers: InfoProvider[];
}

/** Cached info value (from DB) */
export interface CachedInfoValue {
  integerId: number;
  typeId: string;
  value: string;
  status: InfoStatus;
  fetchedAt: number;
}

/** Progress entry during fetch chain */
export interface FetchProgressEntry {
  provider: string;
  url?: string;
  status?: "fetching" | "ok" | "not_found" | "error";
}

/** Resolved section state for rendering */
export interface InfoSection {
  typeId: string;
  name: string;
  displayKind: DisplayKind;
  state:
    | { kind: "loaded"; data: unknown; stale: boolean }
    | { kind: "loading"; progress?: FetchProgressEntry[] }
    | { kind: "empty" };
}

// ── Display Kind Schemas ──────────────────────────────────

export interface RichTextData {
  summary: string;
  full?: string;
}

export interface HtmlData {
  content: string;
}

export interface EntityListItem {
  name: string;
  subtitle?: string;
  match?: number;
  image?: string;
  url?: string;
  libraryId?: number;
  libraryKind?: "track" | "artist" | "album";
}

export interface EntityListData {
  items: EntityListItem[];
}

export interface StatGridItem {
  label: string;
  value: string | number;
  unit?: string;
}

export interface StatGridData {
  items: StatGridItem[];
}

export interface LyricsData {
  text: string;
  kind: "plain" | "synced";
  lines?: Array<{ time: number; text: string }>;
}

export interface TagListData {
  tags: Array<{ name: string; url?: string }>;
  suggestable?: boolean;
}

export interface RankedListItem {
  name: string;
  subtitle?: string;
  value: number;
  maxValue?: number;
  libraryId?: number;
  libraryKind?: "track" | "artist" | "album";
}

export interface RankedListData {
  items: RankedListItem[];
}

export interface AnnotatedTextData {
  overview?: string;
  sections: Array<{ heading?: string; text: string }>;
}

export interface AnnotationsData {
  overview?: string;
  annotations: Array<{ fragment: string; explanation: string }>;
}

export interface KeyValueData {
  items: Array<{ key: string; value: string }>;
}

export interface ImageGalleryImage {
  url: string;
  caption?: string;
  source?: string;
}

export interface ImageGalleryData {
  images: ImageGalleryImage[];
}

export interface TitleLineItem {
  label: string;
  value: string | number;
}

export interface TitleLineData {
  items: TitleLineItem[];
}

// ── Placement ────────────────────────────────────────────────

export type InfoPlacement = "below" | "right";

const RIGHT_DISPLAY_KINDS: ReadonlySet<DisplayKind> = new Set([
  "ranked_list",
  "tag_list",
  "image_gallery",
]);

export function getInfoPlacement(displayKind: DisplayKind): InfoPlacement {
  return RIGHT_DISPLAY_KINDS.has(displayKind) ? "right" : "below";
}

/** Build a name-based entity key (decoupled from library IDs) */
export function buildEntityKey(entity: InfoEntity): string {
  switch (entity.kind) {
    case "artist": return `artist:${entity.name}`;
    case "album":  return `album:${entity.artistName ?? ""}:${entity.name}`;
    case "track":  return `track:${entity.artistName ?? ""}:${entity.name}`;
    case "tag":    return `tag:${entity.name}`;
  }
}
