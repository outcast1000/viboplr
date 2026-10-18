import { createPortal } from "react-dom";

// The second consent an unsigned plugin needs before it may run programs
// (`programs:run`): the approval the user just gave covers the permission list,
// this one covers the fact that no one has vouched for the code that will run
// outside Vibo. Raised by usePlugins.approvePermissions, so every approval
// surface (install dialog, update prompt, Extensions detail) goes through it.
//
// Portalled to the document root so it stacks above whichever dialog asked.
// Follows the modal rule: no overlay dismiss; Cancel is the safe default.

export interface UnsignedProgramsWarningProps {
  pluginName: string;
  onAllow: () => void;
  onCancel: () => void;
}

export function UnsignedProgramsWarning({ pluginName, onAllow, onCancel }: UnsignedProgramsWarningProps) {
  return createPortal(
    <div className="ds-modal-overlay">
      <div className="ds-modal" style={{ width: 460 }} role="alertdialog" aria-labelledby="unsigned-programs-title">
        <h2 className="ds-modal-title" id="unsigned-programs-title">
          {pluginName} isn't signed by Vibo
        </h2>
        <p className="delete-confirm-warning">
          It asks to download and run programs on this computer. Nobody has checked this plugin, and a
          program it installs runs outside Vibo with the same access you have — your files, your network,
          your accounts — and can keep running after Vibo quits.
        </p>
        <p className="delete-confirm-warning">
          Only allow it if you trust where this plugin came from.
        </p>
        <div className="ds-modal-actions">
          <button className="ds-btn ds-btn--ghost" autoFocus onClick={onCancel}>
            Cancel
          </button>
          <button className="ds-btn ds-btn--danger" onClick={onAllow}>
            Allow anyway
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
