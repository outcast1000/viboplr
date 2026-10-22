import { useEffect, useRef, useState } from "react";
import type {
  DependencyInfo,
  DependencyRegistry,
  DependencyService,
  DepInstallError,
  DepUpdateInfo,
  InstallProgress,
  UndefinedTool,
} from "../hooks/useDependencies";
import { HelpLink } from "./HelpLink";
import { getPlatform } from "./DependencyModal";
// Reuses the Settings card/row look; imported here so the Tools tab doesn't
// depend on SettingsPanel having been loaded first.
import "./SettingsPanel.css";

export interface DependenciesApi {
  deps: DependencyInfo[];
  updates: DepUpdateInfo[];
  /** Tool name → plugins running Vibo's copy of it as a background program. */
  services?: Record<string, DependencyService[]>;
  installing: Record<string, InstallProgress>;
  checkAll: (forceRefresh?: boolean) => Promise<unknown>;
  checkUpdates: (force?: boolean) => Promise<unknown>;
  installDep: (name: string) => Promise<string | null>;
  /** The last install failure per tool, shared with the update notice. */
  installErrors?: Record<string, DepInstallError>;
  uninstallManaged: (name: string) => Promise<void>;
  registry: DependencyRegistry;
  /** Plugin id → name, for "Provided by". */
  pluginNames: Record<string, string>;
  reviewDefinitions: (pluginId: string) => Promise<boolean>;
  revokeDefinitions: (pluginId: string) => Promise<void>;
  removeUnused: (name: string) => Promise<void>;
  /** Tools enabled plugins use that nothing installed defines. */
  missingDefinitions: UndefinedTool[];
}

/**
 * Tab-badge count for Extensions → Tools: installable updates, tools a consumer
 * marks required that aren't installed, plugins whose required tools wait for
 * the user's OK, and required tools nothing installed defines.
 */
export function dependencyAttentionCount(
  deps: DependencyInfo[],
  updates: DepUpdateInfo[],
  registry?: Pick<DependencyRegistry, "pendingConsent">,
  missingDefinitions: UndefinedTool[] = [],
): number {
  // A copy installed outside Vibo is the package manager's to update: its row
  // shows the upgrade command, but it never asks for attention (a Homebrew
  // yt-dlp is always "behind" the nightly channel Vibo follows).
  const outdated = updates.filter((u) => u.outdated && u.origin !== "system").length;
  const missingRequired = deps.filter(
    (d) => d.status !== "installed" && [...d.internalConsumers, ...d.pluginConsumers].some((c) => c.required),
  ).length;
  const waiting = new Set((registry?.pendingConsent ?? []).filter((p) => p.required).map((p) => p.pluginId)).size;
  const undefinedRequired = missingDefinitions.filter((m) => m.required).length;
  return outdated + missingRequired + waiting + undefinedRequired;
}

/**
 * "Running · started by Soulseek · since 10:42" / "Not running" for each
 * plugin that registered a background program on this tool. Status only:
 * starting and stopping it is the plugin's.
 */
export function serviceLines(
  services: DependencyService[] | undefined,
  pluginName: (pluginId: string) => string,
  formatTime: (unixSecs: number) => string = (s) =>
    new Date(s * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
): { running: boolean; text: string }[] {
  return (services ?? []).map((s) => ({
    running: s.running,
    text: s.running
      ? `Running · started by ${pluginName(s.pluginId)}${s.startedAt ? ` · since ${formatTime(s.startedAt)}` : ""}`
      : `Not running · ${pluginName(s.pluginId)}`,
  }));
}

/**
 * External-binary dependencies (ffmpeg, yt-dlp, …): status, origin, install /
 * update / take-over / stop-managing, and whether a plugin runs one as a
 * background program. Rendered as the Extensions view's Tools tab. Nothing here
 * updates on its own: an update is announced (the update notice, this tab's
 * badge) and installed on the user's click.
 */
export function DependenciesPanel({
  dependencies,
  searchQuery = "",
  isVisible,
}: {
  dependencies: DependenciesApi;
  searchQuery?: string;
  /** The Extensions view stays mounted; checks run when the tab is shown. */
  isVisible: boolean;
}) {
  const [loading, setLoading] = useState(false);
  const [actioning, setActioning] = useState<string | null>(null);
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);
  // Name of the dep whose inline "let Vibo manage" confirm is open.
  const [takeoverConfirm, setTakeoverConfirm] = useState<string | null>(null);
  // Why the last removal of a row failed, until the next attempt on it — "stop
  // it there first". Install failures live in `dependencies.installErrors`, so
  // the update notice shows the same one.
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const setRowError = (name: string, error: unknown) =>
    setRowErrors((prev) => {
      const next = { ...prev };
      if (error === null) delete next[name];
      else next[name] = error instanceof Error ? error.message : String(error);
      return next;
    });

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
    setRowError(name, null);
    try {
      await dependencies.installDep(name);
    } catch (e) {
      // Recorded in `installErrors` by the hook.
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
    setRowError(name, null);
    try {
      await dependencies.uninstallManaged(name);
    } catch (e) {
      console.error("Failed to stop managing dependency:", e);
      setRowError(name, e);
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
                    <span className="settings-pill" title="Its publisher offers no checksum: you confirm every install and update">
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
                {(rowErrors[dep.name] ?? dependencies.installErrors?.[dep.name]) && (
                  <span className="dep-row-error" role="alert" style={{ fontSize: "var(--fs-xs)", color: "var(--error)", whiteSpace: "pre-wrap" }}>
                    {rowErrors[dep.name] ?? dependencies.installErrors?.[dep.name]?.message}
                  </span>
                )}
                {dep.origin === "managed" &&
                  serviceLines(dependencies.services?.[dep.name], nameOf).map((line, i) => (
                    <span
                      key={i}
                      className="dep-service-line"
                      style={{ fontSize: "var(--fs-xs)", color: line.running ? "var(--success)" : "var(--text-tertiary)" }}
                    >
                      {line.running ? "● " : "○ "}
                      {line.text}
                    </span>
                  ))}
                {takeoverConfirm === dep.name && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "8px 10px", background: "var(--bg-tertiary)", borderRadius: "var(--ds-radius)" }}>
                    <span style={{ fontSize: "var(--fs-xs)", color: "var(--text-secondary)" }}>
                      Vibo will download its own copy of {dep.name} and tell you when an update is available. Your existing system copy is left in place but no longer used — you can remove it later via your package manager.
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
          {dependencies.missingDefinitions.map((m) => (
            <div className="settings-row" key={`undefined:${m.name}`}>
              <div className="settings-row-info">
                <span className="settings-label">
                  {m.name}
                  <span style={{ fontSize: "var(--fs-xs)", color: m.required ? "var(--warning)" : "var(--text-tertiary)", fontWeight: 500, marginLeft: 8 }}>
                    Not available
                  </span>
                </span>
                <span className="settings-description">
                  {m.plugins.join(", ")} {m.plugins.length > 1 ? "use" : "uses"} {m.name}
                  {m.required ? "" : " (optional)"}, but no installed plugin tells Vibo how to get it. Installing
                  the plugin that provides it, or updating {m.plugins.length > 1 ? "these" : "this one"}, adds it here.
                </span>
              </div>
            </div>
          ))}
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
        </div>
      </div>
    </div>
  );
}
