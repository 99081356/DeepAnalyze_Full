import { useState, useCallback, useRef } from "react";
import { ExternalLink } from "lucide-react";
import type { ChatReference } from "../../types/index";

interface ReferenceMarkerProps {
  reference: ChatReference;
  onOpenSource?: (docId: string) => void;
}

export function ReferenceMarker({ reference, onOpenSource }: ReferenceMarkerProps) {
  const [showPopup, setShowPopup] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const handleOpenSource = useCallback(() => {
    if (onOpenSource) {
      onOpenSource(reference.sourceDocId);
    }
    setShowPopup(false);
  }, [onOpenSource, reference.sourceDocId]);

  return (
    <span
      style={{ position: "relative", display: "inline" }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* Blue superscript badge */}
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          verticalAlign: "super",
          fontSize: 10,
          fontWeight: 600,
          lineHeight: 1,
          padding: "1px 4px",
          borderRadius: "var(--radius-sm)",
          background: "color-mix(in srgb, var(--interactive) 12%, transparent)",
          color: "var(--interactive)",
          cursor: "pointer",
          marginLeft: 1,
          marginRight: 1,
          transition: "background var(--transition-fast)",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "color-mix(in srgb, var(--interactive) 24%, transparent)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "color-mix(in srgb, var(--interactive) 12%, transparent)";
        }}
      >
        [{reference.index}]
      </span>

      {/* Hover popup */}
      {showPopup && (
        <div
          style={{
            position: "absolute",
            bottom: "calc(100% + 6px)",
            left: "50%",
            transform: "translateX(-50%)",
            minWidth: 220,
            maxWidth: 320,
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

          {/* Source document title */}
          <div
            style={{
              fontSize: "var(--text-xs)",
              fontWeight: 600,
              color: "var(--text-primary)",
              marginBottom: "var(--space-1)",
              lineHeight: "var(--leading-tight)",
            }}
          >
            {reference.sourceTitle}
          </div>

          {/* Level badge */}
          {reference.level && (
            <div style={{ marginBottom: "var(--space-1)" }}>
              <span
                style={{
                  display: "inline-block",
                  padding: "0 var(--space-2)",
                  fontSize: 10,
                  fontWeight: 500,
                  borderRadius: "var(--radius-full)",
                  background: "color-mix(in srgb, var(--interactive) 10%, transparent)",
                  color: "var(--interactive)",
                }}
              >
                {reference.level}
              </span>
            </div>
          )}

          {/* Snippet */}
          {reference.snippet && (
            <div
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--text-secondary)",
                lineHeight: "var(--leading-relaxed)",
                marginBottom: "var(--space-2)",
                padding: "var(--space-1) var(--space-2)",
                background: "var(--bg-tertiary)",
                borderRadius: "var(--radius-sm)",
                maxHeight: 80,
                overflow: "hidden",
              }}
            >
              {reference.snippet}
            </div>
          )}

          {/* Open source link */}
          <button
            onClick={handleOpenSource}
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
            打开来源文档
          </button>
        </div>
      )}
    </span>
  );
}
