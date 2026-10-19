import { ConfirmModal } from "./ConfirmModal";
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
  return (
    <ConfirmModal
      portal
      width={440}
      title={`${pluginName} needs more access`}
      messageClassName="delete-confirm-warning"
      message={<>
        What you just asked for needs the permissions below. The plugin works without them otherwise,
        and you can take them back in Extensions.
      </>}
      cancelLabel="Not now"
      confirmLabel="Allow"
      autoFocusCancel
      onCancel={onCancel}
      onConfirm={onAllow}
    >
      <div className="plugin-install-perms">
        <PermissionList requested={permissions} reasons={reasons} />
      </div>
    </ConfirmModal>
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
  return (
    <ConfirmModal
      portal
      width={460}
      title={`Install a program for ${pluginName}?`}
      messageClassName="delete-confirm-warning"
      message={`${pluginName} wants to download a program and run it on this computer.`}
      confirmLabel="Install"
      autoFocusCancel
      onCancel={onCancel}
      onConfirm={onInstall}
    >
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
    </ConfirmModal>
  );
}
