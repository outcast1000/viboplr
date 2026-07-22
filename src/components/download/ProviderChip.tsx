import { IconYoutube, IconDownload } from "../Icons";

/**
 * Small provider identity chip shown in the download window header
 * (design "Polished rows"). Provider-agnostic: shows the provider name with a
 * neutral, skin-tinted glyph, and a recognizable red mark for YouTube.
 */
export function ProviderChip({ name, providerId }: { name: string; providerId?: string }) {
  const key = `${name} ${providerId ?? ""}`.toLowerCase();
  const isYoutube = key.includes("youtube");
  return (
    <span className={`dl-prov${isYoutube ? " dl-prov--yt" : ""}`}>
      {isYoutube ? <IconYoutube size={13} /> : <IconDownload size={12} />}
      {name}
    </span>
  );
}
