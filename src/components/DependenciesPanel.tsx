import { useEffect, useRef, useState } from "react";
import type { DependencyInfo, DependencyRegistry, DepUpdateInfo, InstallProgress } from "../hooks/useDependencies";
import { HelpLink } from "./HelpLink";
import { getPlatform } from "./DependencyModal";
import { ToggleSwitch } from "./ToggleSwitch";
// Reuses the Settings card/row look; imported here so the Tools tab doesn't
// depend on SettingsPanel having been loaded first.
import "./SettingsPanel.css";

export interface DependenciesApi {
  deps: DependencyInfo[];
  updates: DepUpdateInfo[];
  installing: Record<string, InstallProgress>;
  checkAll: (forceRefresh?: boolean) => Promise<unknown>;
  checkUpdates: (force?: boolean) => Promise<unknown>;
  installDep: (name: string) => Promise<string | null>;
  uninstallManaged: (name: string) => Promise<void>;
  registry: DependencyRegistry;
  /** Plugin id → name, for "Provided by". */
  pluginNames: Record<string, string>;
  reviewDefinitions: (pluginId: string) => Promise<boolean>;
  revokeDefinitions: (pluginId: string) => Promise<void>;
  removeUnused: (name: string) => Promise<void>;
}

/**
 * Tab-badge count for Extensions → Tools: installable updates plus tools a
 * consumer marks required that aren't installed.
 */
export function dependencyAttentionCount(deps: DependencyInfo[], updates: DepUpdateInfo[]): number {
  const outdated = updates.filter((u) => u.outdated).length;
  const missingRequired = deps.filter(
    (d) => d.status !== "installed" && [...d.internalConsumers, ...d.pluginConsumers].some((c) => c.required),
  ).length;
  return outdated + missingRequired;
}

/**
 * External-binary dependencies (ffmpeg, yt-dlp, …): status, origin, install /
 * update / take-over / stop-managing, and the auto-update toggle. Rendered as
 * the Extensions view's Tools tab.
 */
