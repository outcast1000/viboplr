import { ConfirmModal } from "./ConfirmModal";

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
  return (
    <ConfirmModal
      portal
      width={460}
      role="alertdialog"
      title={`${pluginName} isn't signed by Vibo`}
      messageClassName="delete-confirm-warning"
      message={<>
        It asks to download and run programs on this computer. Nobody has checked this plugin, and a
        program it installs runs outside Vibo with the same access you have — your files, your network,
        your accounts — and can keep running after Vibo quits.
      </>}
      destructive
      confirmLabel="Allow anyway"
      autoFocusCancel
      onCancel={onCancel}
      onConfirm={onAllow}
    >
      <p className="delete-confirm-warning">
        Only allow it if you trust where this plugin came from.
      </p>
    </ConfirmModal>
  );
}
