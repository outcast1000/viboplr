import { createPortal } from "react-dom";
import { PermissionList } from "./PermissionList";

// Host dialogs for `api.system.programs`, raised by usePlugins and rendered by
// App. Portalled to the document root so they stack above whatever is open.
// Modal rule: no overlay dismiss; the safe answer is the focused one.

export interface OptionalPermissionsPromptProps {
  pluginName: string;
  permissions: string[];
  reasons?: Record<string, string>;
  onAllow: () => void;
  onCancel: () => void;
}

/** The first time a plugin uses one of its `optionalPermissions`: the feature
 *  the user just started (installing a program for them) needs these. */
export function OptionalPermissionsPrompt({ pluginName, permissions, reasons, onAllow, onCancel }: OptionalPermissionsPromptProps) {
  return createPortal(
    <div className="ds-modal-overlay">
      <div className="ds-modal" style={{ width: 440 }} role="dialog" aria-labelledby="optional-perms-title">
        <h2 className="ds-modal-title" id="optional-perms-title">{pluginName} needs more access</h2>
        <p className="delete-confirm-warning">
          What you just asked for needs the permissions below. The plugin works without them otherwise,
          and you can take them back in Extensions.
        </p>
        <div className="plugin-install-perms">
          <PermissionList requested={permissions} reasons={reasons} />
        </div>
        <div className="ds-modal-actions">
          <button className="ds-btn ds-btn--ghost" autoFocus onClick={onCancel}>
            Not now
          </button>
          <button className="ds-btn ds-btn--primary" onClick={onAllow}>
            Allow
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export interface ProgramInstallConfirmProps {
  pluginName: string;
  fileName: string;
  host: string;
  url: string;
  pinned: boolean;
  label: string | null;
  onInstall: () => void;
  onCancel: () => void;
}

/** Before every program download: each install and update is the user's call. */
export function ProgramInstallConfirm({ pluginName, fileName, host, url, pinned, label, onInstall, onCancel }: ProgramInstallConfirmProps) {
  return createPortal(
    <div className="ds-modal-overlay">
      <div className="ds-modal" style={{ width: 460 }} role="dialog" aria-labelledby="program-install-title">
        <h2 className="ds-modal-title" id="program-install-title">Install a program for {pluginName}?</h2>
        <p className="delete-confirm-warning">
          {pluginName} wants to download a program and run it on this computer.
        </p>
        <dl className="program-install-facts">
          {label && (
            <>
              <dt>The plugin says</dt>
              <dd>{label}</dd>
            </>
          )}
          <dt>File</dt>
          <dd>{fileName}</dd>
          <dt>From</dt>
          <dd title={url}>{host}</dd>
          <dt>Checked</dt>
          <dd>{pinned ? "Only this exact file is accepted (its checksum is pinned)" : "Not checked against a known checksum"}</dd>
        </dl>
        <div className="ds-modal-actions">
          <button className="ds-btn ds-btn--ghost" autoFocus onClick={onCancel}>
            Cancel
          </button>
          <button className="ds-btn ds-btn--primary" onClick={onInstall}>
            Install
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
