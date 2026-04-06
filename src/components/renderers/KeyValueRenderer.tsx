import type { RendererProps } from "./index";
import type { KeyValueData } from "../../types/informationTypes";

export function KeyValueRenderer({ data }: RendererProps) {
  const d = data as KeyValueData;
  if (!d?.items?.length) return null;

  return (
    <div className="renderer-key-value">
      {d.items.map((item, i) => (
        <div key={i} className="kv-row">
          <span className="kv-key">{item.key}</span>
          <span className="kv-value">{item.value}</span>
        </div>
      ))}
    </div>
  );
}
