import { Menu, MenuItem, CheckMenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";
import { LogicalPosition } from "@tauri-apps/api/dpi";

export type MenuItemSpec =
  | { kind: "item"; text: string; enabled?: boolean; action: () => void }
  | { kind: "check"; text: string; checked: boolean; action: () => void }
  | { kind: "separator" }
  | { kind: "submenu"; text: string; items: MenuItemSpec[] };

type BuiltItem = MenuItem | CheckMenuItem | PredefinedMenuItem | Submenu;

async function buildItems(specs: MenuItemSpec[]): Promise<BuiltItem[]> {
  return Promise.all(specs.map(async (spec) => {
    switch (spec.kind) {
      case "item":
        return MenuItem.new({ text: spec.text, enabled: spec.enabled ?? true, action: spec.action });
      case "check":
        return CheckMenuItem.new({ text: spec.text, checked: spec.checked, action: spec.action });
      case "separator":
        return PredefinedMenuItem.new({ item: "Separator" });
      case "submenu": {
        const children = await buildItems(spec.items);
        return Submenu.new({ text: spec.text, items: children });
      }
    }
  }));
}

/**
 * Release every menu-item resource (and its action Channel) created for a menu.
 * `Menu.close()` only frees the menu resource itself; the child items and their
 * channels would otherwise leak on every menu open, accumulating stale Tauri
 * event listeners until dispatch throws (`listeners[eventId].handlerId`).
 */
async function closeItems(items: BuiltItem[]): Promise<void> {
  await Promise.all(items.map(async (item) => {
    if (item instanceof Submenu) {
      try {
        const children = await item.items();
        await closeItems(children);
      } catch (e) {
        console.error("Failed to close submenu items:", e);
      }
    }
    await item.close().catch((e) => console.error("Failed to close menu item:", e));
  }));
}

export async function showNativeMenu(x: number, y: number, specs: MenuItemSpec[]): Promise<void> {
  const items = await buildItems(specs);
  const menu = await Menu.new({ items });
  try {
    await menu.popup(new LogicalPosition(x, y));
  } finally {
    await closeItems(items);
    await menu.close().catch((e) => console.error("Failed to close menu:", e));
  }
}
