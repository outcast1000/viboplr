import { useEffect, useState } from "react";
import type { GalleryPluginEntry } from "../types/plugin";
import {
  computeInitialSelection,
  computeInstallEntries,
} from "./firstRunSelection";

interface Props {
  entries: GalleryPluginEntry[];
  installedIds: Set<string>;
  /** Install one entry. Returns ok/error so the modal can show per-row state. */
  onInstallEntry: (entry: GalleryPluginEntry) => Promise<{ ok: boolean; error?: string }>;
  /** Called once the batch finishes (or on skip). Parent sets the flag + closes. */
  onDone: () => void;
}

export function FirstRunPluginModal({
  entries,
  installedIds,
  onInstallEntry,
  onDone,
}: Props) {
  const [checked, setChecked] = useState<Set<string>>(() =>
    computeInitialSelection(entries, installedIds),
  );
  const [installing, setInstalling] = useState<Set<string>>(new Set());
  const [done, setDone] = useState<Set<string>>(new Set());
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  // Escape acts as Skip (but not while a batch install is in progress).
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onDone();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [busy, onDone]);

  function toggle(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const toInstall = computeInstallEntries(entries, checked, installedIds);

  async function handleInstall() {
    if (toInstall.length === 0) {
      onDone();
      return;
    }
    setBusy(true);
    let anyFailed = false;
    for (const entry of toInstall) {
      setInstalling((prev) => new Set(prev).add(entry.id));
      let ok = false;
      try {
        const res = await onInstallEntry(entry);
        ok = res.ok;
        if (!res.ok) {
          console.error(`Failed to install plugin "${entry.id}":`, res.error);
        }
      } catch (e) {
        console.error(`Failed to install plugin "${entry.id}":`, e);
      } finally {
        setInstalling((prev) => {
          const next = new Set(prev);
          next.delete(entry.id);
          return next;
        });
        if (ok) {
          setDone((prev) => new Set(prev).add(entry.id));
        } else {
          anyFailed = true;
          setFailed((prev) => new Set(prev).add(entry.id));
        }
      }
    }
    setBusy(false);
    // If everything installed, close. If any failed, keep the modal open so the
    // user sees which plugins failed and can retry or dismiss manually.
    if (!anyFailed) onDone();
  }

  const installLabel =
    toInstall.length > 0 ? `Install ${toInstall.length} plugin${toInstall.length === 1 ? "" : "s"}` : "Install";

  return (
    <div className="ds-modal-overlay">
      <div className="ds-modal ds-modal--lg" onClick={(e) => e.stopPropagation()}>
        <h2 className="ds-modal-title">Recommended plugins</h2>
        <p className="first-run-intro">
          Get more out of the app with these plugins. Recommended ones are
          pre-selected — adjust the list and install, or skip for now.
        </p>

        <div className="first-run-list">
          {entries.map((entry) => {
            const isInstalled = installedIds.has(entry.id);
            const isInstalling = installing.has(entry.id);
            const isDone = done.has(entry.id);
            const isFailed = failed.has(entry.id);
            return (
              <label
                key={entry.id}
                className={`first-run-row${isInstalled ? " is-installed" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={isInstalled ? false : checked.has(entry.id)}
                  disabled={isInstalled || busy}
                  onChange={() => toggle(entry.id)}
                />
                {entry.icon ? (
                  <svg
                    className="first-run-icon"
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d={entry.icon} />
                  </svg>
                ) : (
                  <span className="first-run-icon first-run-icon--placeholder" />
                )}
                <span className="first-run-meta">
                  <span className="first-run-name">
                    {entry.name}
                    {entry.recommended && (
                      <span className="first-run-badge">Recommended</span>
                    )}
                  </span>
                  <span className="first-run-desc">{entry.description}</span>
                </span>
                <span
                  className={`first-run-status${isFailed ? " is-failed" : ""}`}
                >
                  {isInstalled
                    ? "Installed"
                    : isInstalling
                      ? "Installing…"
                      : isFailed
                        ? "Failed"
                        : isDone
                          ? "Done"
                          : ""}
                </span>
              </label>
            );
          })}
        </div>

        <div className="ds-modal-actions">
          <button
            className="ds-btn ds-btn--ghost"
            onClick={onDone}
            disabled={busy}
          >
            Skip
          </button>
          <button
            className="ds-btn ds-btn--primary"
            onClick={handleInstall}
            disabled={busy || toInstall.length === 0}
          >
            {busy ? "Installing…" : installLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
