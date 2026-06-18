import { useEffect, useRef, useState } from "react";

interface Props {
  title: string;
  label?: string;
  defaultValue?: string;
  placeholder?: string;
  okLabel?: string;
  /** Allow submitting an empty value (e.g. to clear a field). Default false. */
  allowEmpty?: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

export function PromptModal({
  title, label, defaultValue = "", placeholder,
  okLabel = "Save", allowEmpty = false, onSubmit, onCancel,
}: Props) {
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onCancel]);

  function submit() {
    const trimmed = value.trim();
    if (!trimmed && !allowEmpty) return;
    onSubmit(trimmed);
  }

  return (
    <div className="ds-modal-overlay">
      <div className="ds-modal ds-modal--sm" onClick={e => e.stopPropagation()}>
        <h2 className="ds-modal-title">{title}</h2>
        {label && <p>{label}</p>}
        <input
          ref={inputRef}
          type="text"
          className="ds-input"
          value={value}
          placeholder={placeholder}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") submit(); }}
        />
        <div className="ds-modal-actions">
          <button className="ds-btn ds-btn--ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="ds-btn ds-btn--primary"
            onClick={submit}
            disabled={!allowEmpty && value.trim().length === 0}
          >
            {okLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
