import type { RendererProps } from "./index";
import type { TitleLineData } from "../../types/informationTypes";
import { formatCompactCount } from "../../utils/formatCount";

export function TitleLineRenderer({ data }: RendererProps) {
  const d = data as TitleLineData;
  if (!d?.items?.length) return null;

  return (
    <span className="renderer-title-line">
      {d.items.map((item, i) => (
        <span key={i}>
          {i > 0 && " \u00B7 "}
          {typeof item.value === "number" ? (
            // Compact in the line ("10.4k"), exact on hover \u2014 a title line is
            // a glance surface, and 8-digit counts crowd out the labels.
            <span title={item.value.toLocaleString()}>{formatCompactCount(item.value)}</span>
          ) : (
            item.value
          )}{" "}
          {item.label}
        </span>
      ))}
    </span>
  );
}
