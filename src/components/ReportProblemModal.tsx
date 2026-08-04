import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { LINKS } from "../constants/links";
import { collectDiagnosticReport, issueUrl, type DiagnosticSources } from "../utils/diagnosticReport";
import "./ReportProblemModal.css";

interface Props {
  /** Everything the report needs that only the host knows. */
  sources: DiagnosticSources;
  /** Prefills the GitHub issue title. */
  issueTitle?: string;
  onClose: () => void;
}

/**
 * "Report a problem" — assembles the diagnostic bundle, shows it in full, and
 * lets the user copy it / open a prefilled GitHub issue.
 *
 * Showing the report before it goes anywhere is the point: the bundle carries
 * log lines and resolver activity that telemetry deliberately never sends, so
 * the user has to be able to read exactly what they are about to paste. The
 * report is assembled locally and nothing leaves the app on its own.
 */
export default function ReportProblemModal({ sources, issueTitle = "Bug report", onClose }: Props) {
  const [report, setReport] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    collectDiagnosticReport(sources)
      .then((text) => {
        if (!cancelled) setReport(text);
      })
      .catch((e) => {
        console.error("Failed to build diagnostic report:", e);
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
    // Built once per open — `sources` is a fresh object each render and the
    // snapshot should reflect the moment the user asked for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  async function copyReport(): Promise<boolean> {
    if (!report) return false;
    try {
      await navigator.clipboard.writeText(report);
      setCopied(true);
      return true;
    } catch (e) {
      console.error("Failed to copy diagnostic report:", e);
      return false;
    }
  }

  async function copyAndOpenIssue() {
    // Copy first: the issue body tells the user to paste, so opening the
    // browser without the clipboard set would strand them on an empty form.
    const ok = await copyReport();
    if (!ok) return;
    openUrl(issueUrl(LINKS.issues, issueTitle)).catch((e) =>
      console.error("Failed to open issue page:", e),
    );
  }

  return (
    <div className="ds-modal-overlay">
      <div className="ds-modal ds-modal--xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="ds-modal-title">Report a problem</h2>
        <p className="report-problem-intro">
          This is everything the report contains. Nothing is sent automatically — copy it and paste
          it into a GitHub issue, after adding what you were doing when it went wrong.
        </p>

        {failed ? (
          <p className="report-problem-error">
            Couldn’t assemble the report. Open Settings → Debug → Log files and attach the log
            instead.
          </p>
        ) : report === null ? (
          <div className="report-problem-loading">
            <span className="ds-spinner ds-spinner--sm" /> Collecting diagnostics…
          </div>
        ) : (
          <textarea className="report-problem-text" value={report} readOnly spellCheck={false} />
        )}

        <div className="ds-modal-actions">
          <button className="ds-btn ds-btn--ghost" onClick={onClose}>
            Close
          </button>
          <button className="ds-btn ds-btn--secondary" onClick={copyReport} disabled={!report}>
            {copied ? "Copied" : "Copy"}
          </button>
          <button className="ds-btn ds-btn--primary" onClick={copyAndOpenIssue} disabled={!report}>
            Copy &amp; open GitHub issue
          </button>
        </div>
      </div>
    </div>
  );
}
