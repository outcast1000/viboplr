import { Menu, MenuItem, CheckMenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";
import { LogicalPosition } from "@tauri-apps/api/dpi";

export type MenuItemSpec =
  | { kind: "item"; text: string; enabled?: boolean; action: () => void }
  | { kind: "check"; text: string; checked: boolean; action: () => void }
  | { kind: "separator" }
  | { kind: "submenu"; text: string; items: MenuItemSpec[] };

async function buildItems(specs: MenuItemSpec[]): Promise<(MenuItem | CheckMenuItem | PredefinedMenuItem | Submenu)[]> {
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

export async function showNativeMenu(x: number, y: number, specs: MenuItemSpec[]): Promise<void> {
  const items = await buildItems(specs);
  const menu = await Menu.new({ items });
  try {
    await menu.popup(new LogicalPosition(x, y));
  } finally {
    await menu.close();
  }
}
