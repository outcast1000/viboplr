import { renderers } from "./renderers";
import type { RetrieveModalData, ProviderRow, ProviderStatus } from "../hooks/useRetrieveModal";
import "./RetrieveModal.css";

interface RetrieveModalProps {
  modal: RetrieveModalData;
  onTryNext: () => void;
  onApplyNow: () => void;
  onCancel: () => void;
  onSetKeepOpen: (keep: boolean) => void;
}

function StatusIcon({ status }: { status: ProviderStatus }) {
  if (status === "found") {
    return (
      <svg className="rm-row-icon rm-row-icon--ok" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    );
  }
  if (status === "not_found" || status === "error") {
    return (
      <svg className="rm-row-icon rm-row-icon--fail" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    );
  }
  if (status === "fetching") return <span className="rm-row-icon rm-row-spinner" aria-hidden />;
  return <span className="rm-row-icon rm-row-dot" aria-hidden />;
}

function statusText(status: ProviderStatus): string {
  switch (status) {
    case "fetching": return "searching…";
    case "found": return "found";
    case "not_found": return "not found";
    case "error": return "error";
    default: return "pending";
  }
}

function ProviderChecklist({ providers, currentIndex }: { providers: ProviderRow[]; currentIndex: number }) {
  return (
    <ul className="rm-providers">
      {providers.map((p, i) => (
        <li key={p.id} className={`rm-row rm-row--${p.status}${i === currentIndex ? " rm-row--current" : ""}`}>
          <StatusIcon status={p.status} />
          <span className="rm-row-name">{p.name}</span>
          <span className="rm-row-status">{statusText(p.status)}</span>
        </li>
      ))}
    </ul>
  );
}

function Preview({ modal }: { modal: RetrieveModalData }) {
  if (modal.kind === "image" && modal.imagePreview) {
    return <div className="rm-preview"><img className="rm-image" src={modal.imagePreview.src} alt="" /></div>;
  }
  if (modal.kind === "info" && modal.infoPreview && modal.displayKind) {
    const Renderer = renderers[modal.displayKind];
    if (Renderer) return <div className="rm-preview rm-preview--info"><Renderer data={modal.infoPreview} /></div>;
    return <div className="rm-preview rm-preview--info"><pre className="rm-json">{JSON.stringify(modal.infoPreview, null, 2)}</pre></div>;
  }
  return null;
}

/**
 * Centered modal for user-triggered image & info retrieval. The provider chain
 * runs automatically (auto-fallback); each provider shows as a checklist row.
 * When a provider returns a result the chain pauses, previews it, and a grace
 * countdown auto-applies unless the user picks "Try next" or toggles Keep open.
 * No overlay-click dismiss (per app modal rules).
 */
export function RetrieveModal({ modal, onTryNext, onApplyNow, onCancel, onSetKeepOpen }: RetrieveModalProps) {
  const { phase } = modal;
  const paused = phase === "paused";
  const busy = phase === "running" || phase === "applying";
  const applied = phase === "applied";

  const statusLine = (() => {
    if (phase === "running") return `Searching ${modal.providers[modal.currentIndex]?.name ?? ""}…`;
    if (phase === "applying") return "Applying…";
    if (phase === "applied") return "✓ Applied";
    if (phase === "exhausted") return modal.message ?? "No result found";
    if (phase === "paused") {
      const name = modal.providers[modal.currentIndex]?.name ?? "a provider";
      return modal.countdown != null
        ? `Found via ${name} · applying in ${modal.countdown}s…`
        : `Found via ${name}`;
    }
    return "";
  })();

  return (
    <div className="ds-modal-overlay">
      <div className="ds-modal ds-modal--lg rm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ds-modal-title">{modal.label}</div>
        <div className="rm-subtitle" title={modal.title}>{modal.title}</div>

        <ProviderChecklist providers={modal.providers} currentIndex={modal.currentIndex} />

        {(paused || applied) && <Preview modal={modal} />}

        <div className={`rm-statusline rm-statusline--${phase}`}>{statusLine}</div>

        {!applied && (
          <label className="rm-keepopen">
            <span className={`ds-toggle${modal.keepOpen ? " on" : ""}`} onClick={() => onSetKeepOpen(!modal.keepOpen)}>
              <span className="ds-toggle-thumb" />
            </span>
            <span className="rm-keepopen-label">Keep open (don’t auto-close)</span>
          </label>
        )}

        <div className="ds-modal-actions">
          <button className="ds-btn ds-btn--ghost" onClick={onCancel}>
            {applied ? "Close" : "Cancel"}
          </button>
          {paused && (
            <button className="ds-btn ds-btn--secondary" onClick={onTryNext} disabled={modal.currentIndex >= modal.providers.length - 1}>
              Try next
            </button>
          )}
          {paused && (
            <button className="ds-btn ds-btn--primary" onClick={onApplyNow}>
              {modal.countdown != null ? `Apply now (${modal.countdown})` : "Apply"}
            </button>
          )}
          {busy && (
            <button className="ds-btn ds-btn--primary" disabled>
              <span className="ds-spinner ds-spinner--sm" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
