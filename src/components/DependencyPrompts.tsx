import { createPortal } from "react-dom";
import type { DefinitionConsentRequest, UnverifiedInstallRequest } from "../hooks/useDependencies";
import "./DependencyPrompts.css";

// The two questions the dependency system asks before it downloads a program a
// plugin defined (dependency_registry.rs): whether an unsigned plugin's
// definitions may be used at all, and — every time — whether to fetch a
// download nothing can check. Portalled to the root so they stack above any
// dialog that led here. Modal rule: no overlay dismiss; Cancel is the default.

export function DefinitionConsentDialog({
  request,
  onAnswer,
}: {
  request: DefinitionConsentRequest;
  onAnswer: (ok: boolean) => void;
}) {
  const many = request.items.length > 1;
  // A tool the user installs themselves is only run, never downloaded.
  const downloads = request.items.some((i) => i.repo);
  return createPortal(
    <div className="ds-modal-overlay">
      <div className="ds-modal" style={{ width: 480 }} role="alertdialog" aria-labelledby="definition-consent-title">
        <h2 className="ds-modal-title" id="definition-consent-title">
          {request.pluginName} isn't signed by Vibo
        </h2>
        <p className="delete-confirm-warning">
          It wants Vibo to {downloads ? "download and run" : "run"} {many ? "these programs" : "this program"} for it:
        </p>
        <ul className="definition-consent-list">
          {request.items.map((item) => (
            <li key={item.fingerprint}>
              <strong>{item.name}</strong>
              {item.repo ? <> from github.com/{item.repo}</> : <> (you install it yourself)</>}
              {item.repo && !item.verified && <> — nothing checks the download</>}
              {!item.required && <> — optional</>}
            </li>
          ))}
        </ul>
        <p className="delete-confirm-warning">
          Nobody has checked this plugin. A program it has Vibo {downloads ? "install" : "run"} runs with
          the same access you have — your files, your network, your accounts. Only allow it if you trust
          where this plugin came from.
        </p>
        <div className="ds-modal-actions">
          <button className="ds-btn ds-btn--ghost" autoFocus onClick={() => onAnswer(false)}>
            Cancel
          </button>
          <button className="ds-btn ds-btn--danger" onClick={() => onAnswer(true)}>
            Allow anyway
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function UnverifiedInstallConfirm({
  request,
  onAnswer,
}: {
  request: UnverifiedInstallRequest;
  onAnswer: (ok: boolean) => void;
}) {
  return createPortal(
    <div className="ds-modal-overlay">
      <div className="ds-modal" style={{ width: 460 }} role="alertdialog" aria-labelledby="unverified-install-title">
        <h2 className="ds-modal-title" id="unverified-install-title">
          {request.update ? "Update" : "Install"} {request.name} without a checksum?
        </h2>
        <p className="delete-confirm-warning">
          Vibo will download {request.name}
          {request.repo ? <> from the latest release of github.com/{request.repo}</> : null}. Its
          publisher offers no checksum, so nothing can confirm the file is the one they released —
          only that it came from GitHub.
        </p>
        <p className="delete-confirm-warning">
          You'll be asked each time it is installed or updated, and it never updates on its own.
        </p>
        <div className="ds-modal-actions">
          <button className="ds-btn ds-btn--ghost" autoFocus onClick={() => onAnswer(false)}>
            Cancel
          </button>
          <button className="ds-btn ds-btn--primary" onClick={() => onAnswer(true)}>
            {request.update ? "Update" : "Install"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
