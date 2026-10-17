import type { DownloadQualityOption } from "../types/plugin";

/** The quality last used per download provider, split by what was being
 *  downloaded: someone who saves yt-dlp videos at 720p still wants audio
 *  downloads to open on audio. Persisted as one store key. */
export type DownloadQualityMemory = Record<string, { audio?: string; video?: string }>;

export const DOWNLOAD_QUALITY_MEMORY_KEY = "downloadQualityByProvider";

/** The remembered value for this provider and kind, when the options still
 *  offer it (a previewed list can be shorter than last time's). */
export function rememberedQuality(
  memory: DownloadQualityMemory | null | undefined,
  providerId: string,
  isVideo: boolean,
  options: DownloadQualityOption[],
): string | null {
  const saved = memory?.[providerId]?.[isVideo ? "video" : "audio"];
  return saved && options.some((o) => o.value === saved) ? saved : null;
}

/** `memory` with this choice recorded. Returns the same object when nothing changed. */
export function rememberQuality(
  memory: DownloadQualityMemory | null | undefined,
  providerId: string,
  isVideo: boolean,
  value: string,
): DownloadQualityMemory {
  const base = memory ?? {};
  const kind = isVideo ? "video" : "audio";
  if (base[providerId]?.[kind] === value) return base;
  return { ...base, [providerId]: { ...base[providerId], [kind]: value } };
}

/** Coerce whatever the store held into a memory object. */
export function coerceQualityMemory(raw: unknown): DownloadQualityMemory {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: DownloadQualityMemory = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const { audio, video } = v as { audio?: unknown; video?: unknown };
    const entry: { audio?: string; video?: string } = {};
    if (typeof audio === "string") entry.audio = audio;
    if (typeof video === "string") entry.video = video;
    if (entry.audio || entry.video) out[id] = entry;
  }
  return out;
}
