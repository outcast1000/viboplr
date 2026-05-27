import { useEffect, useRef, useState } from "react";
import type { HeroOverflowItem } from "../utils/heroOverflow";

interface Props {
  items: HeroOverflowItem[];
  triggerLabel?: string;
}

export function HeroOverflowMenu({ items, triggerLabel = "More options" }: Props) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (items.length === 0) return null;

  return (
    <div className="hero-overflow-wrapper" ref={wrapperRef}>
      <button
        className="ds-btn ds-btn--secondary hero-overflow-trigger"
        title={triggerLabel}
        aria-label={triggerLabel}
        onClick={(e) => { e.stopPropagation(); setOpen(v => !v); }}
      >
        &#x22EF;
      </button>
      {open && (
        <div className="hero-overflow-dropdown" role="menu">
          {items.map((item, i) => (
            item.kind === "divider"
              ? <div key={`d-${i}`} className="hero-overflow-divider" />
              : (
                <button
                  key={item.id}
                  className={`hero-overflow-item${item.danger ? " hero-overflow-item--danger" : ""}`}
                  role="menuitem"
                  onClick={() => { setOpen(false); item.onClick(); }}
                >
                  {item.label}
                </button>
              )
          ))}
        </div>
      )}
    </div>
  );
}
