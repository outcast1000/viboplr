export type HeroOverflowItem =
  | { kind: "action"; id: string; label: string; onClick: () => void; iconKey?: string; danger?: boolean }
  | { kind: "divider" };

export interface HeroWebSearch {
  id: string;
  label: string;        // displayed as "Search {label}" — caller passes provider name
  onClick: () => void;
}

export interface HeroImageActions {
  onRefresh?: () => void;            // "Retrieve image" — re-fetch via provider chain
  onSetFromFile?: () => void;        // "Set image…" — open file picker
  onPasteFromClipboard?: () => void; // "Paste image"
  onRemove?: () => void;             // "Remove image" — only when an image exists
  onSearchImage?: () => void;        // "Search image" — Google Images
  webSearches?: HeroWebSearch[];     // Per-provider web searches
}

export interface HeroYoutubeActions {
  onFind: () => void;                // "Find in YouTube" — search + open
}

export interface HeroRadioActions {
  onStart: () => void;               // "Start radio" — build a station from this track
}

export interface HeroOverflowArgs {
  entityKind: "track" | "album" | "artist" | "tag";
  imageActions: HeroImageActions;
  radio?: HeroRadioActions;           // honored only when entityKind === "track"
  youtube?: HeroYoutubeActions;       // honored only when entityKind === "track"
  pluginItems: HeroOverflowItem[];
}

export function buildHeroOverflowItems(args: HeroOverflowArgs): HeroOverflowItem[] {
  const out: HeroOverflowItem[] = [];

  // Image actions (in display order)
  const ia = args.imageActions;
  if (ia.onRefresh)            out.push({ kind: "action", id: "image-refresh",       label: "Retrieve image", onClick: ia.onRefresh,            iconKey: "refresh" });
  if (ia.onSetFromFile)        out.push({ kind: "action", id: "image-set",           label: "Set image…", onClick: ia.onSetFromFile,        iconKey: "image" });
  if (ia.onPasteFromClipboard) out.push({ kind: "action", id: "image-paste",         label: "Paste image",    onClick: ia.onPasteFromClipboard, iconKey: "paste" });
  if (ia.onRemove)             out.push({ kind: "action", id: "image-remove",        label: "Remove image",   onClick: ia.onRemove,             iconKey: "remove", danger: true });
  if (ia.onSearchImage)        out.push({ kind: "action", id: "image-search",        label: "Search image",   onClick: ia.onSearchImage,        iconKey: "google" });
  for (const s of ia.webSearches ?? []) {
    out.push({ kind: "action", id: `web-search-${s.id}`, label: `Search ${s.label}`, onClick: s.onClick });
  }

  // Track-only playback/external actions (radio + YouTube), grouped together.
  if (args.entityKind === "track") {
    const trackActions: HeroOverflowItem[] = [];
    if (args.radio)   trackActions.push({ kind: "action", id: "start-radio",  label: "Start radio",      onClick: args.radio.onStart, iconKey: "radio" });
    if (args.youtube) trackActions.push({ kind: "action", id: "youtube-find", label: "Find in YouTube",  onClick: args.youtube.onFind, iconKey: "youtube" });
    if (trackActions.length > 0) {
      if (out.length > 0) out.push({ kind: "divider" });
      out.push(...trackActions);
    }
  }

  // Plugin items
  if (args.pluginItems.length > 0) {
    if (out.length > 0) out.push({ kind: "divider" });
    out.push(...args.pluginItems);
  }

  return out;
}
