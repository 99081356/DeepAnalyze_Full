import { useRef, useEffect } from "react";

interface TextAreaProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  maxHeight?: number;
  error?: string;
  label?: string;
  disabled?: boolean;
  style?: React.CSSProperties;
}

export function TextArea({
  value,
  onChange,
  placeholder,
  rows = 3,
  maxHeight = 200,
  error,
  label,
  disabled,
  style,
}: TextAreaProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, maxHeight) + "px";
    }
  }, [value, maxHeight]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, ...style }}>
      {label && (
        <label style={{ fontSize: "var(--text-sm)", fontWeight: 500, color: "var(--text-secondary)" }}>
          {label}
        </label>
      )}
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        style={{
          width: "100%",
          padding: "10px 12px",
          background: "var(--bg-primary)",
          border: `1px solid ${error ? "var(--error)" : "var(--border-primary)"}`,
          borderRadius: "var(--radius-lg)",
          fontSize: "var(--text-sm)",
          color: "var(--text-primary)",
          lineHeight: "var(--leading-normal)",
          resize: "none",
          outline: "none",
          transition: "border-color var(--transition-fast), box-shadow var(--transition-fast)",
          fontFamily: "inherit",
        }}
        onFocus={(e) => {
          if (!error) e.currentTarget.style.borderColor = "var(--border-focus)";
          e.currentTarget.style.boxShadow = error
            ? "0 0 0 3px rgba(239,68,68,0.1)"
            : "0 0 0 3px rgba(51,65,85,0.08)";
        }}
        onBlur={(e) => {
          e.currentTarget.style.borderColor = error ? "var(--error)" : "var(--border-primary)";
          e.currentTarget.style.boxShadow = "none";
        }}
      />
      {error && (
        <span style={{ fontSize: "var(--text-xs)", color: "var(--error)" }}>{error}</span>
      )}
    </div>
  );
}
