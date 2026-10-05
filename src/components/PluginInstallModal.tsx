import { formatFileSize } from "../utils";
import { PermissionList } from "./PermissionList";

// Progress dialog for a gallery plugin install. Opens the instant "Install" is
// pressed and walks the backend phases (resolving → downloading → installing),
// then folds the enable-now choice in as its final step instead of a separate
// modal. An install an AI assistant asked for (`useAssistantInstall`) opens one
// step earlier, on "confirm": the user's click here is the approval — a "yes"
// in the chat is not, since the assistant could claim one. Skin-safe; follows the "modals never dismiss on overlay click" rule —
// the only way out is an explicit button (Cancel / Not now / Done / Close).

export type InstallPhase =
  | "confirm"
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
  /**
   * "done" step: what a worker-runtime plugin asks for. Installing is where the
   * user is asked (owner decision) — so the enable step shows the list and
   * enabling grants exactly it. Empty/absent = nothing to ask (no permissions,
   * a main-realm plugin, or one whose list was already approved).
   */
  permissions?: string[];
  /** "confirm" step: what the user is being asked to install, and for whom. */
  confirm?: {
    kind: "plugin" | "skin";
    author?: string;
    description?: string;
    experimental?: boolean;
  };
}

interface Props {
  flow: InstallFlowState;
  onCancel: () => void; // during resolving/downloading
  onEnable: () => void; // done step → enable the plugin
  onClose: () => void; // done (not now) / error dismiss
  onRetry: () => void; // error → try again
  onConfirm?: () => void; // confirm → install
  onDecline?: () => void; // confirm → don't install
}

const PHASE_LABEL: Record<Exclude<InstallPhase, "confirm" | "done" | "error">, string> = {
  resolving: "Preparing…",
  downloading: "Downloading…",
  installing: "Installing…",
};

/**
 * Map a raw backend install error to friendly, actionable copy. The gallery
 * install fetches the plugin's `update.json` and zip straight from GitHub
 * (`plugins.rs` / `update_checker.rs`), and those hops surface plain strings:
 *   "HTTP 5xx"                              — GitHub gateway/upstream blip (504 is the common one)
 *   "HTTP error: …" / "Download failed: …"  — request never got a response (timeout / connection)
 *   "Read error: …"                         — the stream dropped mid-download
 * All of these are transient and clear on a retry, so they get reassuring copy
 * that points at "Try again". Specific, actionable errors (version requirement,
 * missing updateUrl, parse failures) pass through unchanged so their detail
 * isn't lost; an absent error falls back to a generic line.
 */
export function friendlyInstallError(raw?: string): string {
  if (!raw) return "Something went wrong. Please try again.";
  // GitHub gateway/upstream error (500/502/503/504) — almost always transient.
  if (/\bHTTP 5\d\d\b/.test(raw)) {
    return "GitHub is temporarily unavailable — this usually clears in a moment. Try again.";
  }
  // Request timed out (a server 504 is caught above; this is the client side).
  if (/timed?\s?out/i.test(raw)) {
    return "The request to GitHub timed out — check your connection and try again.";
  }
  // No response received, or the stream dropped part-way through the download.
  if (
    /^(?:HTTP error|Download failed|Read error):/i.test(raw) ||
    /connection|network|dns|failed to (?:connect|lookup)|tcp connect/i.test(raw)
  ) {
    return "Couldn't reach GitHub — check your internet connection and try again.";
  }
  return raw;
}

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

export function PluginInstallModal({ flow, onCancel, onEnable, onClose, onRetry, onConfirm, onDecline }: Props) {
  const working = flow.phase === "resolving" || flow.phase === "downloading" || flow.phase === "installing";
  const canCancel = flow.phase === "resolving" || flow.phase === "downloading";
  const asks = (flow.permissions?.length ?? 0) > 0;

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
        {flow.phase === "confirm" && (
          <>
            <h2 className="ds-modal-title">Install {flow.name}?</h2>
            <p className="delete-confirm-warning">
              Your AI assistant asked to install this {flow.confirm?.kind ?? "plugin"} from the Viboplr gallery.
              Nothing is installed unless you say so here.
            </p>
            {flow.confirm?.description && <p className="plugin-install-desc">{flow.confirm.description}</p>}
            {flow.confirm?.author && <p className="plugin-install-meta">by {flow.confirm.author}</p>}
            {flow.confirm?.experimental && (
              <p className="plugin-install-meta">Experimental — it may be rough around the edges.</p>
            )}
            <div className="ds-modal-actions">
              <button className="ds-btn ds-btn--ghost" onClick={onDecline}>Don't install</button>
              {/* No autoFocus: this dialog opens unprompted, so a key the
                  user was already pressing must not answer it for them. */}
              <button className="ds-btn ds-btn--primary" onClick={onConfirm}>Install</button>
            </div>
          </>
        )}

        {working && (
          <>
            <h2 className="ds-modal-title">Installing {flow.name}</h2>
            <div className="plugin-install-body">
              <div className="plugin-install-phase">
                <span>{PHASE_LABEL[flow.phase as Exclude<InstallPhase, "confirm" | "done" | "error">]}</span>
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
              {flow.needsEnable && asks
                ? `${flow.name} asks for the permissions below. It can't do anything outside this list.`
                : flow.needsEnable
                  ? `${flow.name} is installed but not active yet. Enable it now?`
                  : `${flow.name} is ready to use.`}
            </p>
            {flow.needsEnable && asks && (
              <div className="plugin-install-perms">
                <PermissionList requested={flow.permissions!} />
              </div>
            )}
            <div className="ds-modal-actions">
              {flow.needsEnable ? (
                <>
                  <button className="ds-btn ds-btn--ghost" onClick={onClose}>Not now</button>
                  <button className="ds-btn ds-btn--primary" autoFocus onClick={onEnable}>
                    {asks ? "Allow and enable" : "Enable"}
                  </button>
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
            <p className="delete-confirm-warning" title={flow.error || undefined}>
              {friendlyInstallError(flow.error)}
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
