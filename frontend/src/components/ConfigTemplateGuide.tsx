// ConfigTemplateEditor.tsx — guidance UI for the JSON config template editor.
//
// Two parts, rendered above the textarea:
//   1. Preset template buttons — one click to fill the editor with a complete,
//      working template (after a confirm dialog, since it overwrites content).
//   2. A collapsible field reference (<details>, matching the editor's existing
//      history-panel pattern) explaining each top-level key and how to lock it.
//
// Styling: inline CSSProperties + CSS variables, consistent with
// ConfigTemplateEditor.tsx. No Tailwind in Hub frontend.

import { Button } from "./ui/Button.js";
import { useUIStore } from "../store/ui.js";
import { PRESET_TEMPLATES, FIELD_GUIDE } from "./config-template-presets.js";

interface ConfigTemplateGuideProps {
  /** Called with pretty-printed JSON when a preset is applied. */
  onApply: (jsonText: string) => void;
}

export function ConfigTemplateGuide({ onApply }: ConfigTemplateGuideProps) {
  const showConfirm = useUIStore((s) => s.showConfirm);
  const addToast = useUIStore((s) => s.addToast);

  const handlePreset = async (content: Record<string, unknown>, label: string) => {
    const ok = await showConfirm({
      title: `应用预设：${label}`,
      message: "这将用预设内容覆盖编辑器中的当前内容。确定继续？",
      confirmLabel: "覆盖",
      cancelLabel: "取消",
      variant: "warning",
    });
    if (!ok) return;
    onApply(JSON.stringify(content, null, 2));
    addToast("success", `已应用预设「${label}」，记得改 API Key 后保存`);
  };

  const sectionStyle: React.CSSProperties = {
    padding: "var(--space-3)",
    background: "var(--bg-secondary)",
    border: "1px solid var(--border-primary)",
    borderRadius: "var(--radius-md)",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
      {/* ─── Preset templates ─── */}
      <div style={sectionStyle}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 500,
            color: "var(--text-secondary)",
            marginBottom: "var(--space-2)",
          }}
        >
          快速开始
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
          {PRESET_TEMPLATES.map((preset) => (
            <div
              key={preset.key}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: "var(--space-3)",
                flexWrap: "wrap",
              }}
            >
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void handlePreset(preset.content, preset.label)}
                style={{ flexShrink: 0 }}
              >
                {preset.label}
              </Button>
              <span
                style={{
                  fontSize: 12,
                  color: "var(--text-tertiary)",
                  lineHeight: 1.6,
                  paddingTop: "2px",
                }}
              >
                {preset.description}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* ─── Field reference (collapsible) ─── */}
      <details style={{ marginTop: "var(--space-1)" }}>
        <summary
          style={{
            cursor: "pointer",
            color: "var(--text-secondary)",
            fontSize: 13,
            padding: "var(--space-1) 0",
          }}
        >
          字段说明 & 锁定规则
        </summary>
        <div
          style={{
            marginTop: "var(--space-2)",
            padding: "var(--space-3)",
            background: "var(--bg-secondary)",
            border: "1px solid var(--border-primary)",
            borderRadius: "var(--radius-md)",
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-3)",
          }}
        >
          {FIELD_GUIDE.map((entry) => (
            <div
              key={entry.field}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "var(--space-1)",
                paddingBottom: "var(--space-3)",
                borderBottom: "1px solid var(--border-secondary)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                <code
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 12,
                    padding: "2px 6px",
                    background: "var(--bg-tertiary)",
                    borderRadius: "var(--radius-sm)",
                    color: "var(--text-primary)",
                  }}
                >
                  {entry.field}
                </code>
                <span style={{ fontSize: 13, color: "var(--text-primary)", fontWeight: 500 }}>
                  {entry.purpose}
                </span>
              </div>
              <p
                style={{
                  margin: 0,
                  fontSize: 12,
                  color: "var(--text-secondary)",
                  lineHeight: 1.6,
                }}
              >
                {entry.detail}
              </p>
              {entry.lockPath && (
                <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
                  锁定填法：<code style={{ fontFamily: "var(--font-mono)" }}>{entry.lockPath}</code>
                </div>
              )}
            </div>
          ))}

          {/* Lock semantics callout */}
          <div
            style={{
              padding: "var(--space-2) var(--space-3)",
              background: "var(--warning-light)",
              borderLeft: "3px solid var(--warning)",
              borderRadius: "var(--radius-sm)",
              fontSize: 12,
              color: "var(--text-primary)",
              lineHeight: 1.6,
            }}
          >
            <b>锁定规则：</b>在 <code style={{ fontFamily: "var(--font-mono)" }}>fieldLocks.lockedPaths</code>{" "}
            里的字段会<b>强制覆盖</b> DA 本地值；不在列表的只在 DA 本地为空时填充，已有值保留。
            providers/agentSettings/doclingConfig/enhancedModels/hooks 只能锁整个（填顶层 key），
            不支持锁子字段；模块需锁到具体 id。
          </div>
        </div>
      </details>
    </div>
  );
}
