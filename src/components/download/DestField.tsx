import { IconFolder } from "../Icons";
import { showNativeMenu, type MenuItemSpec } from "../../nativeMenu";

/**
 * Destination picker for the download window (design "Polished rows").
 * Renders an inline field (folder glyph + current destination + "Change") whose
 * "Change" opens a native OS menu of collections + "Browse to folder…" — per the
 * project's native-menus-only rule (no JS/CSS popover).
 */
export function DestField({
  collections,
  destType,
  destCollectionId,
  destPath,
  onPickCollection,
  onBrowse,
}: {
  collections: { id: number; name: string; path: string }[];
  destType: "collection" | "path";
  destCollectionId: number | null;
  destPath: string | null;
  onPickCollection: (id: number) => void;
  onBrowse: () => void;
}) {
  const current = collections.find((c) => c.id === destCollectionId);
  const isPath = destType === "path" && !!destPath;
  const label = isPath ? destPath! : current?.name ?? "Choose a folder…";
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
