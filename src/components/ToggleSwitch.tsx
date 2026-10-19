/** The one on/off switch. Every `.ds-toggle` renders through this so each one is
 *  a real `<button role="switch">` — focusable and keyboard-operable. */
export function ToggleSwitch({ checked, onChange, label, disabled, className }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  disabled?: boolean;
  /** Extra classes for placement (e.g. `ext-pcard-toggle`). */
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`ds-toggle${checked ? " on" : ""}${className ? ` ${className}` : ""}`}
      onClick={() => onChange(!checked)}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
    >
      <span className="ds-toggle-thumb" />
    </button>
  );
}
