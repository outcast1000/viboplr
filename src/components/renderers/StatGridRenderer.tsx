import type { RendererProps } from "./index";
import type { StatGridData } from "../../types/informationTypes";

export function StatGridRenderer({ data }: RendererProps) {
  const d = data as StatGridData;
  if (!d?.items?.length) return null;

  return (
    <div className="renderer-stat-grid">
      {d.items.map((item, i) => (
        <div key={i} className="stat-grid-item">
          <span className="stat-grid-value">
            {typeof item.value === "number" ? item.value.toLocaleString() : item.value}
            {item.unit && <span className="stat-grid-unit"> {item.unit}</span>}
          </span>
          <span className="stat-grid-label">{item.label}</span>
        </div>
      ))}
    </div>
  );
}
