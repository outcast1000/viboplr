import { formatFileSize } from "../utils";

// Progress dialog for a gallery plugin install. Opens the instant "Install" is
// pressed and walks the backend phases (resolving → downloading → installing),
// then folds the enable-now choice in as its final step instead of a separate
// modal. Skin-safe; follows the "modals never dismiss on overlay click" rule —
// the only way out is an explicit button (Cancel / Not now / Done / Close).

export type InstallPhase =
  | "resolving"
  | "downloading"
  | "installing"
  | "done"
  | "error";

export interface InstallFlowState {
  id: string;
  name: string;
  phase: InstallPhase;
  downloaded?: number;
  total?: number | null;
  error?: string;
  // Set while a cancel request is in flight (disables the Cancel button).
  cancelling?: boolean;
  // "done" step: the freshly installed plugin landed disabled, so offer Enable.
  needsEnable?: boolean;
}

interface Props {
  flow: InstallFlowState;
  onCancel: () => void; // during resolving/downloading
  onEnable: () => void; // done step → enable the plugin
  onClose: () => void; // done (not now) / error dismiss
  onRetry: () => void; // error → try again
}

const PHASE_LABEL: Record<Exclude<InstallPhase, "done" | "error">, string> = {
  resolving: "Preparing…",
  downloading: "Downloading…",
  installing: "Installing…",
};

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function ErrorIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <path d="M15 9l-6 6M9 9l6 6" />
    </svg>
  );
}

export function PluginInstallModal({ flow, onCancel, onEnable, onClose, onRetry }: Props) {
  const working = flow.phase === "resolving" || flow.phase === "downloading" || flow.phase === "installing";
  const canCancel = flow.phase === "resolving" || flow.phase === "downloading";

  // Determinate only while downloading with a known content length; otherwise the
  // bar pulses to signal indeterminate work.
  const pct =
    flow.phase === "downloading" && flow.total
      ? Math.min(100, Math.round((flow.downloaded! / flow.total) * 100))
      : flow.phase === "installing"
        ? 100
        : null;

  return (
    <div className="ds-modal-overlay">
      <div className="ds-modal" style={{ width: 400 }} onClick={(e) => e.stopPropagation()}>
        {working && (
          <>
            <h2 className="ds-modal-title">Installing {flow.name}</h2>
            <div className="plugin-install-body">
              <div className="plugin-install-phase">
                <span>{PHASE_LABEL[flow.phase as Exclude<InstallPhase, "done" | "error">]}</span>
                {flow.phase === "downloading" && flow.downloaded != null && (
                  <span className="plugin-install-bytes">
                    {formatFileSize(flow.downloaded)}
                    {flow.total ? ` / ${formatFileSize(flow.total)}` : ""}
                    {pct != null ? ` · ${pct}%` : ""}
                  </span>
                )}
              </div>
              <div className="plugin-install-track">
                <div
                  className={`plugin-install-fill${pct == null ? " plugin-install-fill--indeterminate" : ""}`}
                  style={{ width: pct == null ? "100%" : `${pct}%` }}
                />
              </div>
            </div>
            {canCancel && (
              <div className="ds-modal-actions">
                <button className="ds-btn ds-btn--ghost" onClick={onCancel} disabled={flow.cancelling}>
                  {flow.cancelling ? "Cancelling…" : "Cancel"}
                </button>
              </div>
            )}
          </>
        )}

        {flow.phase === "done" && (
          <>
            <h2 className="ds-modal-title plugin-install-title-icon">
              <span className="plugin-install-badge plugin-install-badge--ok"><CheckIcon /></span>
              {flow.name} installed
            </h2>
            <p className="delete-confirm-warning">
              {flow.needsEnable
                ? `${flow.name} is installed but not active yet. Enable it now?`
                : `${flow.name} is ready to use.`}
            </p>
            <div className="ds-modal-actions">
              {flow.needsEnable ? (
                <>
                  <button className="ds-btn ds-btn--ghost" onClick={onClose}>Not now</button>
                  <button className="ds-btn ds-btn--primary" autoFocus onClick={onEnable}>Enable</button>
                </>
              ) : (
                <button className="ds-btn ds-btn--primary" autoFocus onClick={onClose}>Done</button>
              )}
            </div>
          </>
        )}

        {flow.phase === "error" && (
          <>
            <h2 className="ds-modal-title plugin-install-title-icon">
              <span className="plugin-install-badge plugin-install-badge--err"><ErrorIcon /></span>
              Couldn't install {flow.name}
            </h2>
            <p className="delete-confirm-warning">
              {flow.error || "Something went wrong. Please try again."}
            </p>
            <div className="ds-modal-actions">
              <button className="ds-btn ds-btn--ghost" onClick={onClose}>Close</button>
              <button className="ds-btn ds-btn--primary" autoFocus onClick={onRetry}>Try again</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
