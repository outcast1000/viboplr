import { describe, it, expect, vi, beforeEach } from "vitest";

// Pins the `popup_native_menu` contract: the command name and its argument
// keys must match the Rust parameters, or every native menu silently stops
// opening (the rejection lands in showNativeMenu's finally).

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

const menuClose = vi.fn().mockResolvedValue(undefined);
const itemClose = vi.fn().mockResolvedValue(undefined);
const menuPopup = vi.fn();

vi.mock("@tauri-apps/api/menu", () => {
  class Item {
    close = itemClose;
  }
  return {
    Menu: { new: vi.fn(async () => ({ rid: 42, close: menuClose, popup: menuPopup })) },
    MenuItem: { new: vi.fn(async () => new Item()) },
    CheckMenuItem: { new: vi.fn(async () => new Item()) },
    PredefinedMenuItem: { new: vi.fn(async () => new Item()) },
    Submenu: class extends Item {
      static new = vi.fn(async () => new Item());
    },
  };
});

import { showNativeMenu } from "../nativeMenu";

describe("showNativeMenu", () => {
  beforeEach(() => {
    invoke.mockReset().mockResolvedValue(null);
    menuClose.mockClear();
    itemClose.mockClear();
    menuPopup.mockClear();
  });

  it("pops the menu through popup_native_menu, never Menu.popup", async () => {
    await showNativeMenu(10, 20, [{ kind: "item", text: "Play", action: () => {} }]);
    expect(invoke).toHaveBeenCalledWith("popup_native_menu", { rid: 42, x: 10, y: 20 });
    expect(menuPopup).not.toHaveBeenCalled();
  });

  it("releases the menu and its items even when the popup fails", async () => {
    invoke.mockRejectedValueOnce(new Error("boom"));
    await expect(
      showNativeMenu(0, 0, [{ kind: "item", text: "Play", action: () => {} }]),
    ).rejects.toThrow("boom");
    expect(itemClose).toHaveBeenCalledTimes(1);
    expect(menuClose).toHaveBeenCalledTimes(1);
  });
});
