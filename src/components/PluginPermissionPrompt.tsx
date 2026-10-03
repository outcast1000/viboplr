import { useState } from "react";
import { PermissionList } from "./PermissionList";

// Asks the user about one plugin's permissions at the moment they apply: after
// an update that brought a NEW permission, or after an install that had no
// dialog of its own (from a URL, from the setup wizard). Gallery installs ask
// in their own install dialog instead (PluginInstallModal).
//
// Built-in plugins never get here — they're pre-approved — and neither does an
// update that asks for nothing new (owner decision, 2026-10-03).
//
// Follows the modal rule: no overlay dismiss, explicit buttons only. "Not now"
// leaves the plugin waiting, approvable later from its Extensions detail pane.

export interface PluginPermissionPromptProps {
  pluginName: string;
  mode: "install" | "update";
  /** Everything the plugin's manifest asks for. */
  requested: string[];
  /** The part not yet approved. On an update these are badged "new". */
  pending: string[];
  /** Grants `requested` (and, for an install, enables the plugin). */
  onAllow: () => Promise<void>;
  onNotNow: () => void;
}

export function PluginPermissionPrompt({ pluginName, mode, requested, pending, onAllow, onNotNow }: PluginPermissionPromptProps) {
  const [working, setWorking] = useState(false);
  const pendingSet = new Set(pending);
  const isPartial = mode === "update" && pending.length < requested.length;
  const allow = async () => {
    setWorking(true);
    try {
      await onAllow();
    } finally {
      setWorking(false);
    }
  };
  return (
    <div className="ds-modal-overlay">
      <div className="ds-modal" style={{ width: 440 }} onClick={(e) => e.stopPropagation()}>
        <h2 className="ds-modal-title">
          {mode === "update" ? `${pluginName} needs new permissions` : `Allow ${pluginName}?`}
        </h2>
        <p className="delete-confirm-warning">
          {mode === "update"
            ? isPartial
              ? "The update asks for more than you allowed before. It won't run until you allow the new ones."
              : "The update asks for the permissions below. It won't run until you allow them."
            : "This plugin asks for the permissions below. It can't do anything outside this list."}
        </p>
        <div className="plugin-install-perms">
          <PermissionList requested={requested} pending={pendingSet} markNew={isPartial} />
        </div>
        <div className="ds-modal-actions">
          <button className="ds-btn ds-btn--ghost" onClick={onNotNow} disabled={working}>
            Not now
          </button>
          <button className="ds-btn ds-btn--primary" autoFocus onClick={allow} disabled={working}>
            {working ? "Starting…" : mode === "install" ? "Allow and enable" : "Allow and start"}
          </button>
        </div>
      </div>
    </div>
  );
}
