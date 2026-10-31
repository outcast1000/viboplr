import { useState } from "react";
import "./DevPluginBanner.css";

// Strip above a plugin view whose plugin was loaded from the dev plugin folder
// (Settings → Debug → Dev plugin folder, debug mode only). Says so, and offers
// the reload the developer would otherwise go to Settings for after each edit.
// Drawn by the host independently of the plugin's own header, so a plugin that
// hides its header still gets it.

interface DevPluginBannerProps {
  devPath?: string;
  onReload: () => Promise<void>;
}

export function DevPluginBanner({ devPath, onReload }: DevPluginBannerProps) {
  const [reloading, setReloading] = useState(false);

  const handleReload = async () => {
    setReloading(true);
    try {
      await onReload();
    } finally {
      setReloading(false);
    }
  };

  return (
    <div className="dev-plugin-banner" role="status">
      <span className="dev-plugin-banner-badge">Dev</span>
      <span className="dev-plugin-banner-path" title={devPath}>
        {devPath ? `Loaded from ${devPath}` : "Loaded from the dev plugin folder"}
      </span>
      <button
        type="button"
        className="ds-btn ds-btn--sm ds-btn--secondary dev-plugin-banner-reload"
        disabled={reloading}
        onClick={handleReload}
      >
        {reloading ? "Reloading…" : "Reload"}
      </button>
    </div>
  );
}
