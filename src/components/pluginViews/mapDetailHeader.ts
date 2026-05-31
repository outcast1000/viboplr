import type { PluginViewData } from "../../types/plugin";
import type { DetailHeroChip } from "../DetailHero";
import type { HeroOverflowItem } from "../../utils/heroOverflow";
import { resolveImageUrl } from "../../utils/resolveImageUrl";

type DetailHeaderNode = Extract<PluginViewData, { type: "detail-header" }>;

export interface MappedHeroProps {
  title: string;
  artShape: "square" | "circle";
  meta: DetailHeroChip[];
  bgImages: string[];
  overflowItems: HeroOverflowItem[];
  onPlay?: () => void;
  onEnqueue?: () => void;
  onBack?: () => void;
}

// Maps a plugin `detail-header` node to the data-only props of <DetailHero>.
// The `art` ReactNode and the like/eyebrow/titleLine props are intentionally
// not produced here — the renderer supplies `art` (JSX) and leaves the
// entity-only props undefined so the hero hides like/dislike.
export function mapDetailHeaderToHeroProps(
  node: DetailHeaderNode,
  onAction: ((actionId: string, data?: unknown) => void) | undefined,
): MappedHeroProps {
  const meta: DetailHeroChip[] = [];
  if (node.subtitle) meta.push({ label: node.subtitle });
  if (node.meta) meta.push({ label: node.meta });

  const bgImages = (node.bgImages ?? [])
    .map((u) => resolveImageUrl(u))
    .filter((u): u is string => !!u);

  const overflowItems: HeroOverflowItem[] = [];
  for (const a of node.actions ?? []) {
    overflowItems.push({
      kind: "action",
      id: a.id,
      label: a.label,
      onClick: () => onAction?.(a.id),
    });
  }
  const ctx = node.contextMenuActions ?? [];
  if (overflowItems.length > 0 && ctx.length > 0) {
    overflowItems.push({ kind: "divider" });
  }
  for (const a of ctx) {
    if (a.separator) {
      overflowItems.push({ kind: "divider" });
    } else {
      overflowItems.push({
        kind: "action",
        id: a.id,
        label: a.label,
        onClick: () => onAction?.(a.id),
      });
    }
  }

  return {
    title: node.title,
    artShape: node.artShape ?? "square",
    meta,
    bgImages,
    overflowItems,
    onPlay: node.playAction ? () => onAction?.(node.playAction!) : undefined,
    onEnqueue: node.enqueueAction ? () => onAction?.(node.enqueueAction!) : undefined,
    onBack: node.backAction ? () => onAction?.(node.backAction!) : undefined,
  };
}
