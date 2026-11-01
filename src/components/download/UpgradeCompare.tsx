import { Fragment } from "react";
import { formatFileSize } from "../../utils";
import { describeFileQuality, formatLength, judgeUpgrade, type FileAudioFacts } from "../../utils/downloadCompare";
import type { UpgradePreviewInfo } from "./types";

function Field({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="dl-field">
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

/** The in-place upgrade's "Compare files" step: the library file next to the
 *  downloaded one. A downgrade makes keeping both the default action. */
export function UpgradeCompare({
  preview,
  facts,
  providerName,
  resolvedQuality,
  confirming,
  onBack,
  onReplace,
  onSaveAsCopy,
  onCancel,
}: {
  preview: UpgradePreviewInfo;
  facts: { old: FileAudioFacts | null; new: FileAudioFacts | null } | null;
  providerName: string;
  /** The provider's own account of what it fetched, when it gave one. */
  resolvedQuality: string | null;
  confirming: boolean;
  onBack: () => void;
  onReplace: () => void;
  onSaveAsCopy: () => void;
  onCancel: () => void;
}) {
  const verdict = facts ? judgeUpgrade(preview.old_format, facts.old, preview.new_format, facts.new) : null;
  const columns = [
    {
      heading: "Current file",
      format: preview.old_format,
      quality: describeFileQuality(preview.old_format, facts?.old ?? null),
      length: formatLength(facts?.old?.duration_secs),
      size: preview.old_file_size,
    },
    {
      heading: `${providerName} version`,
      format: preview.new_format,
      quality: resolvedQuality ?? describeFileQuality(preview.new_format, facts?.new ?? null),
      length: formatLength(facts?.new?.duration_secs),
      size: preview.new_file_size,
    },
  ];

  return (
    <>
      <h3>Compare files</h3>
      <div className="dl-compare">
        {columns.map((c, i) => (
          <Fragment key={c.heading}>
            {i > 0 && <div className="dl-compare-arrow">{"→"}</div>}
            <div className="dl-compare-col">
              <h4>{c.heading}</h4>
              <Field label="Format" value={c.format?.toUpperCase() ?? "—"} />
              <Field label="Quality" value={c.quality} />
              <Field label="Length" value={c.length} />
              <Field label="Size" value={formatFileSize(c.size)} />
            </div>
          </Fragment>
        ))}
      </div>
      {verdict?.warning && <div className="dl-warn">{verdict.warning}</div>}
      <div className="dl-actions">
        <button onClick={onBack}>Back</button>
        {/* A downgrade makes keeping both the default; Replace stays one click away. */}
        <button className={verdict?.downgrade ? "dl-btn-secondary" : "dl-btn-primary"} onClick={onReplace} disabled={confirming}>
          {confirming ? "Replacing..." : "Replace"}
        </button>
        <button className={verdict?.downgrade ? "dl-btn-primary" : "dl-btn-secondary"} onClick={onSaveAsCopy} disabled={confirming}>
          {confirming ? "Saving..." : "Save as Copy"}
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </>
  );
}
