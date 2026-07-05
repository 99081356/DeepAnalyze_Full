import { ExternalLink } from "lucide-react";

interface TraceabilityLinkProps {
  label: string;
  sourceDocId?: string;
  sourceSection?: string;
  confidence?: "confirmed" | "inferred" | "unknown";
  onClick?: () => void;
}

const CONFIDENCE_COLORS: Record<string, string> = {
  confirmed: "var(--success)",
  inferred: "var(--warning)",
  unknown: "var(--text-tertiary)",
};

const CONFIDENCE_LABELS: Record<string, string> = {
  confirmed: "确认",
  inferred: "推定",
  unknown: "",
};

export function TraceabilityLink({
  label,
  sourceDocId,
  confidence = "confirmed",
  onClick,
}: TraceabilityLinkProps) {
  const color = CONFIDENCE_COLORS[confidence] ?? CONFIDENCE_COLORS.confirmed;
  const confLabel = CONFIDENCE_LABELS[confidence];

  return (
    <button
      onClick={onClick}
      title={sourceDocId ? `来源: ${sourceDocId}` : undefined}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        padding: "1px 6px",
        border: "none",
        borderRadius: "var(--radius-sm)",
        background: "color-mix(in srgb, var(--interactive) 8%, transparent)",
        color: "var(--interactive)",
        fontSize: "var(--text-xs)",
        fontWeight: 500,
        cursor: "pointer",
        transition: "all var(--transition-fast)",
        textDecoration: "none",
        whiteSpace: "nowrap",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "color-mix(in srgb, var(--interactive) 16%, transparent)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "color-mix(in srgb, var(--interactive) 8%, transparent)";
      }}
    >
      <ExternalLink size={10} />
      {label}
      {confLabel && (
        <span style={{ fontSize: 9, color, marginLeft: 2 }}>[{confLabel}]</span>
      )}
    </button>
  );
}
