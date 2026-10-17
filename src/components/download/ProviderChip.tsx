import { IconDownload } from "../Icons";

/**
 * Small provider identity chip shown in the download window header
 * (design "Polished rows"). Provider-agnostic: the provider name with a
 * neutral, skin-tinted glyph — no per-provider branding in the host.
 */
export function ProviderChip({ name }: { name: string }) {
  return (
    <span className="dl-prov">
      <IconDownload size={12} />
      {name}
    </span>
  );
}
