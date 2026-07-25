import type { DownloadQualityOption } from "../../types/plugin";

/**
 * Quality/format picker for the download window (design "Polished rows").
 * - 1 option  → static label
 * - 2–3       → segmented pill control
 * - 4+        → native <select> (pills would overflow the modal)
 * The SELECTED option's `description` (when the provider supplies one) renders
 * as muted helper text under the control — labels stay short, caveats go there.
 */
export function QualitySelect({
  qualities,
  value,
  onChange,
}: {
  qualities: DownloadQualityOption[];
  value: string;
  onChange: (value: string) => void;
}) {
  const selectedDesc = qualities.find((q) => q.value === value)?.description
    ?? (qualities.length <= 1 ? qualities[0]?.description : undefined);
  const desc = selectedDesc ? <span className="dl-qual-desc">{selectedDesc}</span> : null;

  if (qualities.length <= 1) {
    return (
      <span className="dl-qual-wrap">
        <span className="dl-qual-single">{qualities[0]?.label ?? "—"}</span>
        {desc}
      </span>
    );
  }

  if (qualities.length <= 3) {
    return (
      <span className="dl-qual-wrap">
        <span className="dl-seg" role="radiogroup" aria-label="Quality">
          {qualities.map((q) => (
            <button
              key={q.value}
              type="button"
              role="radio"
              aria-checked={q.value === value}
              className={q.value === value ? "on" : ""}
              onClick={() => onChange(q.value)}
            >
              {q.label}
            </button>
          ))}
        </span>
        {desc}
      </span>
    );
  }

  return (
    <span className="dl-qual-wrap">
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {qualities.map((q) => (
          <option key={q.value} value={q.value}>{q.label}</option>
        ))}
      </select>
      {desc}
    </span>
  );
}
