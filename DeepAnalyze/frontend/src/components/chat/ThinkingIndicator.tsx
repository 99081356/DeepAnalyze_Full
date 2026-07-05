import { Loader2 } from "lucide-react";

interface ThinkingIndicatorProps {
  message?: string;
}

export function ThinkingIndicator({ message = "思考中" }: ThinkingIndicatorProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        padding: "var(--space-2) var(--space-3)",
        color: "var(--text-tertiary)",
        fontSize: "var(--text-sm)",
      }}
    >
      <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />
      <span>{message}</span>
      <div style={{ display: "flex", gap: 4, marginLeft: 4 }}>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            style={{
              width: 4,
              height: 4,
              borderRadius: "50%",
              background: "var(--text-tertiary)",
              animation: "typing 1.4s ease-in-out infinite",
              animationDelay: `${i * 0.2}s`,
            }}
          />
        ))}
      </div>
    </div>
  );
}
