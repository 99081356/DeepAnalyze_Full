import { useState } from "react";
import { useChatStore } from "../../store/chat";

/**
 * Floating dialog shown when the agent asks the user a question via ask_user tool.
 * Displays the question, optional preset options, and a text input for custom answers.
 */
export function AskUserDialog() {
  const pendingQuestion = useChatStore((s) => s.pendingQuestion);
  const answerQuestion = useChatStore((s) => s.answerQuestion);
  const [customAnswer, setCustomAnswer] = useState("");

  if (!pendingQuestion) return null;

  const { taskId, question, options } = pendingQuestion;
  const hasOptions = (options?.length ?? 0) > 0;

  const handleSubmit = (answer: string) => {
    if (!answer.trim()) return;
    answerQuestion(taskId, answer.trim());
    setCustomAnswer("");
  };

  return (
    <div
      style={{
        position: "absolute",
        bottom: 80,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 100,
        width: "min(480px, calc(100% - 32px))",
        animation: "fadeIn 0.2s ease-out",
      }}
    >
      <div
        style={{
          background: "var(--surface-elevated)",
          border: "1px solid var(--interactive)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "0 8px 32px rgba(0,0,0,0.2), 0 0 0 1px var(--interactive)",
          padding: "var(--space-4)",
        }}
      >
        {/* Agent icon + label */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            marginBottom: "var(--space-3)",
            fontSize: "var(--text-xs)",
            color: "var(--interactive)",
            fontWeight: 600,
            textTransform: "uppercase" as const,
            letterSpacing: "0.05em",
          }}
        >
          Agent Question
        </div>

        {/* Question text */}
        <p
          style={{
            margin: "0 0 var(--space-3)",
            fontSize: "var(--text-sm)",
            color: "var(--text-primary)",
            lineHeight: "var(--leading-relaxed)",
          }}
        >
          {question}
        </p>

        {/* Preset options */}
        {hasOptions && (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "var(--space-2)",
              marginBottom: "var(--space-3)",
            }}
          >
            {options.map((opt, i) => (
              <button
                key={i}
                onClick={() => handleSubmit(opt)}
                style={{
                  padding: "var(--space-1) var(--space-3)",
                  border: "1px solid var(--border-primary)",
                  borderRadius: "var(--radius-md)",
                  background: "var(--surface-primary)",
                  color: "var(--text-secondary)",
                  fontSize: "var(--text-sm)",
                  cursor: "pointer",
                  transition: "all var(--transition-fast)",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = "var(--interactive)";
                  e.currentTarget.style.color = "var(--interactive)";
                  e.currentTarget.style.background = "var(--interactive-light)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = "var(--border-primary)";
                  e.currentTarget.style.color = "var(--text-secondary)";
                  e.currentTarget.style.background = "var(--surface-primary)";
                }}
              >
                {opt}
              </button>
            ))}
          </div>
        )}

        {/* Custom text input */}
        <div style={{ display: "flex", gap: "var(--space-2)" }}>
          <input
            type="text"
            value={customAnswer}
            onChange={(e) => setCustomAnswer(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSubmit(customAnswer);
            }}
            placeholder={hasOptions ? "或输入自定义回答..." : "输入你的回答..."}
            style={{
              flex: 1,
              padding: "var(--space-2) var(--space-3)",
              border: "1px solid var(--border-primary)",
              borderRadius: "var(--radius-md)",
              background: "var(--surface-primary)",
              color: "var(--text-primary)",
              fontSize: "var(--text-sm)",
              outline: "none",
            }}
            autoFocus
          />
          <button
            onClick={() => handleSubmit(customAnswer)}
            disabled={!customAnswer.trim()}
            style={{
              padding: "var(--space-2) var(--space-3)",
              border: "none",
              borderRadius: "var(--radius-md)",
              background: customAnswer.trim() ? "var(--interactive)" : "var(--surface-secondary)",
              color: customAnswer.trim() ? "#fff" : "var(--text-tertiary)",
              fontSize: "var(--text-sm)",
              cursor: customAnswer.trim() ? "pointer" : "default",
              transition: "all var(--transition-fast)",
            }}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
