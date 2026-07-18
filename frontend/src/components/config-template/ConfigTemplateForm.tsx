// =============================================================================
// ConfigTemplateForm — 配置模板的可视化表单视图
// =============================================================================
// 接收完整的 TemplateContent（与 JSON 视图共享同一份状态），渲染为分区表单。
// 覆盖全部 6 个区块：
//   providers / agentSettings / doclingConfig / moduleStates /
//   enhancedModels / hooks
//
// 锁定机制：从 content.fieldLocks.lockedPaths 派生当前锁定状态，
// 修改时回写 lockedPaths。
// =============================================================================

import { ProvidersSection } from "./ProvidersSection.js";
import { AgentSettingsSection } from "./AgentSettingsSection.js";
import { DoclingSection } from "./DoclingSection.js";
import { ModuleStatesSection } from "./ModuleStatesSection.js";
import { EnhancedModelsSection } from "./EnhancedModelsSection.js";
import { HooksSection } from "./HooksSection.js";
import { MinerUSection } from "./MinerUSection.js";
import { type TemplateContent } from "../../types/config-template.js";

export interface ConfigTemplateFormProps {
  value: TemplateContent;
  onChange: (next: TemplateContent) => void;
}

export function ConfigTemplateForm({ value, onChange }: ConfigTemplateFormProps) {
  const lockedPaths = value.fieldLocks?.lockedPaths ?? [];
  const isLocked = (key: string) => lockedPaths.includes(key);

  // 更新某个顶层区块的值
  const setSection = <K extends keyof TemplateContent>(
    key: K,
    next: TemplateContent[K],
  ) => {
    onChange({ ...value, [key]: next });
  };

  // 切换某个区块的锁定状态
  const setLock = (lockKey: string, locked: boolean) => {
    const set = new Set(lockedPaths);
    if (locked) set.add(lockKey);
    else set.delete(lockKey);
    onChange({
      ...value,
      fieldLocks: { lockedPaths: Array.from(set) },
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      <ProvidersSection
        value={value.providers}
        locked={isLocked("providers")}
        onChange={(next) => setSection("providers", next)}
        onLockChange={(locked) => setLock("providers", locked)}
      />

      <AgentSettingsSection
        value={value.agentSettings}
        locked={isLocked("agentSettings")}
        onChange={(next) => setSection("agentSettings", next)}
        onLockChange={(locked) => setLock("agentSettings", locked)}
      />

      <DoclingSection
        value={value.doclingConfig}
        locked={isLocked("doclingConfig")}
        onChange={(next) => setSection("doclingConfig", next)}
        onLockChange={(locked) => setLock("doclingConfig", locked)}
      />

      <ModuleStatesSection
        value={value.moduleStates}
        lockedMap={{
          "moduleStates.embedding": isLocked("moduleStates.embedding"),
          "moduleStates.asr": isLocked("moduleStates.asr"),
          "moduleStates.docling": isLocked("moduleStates.docling"),
          "moduleStates.mineru": isLocked("moduleStates.mineru"),
        }}
        onChange={(next) => setSection("moduleStates", next)}
        onLockChange={(moduleId, locked) =>
          setLock(`moduleStates.${moduleId}`, locked)
        }
      />

      <EnhancedModelsSection
        value={value.enhancedModels}
        locked={isLocked("enhancedModels")}
        onChange={(next) => setSection("enhancedModels", next)}
        onLockChange={(locked) => setLock("enhancedModels", locked)}
      />

      <HooksSection
        value={value.hooks}
        locked={isLocked("hooks")}
        onChange={(next) => setSection("hooks", next)}
        onLockChange={(locked) => setLock("hooks", locked)}
      />

      <MinerUSection
        value={value.mineruConfig}
        locked={isLocked("mineruConfig")}
        onChange={(next) => setSection("mineruConfig", next)}
        onLockChange={(locked) => setLock("mineruConfig", locked)}
      />

      {/* 锁定状态汇总 */}
      {lockedPaths.length > 0 && (
        <div
          style={{
            padding: "var(--space-3)",
            background: "var(--warning-light)",
            border: "1px solid var(--warning)",
            borderRadius: "var(--radius-md)",
            fontSize: 12,
          }}
        >
          <b>将强制覆盖 Worker 本地值的区块：</b>{" "}
          {lockedPaths.map((p) => (
            <code
              key={p}
              style={{
                fontFamily: "var(--font-mono)",
                background: "var(--bg-tertiary)",
                padding: "1px 6px",
                borderRadius: "var(--radius-sm)",
                margin: "0 2px",
              }}
            >
              {p}
            </code>
          ))}
        </div>
      )}
    </div>
  );
}

export default ConfigTemplateForm;
