import { useId } from "react";

/** The app-icon tile (docs/assets/logo-mark.svg), cropped to the tile like the website's nav lockup. */
export function AppLogoMark({ size = 18, className }: { size?: number; className?: string }) {
  // Unique per instance: two marks on screen would otherwise share one gradient id.
  const gradId = useId();
  const v = "M140.0 124.0 L241.0 348.0 L271.0 348.0 L372.0 124.0 L298.0 124.0 L256.0 217.1 L214.0 124.0 Z";
  return (
    <svg className={className} width={size} height={size} viewBox="36 36 440 440" aria-hidden="true">
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#FF6B6B" />
          <stop offset="100%" stopColor="#E91E8A" />
        </linearGradient>
      </defs>
      <rect x="36" y="36" width="440" height="440" rx="99" fill={`url(#${gradId})`} />
      <path d={v} transform="translate(0 40)" fill="#fff" stroke="#fff" strokeWidth="10" strokeLinejoin="round" opacity="0.4" />
      <path d={v} fill="#fff" stroke="#fff" strokeWidth="10" strokeLinejoin="round" />
    </svg>
  );
}
