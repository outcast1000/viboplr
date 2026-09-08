import "./UpdateProgress.css";

function formatMb(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/**
 * Live download progress for the app update, shared by Settings → General and
 * the `UpdateNoticeBanner` — the two places an update can be started, which is
 * why it is a component rather than a copy in each. The backend has always
 * streamed `app-update-progress`, but the panel used to render a static
 * "Downloading…" — so a 50 MB download over a slow link was indistinguishable
 * from a hang. `total` is 0 until the first chunk carries a Content-Length, and
 * some servers never send one, so the indeterminate case stays supported.
 */
export function UpdateProgress({ progress }: { progress: { downloaded: number; total: number } | null }) {
  const total = progress?.total ?? 0;
  const downloaded = progress?.downloaded ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : null;

  return (
    <div className="update-progress" role="status" aria-live="polite">
      <div className="update-progress-bar">
        <div
          className={`update-progress-fill ${pct === null ? "is-indeterminate" : ""}`}
          style={pct === null ? undefined : { width: `${pct}%` }}
        />
      </div>
      <span className="update-progress-text">
        {pct === null
          ? `Downloading… ${formatMb(downloaded)}`
          : `Downloading… ${pct}% · ${formatMb(downloaded)} of ${formatMb(total)}`}
      </span>
    </div>
  );
}
