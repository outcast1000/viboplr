import {
  isNowPlayingItemSelected,
  nowPlayingItemTop,
  NOW_PLAYING_TOP_PRESETS,
  type NowPlayingInfoDescriptor,
} from "../hooks/useNowPlayingInfo";
import { startRowDrag, reorderList } from "../utils/rowDrag";

/** The single per-item control: "Off" plus every time-of-persistence preset.
 *  Picking a dwell enables the item; picking "Off" hides it. */
export const NOW_PLAYING_DWELL_OPTIONS: { value: string; label: string }[] = [
  { value: "off", label: "Off" },
  ...NOW_PLAYING_TOP_PRESETS.map((p) => ({
    value: String(p),
    label: p === 0 ? "Preview only" : `${p}×`,
  })),
];

/** Read a dwell `<select>` value: `null` = off, else the ToP multiplier.
 *  Pure + exported for tests. */
export function parseDwellValue(value: string): number | null {
  // Guard the empty string explicitly — Number("") is 0, which would otherwise
  // read as the valid "Preview only" preset.
  if (value === "off" || value.trim() === "") return null;
  const n = Number(value);
  return (NOW_PLAYING_TOP_PRESETS as readonly number[]).includes(n) ? n : null;
}

export interface NowPlayingInfoSettingsProps {
  /** Every registered item (built-in + plugin), already in priority order. */
  items: NowPlayingInfoDescriptor[];
  selection: Record<string, boolean>;
  persistence: Record<string, number>;
  /** Set an item's dwell: a ToP multiplier (which also enables it), or `null`
   *  to turn it off. */
  onSetDwell: (id: string, top: number | null) => void;
  /** New priority order (full id list, first = shown first). */
  onReorder: (orderedIds: string[]) => void;
  /** Clear every customization (selection + dwell + order) back to defaults. */
  onReset: () => void;
}

/**
 * Settings > Playback control for the cycling Now Playing info line (mini
 * player). One row per registered item: priority (drag handle + rank) and a
 * single dwell select that doubles as the on/off control ("Off" is just the
 * first option, so there's no separate switch).
 *
 * Reuses the `.provider-v*` list markup/CSS and the shared `startRowDrag`, so
 * it looks and behaves exactly like the Settings > Providers priority lists.
 */
export function NowPlayingInfoSettings({
  items,
  selection,
  persistence,
  onSetDwell,
  onReorder,
  onReset,
}: NowPlayingInfoSettingsProps) {
  const enabledCount = items.filter((d) => isNowPlayingItemSelected(d.id, selection, items)).length;

  const handleReorder = (from: number, to: number) => {
    onReorder(reorderList(items, from, to).map((d) => d.id));
  };

  return (
    <div className="npi-settings">
      <div className="provider-vlist" data-vlist>
        {items.map((d, i) => {
          const enabled = isNowPlayingItemSelected(d.id, selection, items);
          const top = nowPlayingItemTop(d.id, persistence);
          return (
            <div
              key={d.id}
              className={`provider-vrow${!enabled ? " provider-vrow-off" : ""}`}
              data-row-index={i}
            >
              <span
                className="provider-vrow-handle"
                onMouseDown={(e) => startRowDrag(e, i, d.label, handleReorder)}
                title="Drag to reorder"
              >{"⠿"}</span>
              <span className="provider-vrow-rank">{i + 1}</span>
              <span className="provider-vrow-name">{d.label}</span>
              <select
                className="ds-select npi-settings-dwell"
                value={enabled ? String(top) : "off"}
                aria-label={d.label}
                title="Off, shown once per track, or how long it stays on screen (× the ~5s base interval)"
                onChange={(e) => onSetDwell(d.id, parseDwellValue(e.target.value))}
              >
                {NOW_PLAYING_DWELL_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          );
        })}
      </div>
      <div className="npi-settings-footer">
        <span className="settings-description">
          {enabledCount === 1 ? "1 item enabled" : `${enabledCount} items enabled`}
        </span>
        <button type="button" className="ds-btn ds-btn--ghost ds-btn--sm" onClick={onReset}>
          Reset to defaults
        </button>
      </div>
    </div>
  );
}
