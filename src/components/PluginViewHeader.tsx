import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ResolvedPluginViewHeader, ViewHeaderImage } from "../utils/pluginViewHeader";
import { resolveImageUrl } from "../utils/resolveImageUrl";
import "./PluginViewHeader.css";

// The strip at the top of every plugin view. What goes in it is decided by the
// pure `resolvePluginViewHeader`; this component only draws it and turns image
// references into URLs. See plugins.md "View header".

interface PluginViewHeaderProps {
  pluginId: string;
  /** Dev plugin folder, so a logo shipped there resolves before the installed copy's. */
  devPath?: string;
  header: ResolvedPluginViewHeader;
  onAction: (actionId: string) => void;
}

/** Resolve one header image to something `<img src>` accepts. Plugin-folder
 *  paths go through the backend, which enforces the folder, type and size
 *  rules; a failure just means no image, never a broken view. */
function useHeaderImage(pluginId: string, devPath: string | undefined, image: ViewHeaderImage | null): string | null {
  const direct = image?.kind === "src" ? resolveImageUrl(image.value) ?? null : null;
  const filePath = image?.kind === "plugin-file" ? image.path : null;
  const [resolved, setResolved] = useState<{ key: string; url: string | null } | null>(null);
  const key = filePath ? `${pluginId}|${devPath ?? ""}|${filePath}` : null;

  useEffect(() => {
    if (!key || !filePath) return;
    let cancelled = false;
    invoke<string>("plugin_asset_path", { pluginId, path: filePath, devPath: devPath ?? null })
      .then((abs) => { if (!cancelled) setResolved({ key, url: resolveImageUrl(abs) ?? null }); })
      .catch((e) => {
        console.error(`Failed to load view header image for ${pluginId}:`, e);
        if (!cancelled) setResolved({ key, url: null });
      });
    return () => { cancelled = true; };
  }, [key, pluginId, devPath, filePath]);

  if (direct) return direct;
  return resolved && resolved.key === key ? resolved.url : null;
}

export function PluginViewHeader({ pluginId, devPath, header, onAction }: PluginViewHeaderProps) {
  const logo = useHeaderImage(pluginId, devPath, header.logo);
  const logoLight = useHeaderImage(pluginId, devPath, header.logoLight);
  const banner = useHeaderImage(pluginId, devPath, header.banner);
  // An image that fails to decode falls back to the glyph / the plain strip
  // instead of leaving a broken-image box.
  const [failed, setFailed] = useState<Set<string>>(() => new Set());
  const ok = (src: string | null) => (src && !failed.has(src) ? src : null);
  const markFailed = (src: string) => setFailed((prev) => new Set(prev).add(src));

  if (header.hidden) return null;

  const bannerSrc = ok(banner);
  const logoSrc = ok(logo);
  const logoLightSrc = ok(logoLight);

  return (
    <header
      className={`plugin-view-header${bannerSrc ? " plugin-view-header--banner" : ""}`}
      data-plugin={pluginId}
    >
      {bannerSrc && (
        <img className="pvh-banner" src={bannerSrc} alt="" aria-hidden="true" onError={() => markFailed(bannerSrc)} />
      )}
      {logoSrc ? (
        <span className="pvh-logo">
          <img className={logoLightSrc ? "pvh-logo-dark" : undefined} src={logoSrc} alt="" onError={() => markFailed(logoSrc)} />
          {logoLightSrc && (
            <img className="pvh-logo-light" src={logoLightSrc} alt="" onError={() => markFailed(logoLightSrc)} />
          )}
        </span>
      ) : (
        <span className="pvh-icon" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d={header.iconPath} />
          </svg>
        </span>
      )}
      <div className="pvh-text">
        <h1 className="pvh-title">
          {header.title}
          {header.viewLabel && <span className="pvh-view"> · {header.viewLabel}</span>}
        </h1>
        {header.subtitle && <div className="pvh-subtitle" title={header.subtitle}>{header.subtitle}</div>}
      </div>
      {(header.status || header.actions.length > 0) && (
        <div className="pvh-right">
          {header.status && (
            <span className={`pvh-status pvh-status--${header.status.variant}`} role="status">
              <span className="pvh-status-dot" aria-hidden="true" />
              {header.status.label}
            </span>
          )}
          {header.actions.map((a) => (
            <button
              key={a.action}
              type="button"
              className={`ds-btn ds-btn--sm ${a.variant === "accent" ? "ds-btn--primary" : "ds-btn--secondary"} pvh-action`}
              disabled={a.disabled}
              onClick={() => onAction(a.action)}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </header>
  );
}
