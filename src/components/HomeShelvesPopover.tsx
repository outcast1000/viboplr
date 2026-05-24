import "./HomeView.css";

export interface HomeShelvesPopoverProps {
  shelves: Array<{ id: string; title: string }>;
  visibility: Record<string, boolean>;
  onChange: (id: string, visible: boolean) => void;
  onClose: () => void;
}

export function HomeShelvesPopover({
  shelves,
  visibility,
  onChange,
  onClose,
}: HomeShelvesPopoverProps) {
  return (
    <>
      <div className="home-shelves-popover-backdrop" onClick={onClose} />
      <div className="home-shelves-popover">
        <div className="home-shelves-popover-title">Show shelves</div>
        {shelves.map((s) => (
          <label key={s.id} className="home-shelves-popover-row">
            <input
              type="checkbox"
              checked={visibility[s.id] !== false}
              onChange={(e) => onChange(s.id, e.target.checked)}
            />
            <span>{s.title}</span>
          </label>
        ))}
      </div>
    </>
  );
}