export function DependenciesPanel({
  dependencies,
  autoUpdateManagedDeps,
  onAutoUpdateManagedDepsChange,
  searchQuery = "",
  isVisible,
}: {
  dependencies: DependenciesApi;
  autoUpdateManagedDeps: boolean;
  onAutoUpdateManagedDepsChange: (enabled: boolean) => void;
  searchQuery?: string;
  /** The Extensions view stays mounted; checks run when the tab is shown. */
  isVisible: boolean;
}) {
  const [loading, setLoading] = useState(false);
  const [actioning, setActioning] = useState<string | null>(null);
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);
  // Name of the dep whose inline "let Vibo manage" confirm is open.
  const [takeoverConfirm, setTakeoverConfirm] = useState<string | null>(null);

  // First time the tab is shown: fill in presence if startup hasn't yet, and run
  // the latest-version pass (24h TTL-cached backend-side, so cheap on repeat).
  // App's startup check fills `deps` long before anyone opens this tab, so a
  // `deps.length === 0` gate alone would never fetch the update info.
  const checkedRef = useRef(false);
  useEffect(() => {
    if (!isVisible || checkedRef.current) return;
    checkedRef.current = true;
    const presence = dependencies.deps.length === 0 ? dependencies.checkAll() : Promise.resolve();
    presence.then(() => dependencies.checkUpdates()).catch(console.error);
  }, [isVisible, dependencies]);

  const handleRefresh = async () => {
    setLoading(true);
    try {
      await dependencies.checkAll(true);
      await dependencies.checkUpdates(true);
    } catch (e) {
      console.error("Failed to refresh dependencies:", e);
    } finally {
      setLoading(false);
    }
  };

  const handleInstall = async (name: string) => {
    setActioning(name);
    setTakeoverConfirm(null);
    try {
      await dependencies.installDep(name);
    } catch (e) {
      console.error("Failed to install dependency:", e);
    } finally {
      setActioning(null);
    }
  };

  const handleRemoveUnused = async (name: string) => {
    setActioning(name);
    try {
      await dependencies.removeUnused(name);
    } catch (e) {
      console.error("Failed to remove an unused tool:", e);
    } finally {
      setActioning(null);
    }
  };

  const handleRevoke = async (pluginId: string) => {
    try {
      await dependencies.revokeDefinitions(pluginId);
    } catch (e) {
      console.error("Failed to take back consent for a plugin's tools:", e);
    }
  };

  const handleReview = async (pluginId: string) => {
    try {
      await dependencies.reviewDefinitions(pluginId);
    } catch (e) {
      console.error("Failed to review a plugin's tools:", e);
    }
  };

  const nameOf = (pluginId: string) => dependencies.pluginNames[pluginId] ?? pluginId;
  const { pendingConsent, conflicts, refused, unused } = dependencies.registry;
  const waitingPlugins = [...new Set(pendingConsent.map((p) => p.pluginId))];

  const handleStopManaging = async (name: string) => {
    setActioning(name);
    try {
      await dependencies.uninstallManaged(name);
    } catch (e) {
      console.error("Failed to stop managing dependency:", e);
    } finally {
      setActioning(null);
    }
  };

  const platform = getPlatform();

  const handleCopyUpgrade = async (name: string, cmd: string) => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopiedCmd(name);
      setTimeout(() => setCopiedCmd((c) => (c === name ? null : c)), 2000);
    } catch (e) {
      console.error("Failed to copy:", e);
    }
  };

  const q = searchQuery.trim().toLowerCase();
  const shown = q
    ? dependencies.deps.filter((d) =>
        d.name.toLowerCase().includes(q) ||
        d.description.toLowerCase().includes(q) ||
        [...d.internalConsumers, ...d.pluginConsumers].some((c) => c.name.toLowerCase().includes(q)),
      )
    : dependencies.deps;

  return (
    <div className="ext-tools-pane">
      <div className="settings-group">
        <h4 className="settings-group-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          Command-line tools<HelpLink anchor="dependencies" topic="managed dependencies" />
          <button
            className="ds-btn ds-btn--ghost ds-btn--sm"
            onClick={handleRefresh}
            disabled={loading}
            style={{ marginLeft: "auto" }}
          >
            {loading ? "Checking..." : "Refresh"}
          </button>
        </h4>
        <div className="settings-card">
          {dependencies.deps.length === 0 && (
            <div className="settings-row">
              <span className="settings-label" style={{ color: "var(--text-tertiary)" }}>Loading...</span>
            </div>
          )}
          {dependencies.deps.length > 0 && shown.length === 0 && (
            <div className="settings-row">
              <span className="settings-label" style={{ color: "var(--text-tertiary)" }}>No tools match "{searchQuery}"</span>
            </div>
          )}
          {shown.map((dep) => {
            const allConsumers = [...dep.internalConsumers, ...dep.pluginConsumers];
            const update = dependencies.updates.find((u) => u.name === dep.name);
            const outdated = update?.outdated ?? false;
            const progress = dependencies.installing[dep.name];
            const busy = actioning === dep.name || !!progress;
            const installed = dep.status === "installed";

            return (
              <div className="settings-row" key={dep.name} style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className="settings-label" style={{ fontWeight: 600 }}>{dep.name}</span>
                  {installed ? (
                    <span style={{ fontSize: "var(--fs-xs)", color: "var(--success)", fontWeight: 500 }}>
                      Installed{dep.version ? ` (${dep.version})` : ""}
                    </span>
                  ) : (
                    <span style={{ fontSize: "var(--fs-xs)", color: "var(--warning)", fontWeight: 500 }}>
                      Not Installed
                    </span>
                  )}
                  {installed && dep.origin && (
                    <span className="settings-pill">
                      {dep.origin === "managed" ? "managed by Vibo" : "system"}
                    </span>
                  )}
                  {dep.managedAvailable && !dep.verified && (
                    <span className="settings-pill" title="Its publisher offers no checksum: you confirm every install and update, and it never updates on its own">
                      not verified
                    </span>
                  )}
                  {/* Install / Update / manage actions live on the right. */}
                  <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
                    {busy && progress && (
                      <span style={{ fontSize: "var(--fs-2xs)", color: "var(--text-tertiary)" }}>
                        {progress.total ? `${Math.round((progress.downloaded / progress.total) * 100)}%` : "…"}
                      </span>
                    )}
                    {!installed && dep.managedAvailable && (
                      <button className="ds-btn ds-btn--primary ds-btn--sm" onClick={() => handleInstall(dep.name)} disabled={busy}>
                        {busy ? "Installing..." : "Install"}
                      </button>
                    )}
                    {installed && outdated && dep.origin === "managed" && !dep.sourceMismatch && (
                      <button className="ds-btn ds-btn--primary ds-btn--sm" onClick={() => handleInstall(dep.name)} disabled={busy}>
                        {busy ? "Updating..." : "Update"}
                      </button>
                    )}
                    {installed && dep.origin === "managed" && dep.sourceMismatch && dep.managedAvailable && (
                      <button className="ds-btn ds-btn--primary ds-btn--sm" onClick={() => handleInstall(dep.name)} disabled={busy}>
                        {busy ? "Reinstalling..." : "Reinstall"}
                      </button>
                    )}
                    {installed && outdated && dep.origin === "system" && (
                      <button
                        className="ds-btn ds-btn--secondary ds-btn--sm"
                        onClick={() => handleCopyUpgrade(dep.name, dep.install[platform])}
                        title={dep.install[platform]}
                      >
                        {copiedCmd === dep.name ? "Copied" : "Copy upgrade command"}
                      </button>
                    )}
                    {installed && dep.origin === "system" && dep.managedAvailable && (
                      <button
                        className="ds-btn ds-btn--ghost ds-btn--sm"
                        onClick={() => setTakeoverConfirm(takeoverConfirm === dep.name ? null : dep.name)}
                        disabled={busy}
                      >
                        Let Vibo manage
                      </button>
                    )}
                    {installed && dep.origin === "managed" && (
                      <button
                        className="ds-btn ds-btn--ghost ds-btn--sm"
                        onClick={() => handleStopManaging(dep.name)}
                        disabled={busy}
                        title="Remove Vibo's copy and fall back to a system install"
                      >
                        {busy ? "Working..." : "Stop managing"}
                      </button>
                    )}
                  </span>
                </div>
                {installed && outdated && update?.latest && (
                  <span style={{ fontSize: "var(--fs-xs)", color: "var(--warning)" }}>
                    Update available: {update.installed ?? dep.version} → {update.latest}
                    {dep.origin === "system" ? " (installed outside Vibo — update via your package manager)" : ""}
                  </span>
                )}
                {takeoverConfirm === dep.name && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "8px 10px", background: "var(--bg-tertiary)", borderRadius: "var(--ds-radius)" }}>
                    <span style={{ fontSize: "var(--fs-xs)", color: "var(--text-secondary)" }}>
                      Vibo will download and keep its own copy of {dep.name} up to date automatically. Your existing system copy is left in place but no longer used — you can remove it later via your package manager.
                    </span>
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                      <button className="ds-btn ds-btn--ghost ds-btn--sm" onClick={() => setTakeoverConfirm(null)} disabled={busy}>Cancel</button>
                      <button className="ds-btn ds-btn--primary ds-btn--sm" onClick={() => handleInstall(dep.name)} disabled={busy}>
                        {busy ? "Installing..." : "Let Vibo manage"}
                      </button>
                    </div>
                  </div>
                )}
                {installed && dep.origin === "managed" && dep.sourceMismatch && (
                  <span style={{ fontSize: "var(--fs-xs)", color: "var(--warning)" }}>
                    Vibo's copy came from a different source than the one {dep.declaredBy.map(nameOf).join(", ") || "Vibo"} now
                    uses. It won't update until you reinstall it.
                  </span>
                )}
                <span className="settings-description">{dep.description}</span>
                {dep.declaredBy.length > 0 && (
                  <span style={{ fontSize: "var(--fs-xs)", color: "var(--text-tertiary)" }}>
                    Provided by {dep.declaredBy.map(nameOf).join(", ")}
                    {!dep.signedDefinition && " — not signed by Vibo, so it updates only when you choose"}
                    {!dep.signedDefinition && (
                      <button
                        className="ds-btn ds-btn--ghost ds-btn--sm"
                        style={{ marginLeft: 8 }}
                        onClick={() => handleRevoke(dep.declaredBy[0])}
                        title={`Stop using the tools ${nameOf(dep.declaredBy[0])} defines; Vibo will ask again`}
                      >
                        Revoke
                      </button>
                    )}
                  </span>
                )}
                {allConsumers.length > 0 && (
                  <div style={{ fontSize: "var(--fs-xs)", color: "var(--text-tertiary)", display: "flex", flexDirection: "column", gap: 2 }}>
                    <span>Used by:</span>
                    {allConsumers.map((c) => (
                      <span key={c.name} style={{ paddingLeft: 8 }}>
                        {c.name} {c.required ? "(required)" : "(optional)"} — {c.reason}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {waitingPlugins.map((pluginId) => {
            const items = pendingConsent.filter((p) => p.pluginId === pluginId);
            return (
              <div className="settings-row" key={`pending:${pluginId}`}>
                <div className="settings-row-info">
                  <span className="settings-label">
                    {items.map((i) => i.name).join(", ")}
                    <span style={{ fontSize: "var(--fs-xs)", color: "var(--warning)", fontWeight: 500, marginLeft: 8 }}>
                      Waiting for your OK
                    </span>
                  </span>
                  <span className="settings-description">
                    {items[0].pluginName} isn't signed by Vibo and wants Vibo to install{" "}
                    {items.length > 1 ? "these tools" : "this tool"} for it.
                  </span>
                </div>
                <button className="ds-btn ds-btn--secondary ds-btn--sm" onClick={() => handleReview(pluginId)}>
                  Review
                </button>
              </div>
            );
          })}
          {conflicts.map((c) => (
            <div className="settings-row" key={`conflict:${c.name}:${c.dropped}`}>
              <span className="settings-description" style={{ color: "var(--warning)" }}>
                {nameOf(c.dropped)} defines {c.name} differently from {nameOf(c.kept)}; {nameOf(c.kept)}'s is used
                ({c.reason}).
              </span>
            </div>
          ))}
          {refused.map((r) => (
            <div className="settings-row" key={`refused:${r.pluginId}:${r.name}`}>
              <span className="settings-description" style={{ color: "var(--warning)" }}>
                {nameOf(r.pluginId)}'s definition of {r.name} can't be used: {r.reason}
              </span>
            </div>
          ))}
          {unused.length > 0 && (
            <div className="settings-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
              <div className="settings-row-info">
                <span className="settings-label">Unused</span>
                <span className="settings-description">
                  Copies Vibo installed for a plugin that's no longer here. Another profile on this computer may
                  still use them.
                </span>
              </div>
              {unused.map((name) => (
                <div key={`unused:${name}`} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className="settings-label" style={{ fontWeight: 600 }}>{name}</span>
                  <button
                    className="ds-btn ds-btn--ghost ds-btn--sm"
                    style={{ marginLeft: "auto" }}
                    onClick={() => handleRemoveUnused(name)}
                    disabled={actioning === name}
                  >
                    {actioning === name ? "Removing..." : "Remove"}
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-label">Keep tools up to date automatically</span>
              <span className="settings-description">
                Silently update Vibo-managed binaries (e.g. yt-dlp) when a newer release is available. Binaries installed via a package manager, tools from plugins Vibo hasn't signed, and tools without a checksum are never updated on their own.
              </span>
            </div>
            <ToggleSwitch checked={autoUpdateManagedDeps} onChange={onAutoUpdateManagedDepsChange} />
          </div>
        </div>
      </div>
    </div>
  );
}
