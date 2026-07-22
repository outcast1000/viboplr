import type { DownloadQualityOption } from "../../types/plugin";

/**
 * Quality/format picker for the download window (design "Polished rows").
 * - 1 option  → static label
 * - 2–3       → segmented pill control
 * - 4+        → native <select> (pills would overflow the modal)
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
  if (qualities.length <= 1) {
    return <span className="dl-qual-single">{qualities[0]?.label ?? "—"}</span>;
  }

  if (qualities.length <= 3) {
    return (
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
    );
  }

  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {qualities.map((q) => (
        <option key={q.value} value={q.value}>{q.label}</option>
      ))}
    </select>
  );
}
