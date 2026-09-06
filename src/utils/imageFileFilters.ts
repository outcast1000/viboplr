import type { DialogFilter } from "@tauri-apps/plugin-dialog";

/**
 * The file filter for every "pick an image" dialog — entity images (artist,
 * album, tag, track) and playlist covers alike.
 *
 * Shared because it drifted: six of the seven call sites listed jpg/jpeg/png
 * while the mixtape cover picker also took webp, so the same file was
 * selectable in one dialog and invisible in the others. Nothing downstream
 * cares about the format — the stored name is derived from the bytes
 * (`sniff_image_ext`) and the webview renders whatever it is — so the filter
 * is the only thing that was rejecting these.
 */
export const IMAGE_PICKER_FILTERS: DialogFilter[] = [
  { name: "Images", extensions: ["jpg", "jpeg", "png", "webp"] },
];
