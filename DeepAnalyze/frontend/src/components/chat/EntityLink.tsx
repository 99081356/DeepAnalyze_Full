import { useState, useCallback, useRef } from "react";
import { ExternalLink } from "lucide-react";
import type { ChatEntity } from "../../types/index";

interface EntityLinkProps {
  entity: ChatEntity;
  onViewAll?: (entityName: string) => void;
}

const ENTITY_TYPE_LABELS: Record<string, string> = {
  person: "人物",
  organization: "组织",
  location: "地点",
  date: "日期",
  event: "事件",
  concept: "概念",
  product: "产品",
  technology: "技术",
  regulation: "法规",
  financial: "财务",
  legal: "法律",
  other: "其他",
};

const ENTITY_TYPE_COLORS: Record<string, string> = {
  person: "#8b5cf6",
  organization: "#3b82f6",
  location: "#10b981",
  date: "#f59e0b",
  event: "#ef4444",
  concept: "#6366f1",
  product: "#06b6d4",
  technology: "#0ea5e9",
  regulation: "#dc2626",
  financial: "#16a34a",
  legal: "#9333ea",
  other: "#64748b",
};

export function EntityLink({ entity, onViewAll }: EntityLinkProps) {
  const [showPopup, setShowPopup] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const typeLabel = ENTITY_TYPE_LABELS[entity.type] ?? entity.type;
  const typeColor = ENTITY_TYPE_COLORS[entity.type] ?? ENTITY_TYPE_COLORS.other;

  const handleMouseEnter = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setShowPopup(true);
  }, []);

  const handleMouseLeave = useCallback(() => {
    timeoutRef.current = setTimeout(() => {
      setShowPopup(false);
    }, 150);
  }, []);

  const handleViewAll = useCallback(() => {
    if (onViewAll) {
      onViewAll(entity.name);
    }
    setShowPopup(false);
  }, [onViewAll, entity.name]);

  return (
    <span
      style={{ position: "relative", display: "inline" }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* Entity link with dashed underline */}
      <span
        style={{
          color: typeColor,
          cursor: "pointer",
          borderBottom: `1px dashed ${typeColor}`,
          transition: "opacity var(--transition-fast)",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.opacity = "0.75";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.opacity = "1";
        }}
      >
        {entity.name}
      </span>

      {/* Hover popup */}
      {showPopup && (
        <div
          style={{
            position: "absolute",
            bottom: "calc(100% + 6px)",
            left: "50%",
            transform: "translateX(-50%)",
            minWidth: 180,
            maxWidth: 280,
            background: "var(--surface-elevated)",
            border: "1px solid var(--border-primary)",
            borderRadius: "var(--radius-lg)",
            boxShadow: "var(--shadow-lg)",
            padding: "var(--space-3)",
            zIndex: 50,
            animation: "fadeIn 0.15s ease-out",
          }}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
          {/* Arrow */}
          <div
            style={{
              position: "absolute",
              bottom: -5,
              left: "50%",
              marginLeft: -5,
              width: 10,
              height: 10,
              background: "var(--surface-elevated)",
              border: "1px solid var(--border-primary)",
              borderTop: "none",
              borderLeft: "none",
              transform: "rotate(45deg)",
            }}
          />

          {/* Entity type badge */}
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-1)" }}>
            <span
              style={{
                display: "inline-block",
                padding: "1px 8px",
                fontSize: 10,
                fontWeight: 600,
                borderRadius: "var(--radius-full)",
                background: `color-mix(in srgb, ${typeColor} 12%, transparent)`,
                color: typeColor,
              }}
            >
              {typeLabel}
            </span>
            <span
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--text-tertiary)",
              }}
            >
              {entity.occurrenceCount} 次提及
            </span>
          </div>

          {/* Entity name */}
          <div
            style={{
              fontSize: "var(--text-sm)",
              fontWeight: 600,
              color: "var(--text-primary)",
              marginBottom: "var(--space-2)",
            }}
          >
            {entity.name}
          </div>

          {/* View all link */}
          <button
            onClick={handleViewAll}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              border: "none",
              background: "transparent",
              color: "var(--interactive)",
              fontSize: "var(--text-xs)",
              fontWeight: 500,
              cursor: "pointer",
              padding: 0,
              transition: "opacity var(--transition-fast)",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.opacity = "0.8";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.opacity = "1";
            }}
          >
            <ExternalLink size={10} />
            查看所有提及
          </button>
        </div>
      )}
    </span>
  );
}
