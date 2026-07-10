import { useState, useEffect } from "react";
import { Button } from "./ui/Button.js";
import { api } from "../api/client.js";
import { useUIStore } from "../store/ui.js";
import { ConfigTemplateGuide } from "./ConfigTemplateGuide.js";
import type {
  ConfigTemplate,
  ConfigTemplateHistoryEntry,
} from "../api/client.js";

/* -------------------------------------------------------------------------- */
/*  ConfigTemplateEditor                                                       */
/* -------------------------------------------------------------------------- */
/**
 * JSON editor for a single config template scope (global or org).
 *
 * Features:
 *  - Loads current template + history in parallel on mount/scope change
 *  - Dirty-check via originalText comparison (no save button until changes)
 *  - Lock visualization: parses fieldLocks.lockedPaths from current JSON text
 *    and renders red code badges (best-effort — ignores mid-edit parse errors)
 *  - History panel (collapsible <details>)
 *  - All styling inline CSSProperties with CSS variables (no Tailwind in Hub)
 */
interface ConfigTemplateEditorProps {
  scope: "global" | "org";
  orgId?: string;
}

export function ConfigTemplateEditor({ scope, orgId }: ConfigTemplateEditorProps) {
  const [template, setTemplate] = useState<ConfigTemplate | null>(null);
  const [jsonText, setJsonText] = useState("");
  const [originalText, setOriginalText] = useState(""); // for dirty check
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [history, setHistory] = useState<ConfigTemplateHistoryEntry[]>([]);
  const addToast = useUIStore((s) => s.addToast);

  const load = async () => {
    setLoading(true);
    try {
      const tpl =
        scope === "global"
          ? await api.configTemplates.getGlobal()
          : await api.configTemplates.getOrg(orgId!);
      setTemplate(tpl);
      const text = JSON.stringify(tpl.content ?? {}, null, 2);
      setJsonText(text);
      setOriginalText(text);

      // Load history (non-blocking — don't fail the editor if history fails)
      try {
        const hist = await api.configTemplates.getHistory(
          scope === "global"
            ? { scope: "global" }
            : { scope: "org", orgId },
        );
        setHistory(hist.items);
      } catch {
        setHistory([]);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "加载失败";
      addToast("error", `加载模板失败: ${msg}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, orgId]);

  const handleSave = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      addToast(
        "error",
        `JSON 格式错误: ${e instanceof Error ? e.message : ""}`,
      );
      return;
    }
    setSaving(true);
    try {
      if (scope === "global") {
        await api.configTemplates.putGlobal(parsed);
      } else {
        await api.configTemplates.putOrg(orgId!, parsed);
      }
      addToast("success", "已保存为新版本");
      await load(); // refresh version + history
    } catch (e) {
      const msg = e instanceof Error ? e.message : "保存失败";
      addToast("error", msg);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div style={{ color: "var(--text-secondary)" }}>加载中...</div>
    );
  }

  // Parse current jsonText for lock visualization (best-effort)
  let lockedPaths: string[] = [];
  try {
    const parsed = JSON.parse(jsonText);
    if (
      parsed?.fieldLocks?.lockedPaths &&
      Array.isArray(parsed.fieldLocks.lockedPaths)
    ) {
      lockedPaths = parsed.fieldLocks.lockedPaths;
    }
  } catch {
    /* ignore — user is mid-edit */
  }

  const isDirty = jsonText !== originalText;
  const versionLabel = template?.version ? `v${template.version}` : "未创建";
  const updatedLabel = template?.updated_at
    ? new Date(template.updated_at).toLocaleString("zh-CN")
    : "";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-3)",
      }}
    >
      {/* Metadata row */}
      <div
        style={{
          display: "flex",
          gap: "var(--space-4)",
          fontSize: 13,
          color: "var(--text-secondary)",
        }}
      >
        <span>
          版本:{" "}
          <b style={{ color: "var(--text-primary)" }}>{versionLabel}</b>
        </span>
        {updatedLabel && <span>更新于: {updatedLabel}</span>}
      </div>

      {/* Guidance UI: preset templates + collapsible field reference */}
      <ConfigTemplateGuide onApply={setJsonText} />

      {/* JSON editor — raw textarea with inline style (NOT Tailwind className) */}
      <textarea
        value={jsonText}
        onChange={(e) => setJsonText(e.target.value)}
        style={{
          width: "100%",
          minHeight: 400,
          padding: "var(--space-3)",
          background: "var(--bg-secondary)",
          color: "var(--text-primary)",
          border: "1px solid var(--border-primary)",
          borderRadius: "var(--radius-md)",
          fontFamily: "var(--font-mono)",
          fontSize: 13,
          lineHeight: 1.5,
          resize: "vertical",
          outline: "none",
        }}
        spellCheck={false}
      />

      {/* Locked paths visualization (red code badges) */}
      {lockedPaths.length > 0 && (
        <div
          style={{
            padding: "var(--space-2) var(--space-3)",
            background: "var(--warning-light)",
            borderLeft: "3px solid var(--warning)",
            borderRadius: "var(--radius-sm)",
            fontSize: 13,
          }}
        >
          <b>锁定字段（强制覆盖 DA 本地值）：</b>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "var(--space-1)",
              marginTop: "var(--space-1)",
            }}
          >
            {lockedPaths.map((p) => (
              <code
                key={p}
                style={{
                  padding: "2px 6px",
                  background: "var(--error-light)",
                  color: "var(--error-dark, var(--error))",
                  borderRadius: "var(--radius-sm)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 12,
                }}
              >
                {p}
              </code>
            ))}
          </div>
        </div>
      )}

      {/* Action row */}
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: "var(--space-2)",
        }}
      >
        <Button
          variant="primary"
          size="md"
          onClick={handleSave}
          loading={saving}
          disabled={!isDirty || saving}
        >
          {saving ? "保存中..." : "保存为新版本"}
        </Button>
      </div>

      {/* History panel */}
      {history.length > 0 && (
        <details style={{ marginTop: "var(--space-3)" }}>
          <summary
            style={{
              cursor: "pointer",
              color: "var(--text-secondary)",
              fontSize: 13,
            }}
          >
            历史版本 ({history.length})
          </summary>
          <div
            style={{
              marginTop: "var(--space-2)",
              padding: "var(--space-3)",
              background: "var(--bg-secondary)",
              borderRadius: "var(--radius-md)",
              maxHeight: 240,
              overflowY: "auto",
            }}
          >
            {history.map((h) => (
              <div
                key={h.version}
                style={{
                  display: "flex",
                  gap: "var(--space-3)",
                  padding: "var(--space-1) 0",
                  borderBottom: "1px solid var(--border-secondary)",
                  fontSize: 12,
                }}
              >
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    color: "var(--text-secondary)",
                  }}
                >
                  v{h.version}
                </span>
                <span>{new Date(h.updated_at).toLocaleString("zh-CN")}</span>
                <span style={{ color: "var(--text-tertiary)" }}>
                  by {h.updated_by}
                </span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
