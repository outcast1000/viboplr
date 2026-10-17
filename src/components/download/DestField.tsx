import { IconFolder } from "../Icons";
import { showNativeMenu, type MenuItemSpec } from "../../nativeMenu";

/** How a download is laid out inside the chosen folder (`download_relative_path`
 *  in `downloader.rs`). Persisted as `downloadFolderLayout`. */
export type DownloadLayout = "artist-album" | "flat";

export const DOWNLOAD_LAYOUT_KEY = "downloadFolderLayout";

export function coerceDownloadLayout(v: unknown): DownloadLayout {
  return v === "flat" ? "flat" : "artist-album";
}

/**
 * Destination picker for the download window (design "Polished rows").
 * Renders an inline field (folder glyph + current destination + "Change") whose
 * "Change" opens a native OS menu of collections + "Browse to folder…" + the
 * folder layout — per the project's native-menus-only rule (no JS/CSS popover).
 * The layout shows in the label ("Music › Artist › Album"), so where the file
 * goes is never a surprise.
 */
export function DestField({
  collections,
  destType,
  destCollectionId,
  destPath,
  layout,
  onPickCollection,
  onBrowse,
  onLayout,
}: {
  collections: { id: number; name: string; path: string }[];
  destType: "collection" | "path";
  destCollectionId: number | null;
  destPath: string | null;
  /** Omit to hide the layout (a flow that names its files itself). */
  layout?: DownloadLayout;
  onPickCollection: (id: number) => void;
  onBrowse: () => void;
  onLayout?: (layout: DownloadLayout) => void;
}) {
  const current = collections.find((c) => c.id === destCollectionId);
  const isPath = destType === "path" && !!destPath;
  const base = isPath ? destPath! : current?.name ?? "Choose a folder…";
  const hasDest = isPath || !!current;
  const label = hasDest && layout === "artist-album" ? `${base} › Artist › Album` : base;
  const title = isPath ? destPath! : current?.path ?? "";

  function openMenu(e: React.MouseEvent) {
    const rect = e.currentTarget.getBoundingClientRect();
    const specs: MenuItemSpec[] = [
      ...collections.map((c) => ({
        kind: "check" as const,
        text: c.name,
        checked: destType === "collection" && destCollectionId === c.id,
        action: () => onPickCollection(c.id),
      })),
      { kind: "separator" as const },
      { kind: "item" as const, text: "Browse to folder…", action: () => onBrowse() },
    ];
    if (layout && onLayout) {
      specs.push(
        { kind: "separator" as const },
        {
          kind: "submenu" as const,
          text: "Folder layout",
          items: [
            { kind: "check" as const, text: "Artist › Album › 01 Title", checked: layout === "artist-album", action: () => onLayout("artist-album") },
            { kind: "check" as const, text: "All in one folder (Artist - Title)", checked: layout === "flat", action: () => onLayout("flat") },
          ],
        },
      );
    }
    showNativeMenu(rect.left, rect.bottom, specs).catch(console.error);
  }

  return (
    <div className="dl-dest-field">
      <IconFolder size={16} />
      <span className="dl-dest-name" title={title}>{label}</span>
      <button type="button" className="dl-dest-change" onClick={openMenu}>Change</button>
    </div>
  );
}
