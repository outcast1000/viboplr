import type { SkinInfo } from "../types/skin";
import defaultSkin from "./default.json";
import oledBlack from "./oled-black.json";
import arcticLight from "./arctic-light.json";
import forest from "./forest.json";
import silver from "./silver.json";
import oceanBlue from "./ocean-blue.json";
import viboplr from "./viboplr.json";
import sunset from "./sunset.json";

function toSkinInfo(id: string, json: Record<string, unknown>): SkinInfo {
  return { id, source: "builtin", ...(json as Omit<SkinInfo, "id" | "source">) };
}

export const BUILTIN_SKINS: SkinInfo[] = [
  toSkinInfo("default", defaultSkin),
  toSkinInfo("oled-black", oledBlack),
  toSkinInfo("arctic-light", arcticLight),
  toSkinInfo("forest", forest),
  toSkinInfo("silver", silver),
  toSkinInfo("ocean-blue", oceanBlue),
  toSkinInfo("viboplr", viboplr),
  toSkinInfo("sunset", sunset),
];
