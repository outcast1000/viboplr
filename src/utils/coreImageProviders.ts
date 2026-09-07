import { invoke } from "@tauri-apps/api/core";

/**
 * The built-in image providers. They are rows in the same `image_providers`
 * table plugin providers live in — that's what lets the user order embedded
 * artwork against a plugin instead of it being pinned first — so any surface
 * that renders or walks that list has to recognize them.
 *
 * The ids mirror `image_provider::{CORE_FOLDER, CORE_EMBEDDED}` in Rust. The
 * `core:` prefix can never collide with a plugin id: plugin ids come from
 * manifests, where `:` isn't legal.
 */
export const CORE_FOLDER_PROVIDER = "core:folder";
export const CORE_EMBEDDED_PROVIDER = "core:embedded";

export function isCoreImageProvider(providerId: string): boolean {
  return providerId.startsWith("core:");
}

const CORE_NAMES: Record<string, string> = {
  [CORE_FOLDER_PROVIDER]: "Folder image",
  [CORE_EMBEDDED_PROVIDER]: "Embedded artwork",
};

/** Longer names for the Retrieve modal, which has room to say where art came from. */
const CORE_LONG_NAMES: Record<string, string> = {
  [CORE_FOLDER_PROVIDER]: "Folder image (next to the tracks)",
  [CORE_EMBEDDED_PROVIDER]: "Embedded artwork (audio file)",
};

/**
 * Display name for one image-provider row. Core providers have no manifest, so
 * they'd otherwise render as their raw id.
 */
export function imageProviderName(
  providerId: string,
  pluginNames: Map<string, string> | Record<string, string>,
  variant: "short" | "long" = "short",
): string {
  const core = (variant === "long" ? CORE_LONG_NAMES : CORE_NAMES)[providerId];
  if (core) return core;
  const fromPlugin =
    pluginNames instanceof Map ? pluginNames.get(providerId) : pluginNames[providerId];
  return fromPlugin ?? providerId;
}

/** Which entities a core provider can answer for; the rest of the chain skips it. */
export function coreProviderSupports(
  providerId: string,
  entity: "artist" | "album" | "tag",
): boolean {
  if (providerId === CORE_FOLDER_PROVIDER) return entity === "album" || entity === "artist";
  if (providerId === CORE_EMBEDDED_PROVIDER) return entity === "album";
  return false;
}

/**
 * Run a core provider for the Retrieve modal's preview step, returning the path
 * of a temp copy. Rejects when the provider has nothing — same contract as a
 * plugin returning `not_found`.
 */
export async function fetchCoreImageProvider(
  providerId: string,
  entity: "artist" | "album" | "tag",
  name: string,
  artistName?: string | null,
): Promise<string> {
  if (providerId === CORE_EMBEDDED_PROVIDER) {
    return invoke<string>("extract_embedded_album_image", {
      albumTitle: name,
      artistName: artistName ?? null,
    });
  }
  if (providerId === CORE_FOLDER_PROVIDER) {
    return invoke<string>("extract_folder_entity_image", {
      kind: entity,
      name,
      artistName: artistName ?? null,
    });
  }
  throw new Error(`Unknown built-in image provider: ${providerId}`);
}
