// Information Type system types

export type InfoEntityKind = "artist" | "album" | "track" | "tag";

export type InfoStatus = "ok" | "not_found" | "error";

export type DisplayKind =
  | "rich_text"
  | "html"
  | "entity_list"
  | "stat_grid"
  | "lyrics"
  | "tag_list"
  | "ranked_list"
  | "annotated_text"
  | "key_value"
  | "image_gallery";

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

/** Registered info type (from DB, includes plugin_id) */
export interface RegisteredInfoType {
  id: string;
  name: string;
  displayKind: DisplayKind;
  pluginId: string;
  ttl: number;
  sortOrder: number;
  priority: number;
}

/** Cached info value (from DB) */
export interface CachedInfoValue {
  informationTypeId: string;
  value: string; // JSON string
  status: InfoStatus;
  fetchedAt: number; // unix timestamp
}

/** Resolved section state for rendering */
export interface InfoSection {
  typeId: string;
  name: string;
  displayKind: DisplayKind;
  state:
    | { kind: "loaded"; data: unknown; stale: boolean }
    | { kind: "loading" }
    | { kind: "hidden" }; // not_found or fresh error
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
