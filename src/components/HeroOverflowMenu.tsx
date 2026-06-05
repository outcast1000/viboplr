import type { HeroOverflowItem } from "../utils/heroOverflow";
import { showNativeMenu, type MenuItemSpec } from "../nativeMenu";

interface Props {
  items: HeroOverflowItem[];
  triggerLabel?: string;
}

function toSpecs(items: HeroOverflowItem[]): MenuItemSpec[] {
  return items.map((item): MenuItemSpec =>
    item.kind === "divider"
      ? { kind: "separator" }
      : { kind: "item", text: item.label, action: item.onClick }
  );
}

export function HeroOverflowMenu({ items, triggerLabel = "More options" }: Props) {
  if (items.length === 0) return null;

  const openMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    showNativeMenu(rect.left, rect.bottom, toSpecs(items)).catch((err) =>
      console.error("Failed to show hero overflow menu:", err)
    );
  };

  return (
    <button
      className="ds-btn ds-btn--secondary hero-overflow-trigger"
      title={triggerLabel}
      aria-label={triggerLabel}
      onClick={openMenu}
    >
      &#x22EF;
    </button>
  );
}
