// =============================================================================
// ProvidersSection — LLM 提供商管理 + 角色绑定（最复杂的区块）
// =============================================================================
// 两部分：
//   1. provider 列表 CRUD：每项含 id/name/endpoint/apiKey/model/enabled 等。
//      提供「快速预设」下拉（PROVIDER_PRESETS），选中后自动填 name/endpoint/model。
//   2. 角色绑定：10 个角色 select（main/summarizer/...），选项 = 已添加且
//      enabled 的 providers 的 id。
//
// 注意：Hub 端无法「测试连接」（没有 Worker 的 provider 实例），故不提供
// Worker ModelConfigCard 里的 test 按钮。apiKey 在模板里是明文（模板下发到
// 多个 worker，锁定时强制覆盖）。
// =============================================================================

import { useEffect, useState } from "react";
import { SectionCard } from "./SectionCard.js";
import { Input } from "../ui/Input.js";
import { Select } from "../ui/Select.js";
import { Toggle } from "../ui/Toggle.js";
import { Button } from "../ui/Button.js";
import { Plus, Trash2 } from "lucide-react";
import { api, type RegistryProviderSummary } from "../../api/client.js";
import {
  PROVIDER_PRESETS,
  PROVIDER_ROLES,
  type TemplateProviders,
  type TemplateProvider,
} from "../../types/config-template.js";

/** Registry 预设项（统一结构，可来自 API 或静态兜底） */
interface PresetEntry {
  registryId: string;
  name: string;
  endpoint: string;
  defaultModel: string;
  isLocal?: boolean;
  /** 该 provider 支持的模型 id 列表（供 model 字段 datalist 建议） */
  models?: string[];
}

export interface ProvidersSectionProps {
  value: TemplateProviders | null | undefined;
  locked: boolean;
  onChange: (next: TemplateProviders | null) => void;
  onLockChange: (locked: boolean) => void;
}

export function ProvidersSection({
  value,
  locked,
  onChange,
  onLockChange,
}: ProvidersSectionProps) {
  const providers = value?.providers ?? [];
  const defaults = value?.defaults ?? {
    main: "",
    summarizer: "",
    embedding: "",
    vlm: "",
    tts: "",
    image_gen: "",
    video_gen: "",
    music_gen: "",
    audio_transcribe: "",
    video_understand: "",
  };

  // ── 从 Hub 后端拉取 provider registry（GET /api/v1/providers/registry）──
  // 成功 → 用 API 返回的完整 registry（~20 provider + 模型清单）；
  // 失败 → 降级到静态 PROVIDER_PRESETS（8 个，无模型清单）。
  const [presets, setPresets] = useState<PresetEntry[]>(
    PROVIDER_PRESETS.map((p) => ({ ...p })),
  );
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp = await api.providers.getRegistry();
        if (cancelled) return;
        setPresets(
          resp.providers.map((p: RegistryProviderSummary) => ({
            registryId: p.id,
            name: p.name,
            endpoint: p.apiBase,
            defaultModel: p.defaultModel,
            isLocal: p.isLocal,
            models: p.models.map((m) => m.id),
          })),
        );
      } catch {
        // 降级：保留初始的静态 PROVIDER_PRESETS
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** 根据当前 provider 选中的 registryId，查 registry 的模型建议列表 */
  const getModelSuggestions = (registryId?: string): string[] => {
    if (!registryId) return [];
    const preset = presets.find((p) => p.registryId === registryId);
    return preset?.models ?? [];
  };

  /** 统一的更新入口：重组 providers + defaults 后回调 */
  const commit = (nextProviders: TemplateProvider[], nextDefaults = defaults) => {
    onChange({ providers: nextProviders, defaults: nextDefaults });
  };

  const addProvider = () => {
    const id = `prov_${Date.now().toString(36)}`;
    commit([
      ...providers,
      {
        id,
        name: "",
        type: "openai-compatible",
        endpoint: "",
        apiKey: "",
        model: "",
        enabled: true,
        supportsToolUse: true,
      },
    ]);
  };

  const updateProvider = (idx: number, patch: Partial<TemplateProvider>) => {
    commit(providers.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  };

  const removeProvider = (idx: number) => {
    const removed = providers[idx];
    const nextProviders = providers.filter((_, i) => i !== idx);
    // 角色绑定里引用了被删 provider 的，要清空
    const nextDefaults = { ...defaults };
    for (const r of PROVIDER_ROLES) {
      if (nextDefaults[r.key] === removed.id) nextDefaults[r.key] = "";
    }
    commit(nextProviders, nextDefaults);
  };

  /** 应用快速预设：填 name/endpoint/model/registryId，不动 id/apiKey */
  const applyPreset = (idx: number, registryId: string) => {
    if (!registryId) return;
    const preset = presets.find((p) => p.registryId === registryId);
    if (!preset) return;
    updateProvider(idx, {
      registryId: preset.registryId,
      name: preset.name,
      endpoint: preset.endpoint,
      model: preset.defaultModel,
    });
  };

  const updateDefault = (role: string, providerId: string) => {
    commit(providers, { ...defaults, [role]: providerId });
  };

  // 角色绑定的下拉选项 = 已添加且 enabled 的 providers
  const bindableOptions = providers
    .filter((p) => p.enabled)
    .map((p) => ({ value: p.id, label: `${p.name || p.id} (${p.model || "?"})` }));

  const providerCardStyle: React.CSSProperties = {
    padding: "var(--space-3)",
    background: "var(--bg-secondary)",
    border: "1px solid var(--border-primary)",
    borderRadius: "var(--radius-md)",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-2)",
  };

  const gridStyle: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "var(--space-2)",
  };

  const rolesGridStyle: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
    gap: "var(--space-2)",
  };

  const roleFieldStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-1)",
  };

  return (
    <SectionCard
      title="LLM 提供商 (providers)"
      description="配置可用的 AI 模型提供商，并把它们绑定到 10 个角色（主对话/摘要/嵌入等）。"
      lockKey="providers"
      locked={locked}
      onLockChange={onLockChange}
      actions={
        <Button variant="secondary" size="sm" icon={<Plus size={14} />} onClick={addProvider}>
          添加 Provider
        </Button>
      }
    >
      {/* ─── Provider 列表 ─── */}
      {providers.length === 0 ? (
        <div style={{ color: "var(--text-tertiary)", fontSize: 13, padding: "var(--space-2)", marginBottom: "var(--space-3)" }}>
          暂无 provider。点右上角「添加 Provider」新建，或添加后用「快速预设」一键填充。
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)", marginBottom: "var(--space-4)" }}>
          {providers.map((p, idx) => (
            <div key={p.id ?? idx} style={providerCardStyle}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                  #{idx + 1} <code style={{ fontFamily: "var(--font-mono)" }}>{p.id}</code>
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                  <Toggle
                    checked={p.enabled}
                    onChange={(c) => updateProvider(idx, { enabled: c })}
                    size="sm"
                    aria-label="启用"
                  />
                  <Button
                    variant="danger"
                    size="sm"
                    icon={<Trash2 size={12} />}
                    onClick={() => removeProvider(idx)}
                  />
                </div>
              </div>

              {/* 快速预设 */}
              <div style={roleFieldStyle}>
                <label style={{ fontSize: "var(--text-sm)", fontWeight: 500, color: "var(--text-primary)" }}>
                  快速预设（选一个自动填充 name/endpoint/model）
                </label>
                <Select
                  value={p.registryId ?? ""}
                  onChange={(v) => applyPreset(idx, v)}
                  options={[
                    { value: "", label: "（自定义，手填）" },
                    ...presets.map((pr) => ({
                      value: pr.registryId,
                      label: pr.name + (pr.isLocal ? " (本地)" : ""),
                    })),
                  ]}
                  aria-label="快速预设"
                />
              </div>

              <div className="grid" style={gridStyle}>
                <Input
                  label="显示名称 *"
                  value={p.name}
                  onChange={(e) => updateProvider(idx, { name: e.target.value })}
                  placeholder="例如 智谱GLM"
                />
                <div style={roleFieldStyle}>
                  <label style={{ fontSize: "var(--text-sm)", fontWeight: 500, color: "var(--text-primary)" }}>
                    模型 *
                  </label>
                  {/* model 输入 + datalist 建议（来自 registry 的模型清单） */}
                  <input
                    list={`model-suggestions-${idx}`}
                    value={p.model}
                    onChange={(e) => updateProvider(idx, { model: e.target.value })}
                    placeholder="例如 glm-4.6"
                    style={{
                      width: "100%",
                      padding: "var(--space-2) var(--space-3)",
                      background: "var(--bg-primary)",
                      color: "var(--text-primary)",
                      border: "1px solid var(--border-primary)",
                      borderRadius: "var(--radius-md)",
                      fontSize: "var(--text-sm)",
                      outline: "none",
                      boxSizing: "border-box",
                    }}
                  />
                  <datalist id={`model-suggestions-${idx}`}>
                    {getModelSuggestions(p.registryId).map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                </div>
                <Input
                  label="API Endpoint *"
                  value={p.endpoint}
                  onChange={(e) => updateProvider(idx, { endpoint: e.target.value })}
                  placeholder="https://..."
                />
                <Input
                  label="API Key"
                  type="password"
                  value={p.apiKey}
                  onChange={(e) => updateProvider(idx, { apiKey: e.target.value })}
                  placeholder="sk-..."
                />
                <Input
                  label="最大 Tokens"
                  type="number"
                  value={String(p.maxTokens ?? 0)}
                  onChange={(e) =>
                    updateProvider(idx, {
                      maxTokens: parseInt(e.target.value, 10) || undefined,
                    })
                  }
                />
                <Input
                  label="上下文窗口"
                  type="number"
                  value={String(p.contextWindow ?? 0)}
                  onChange={(e) =>
                    updateProvider(idx, {
                      contextWindow: parseInt(e.target.value, 10) || undefined,
                    })
                  }
                />
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
                <Toggle
                  checked={p.supportsToolUse ?? false}
                  onChange={(c) => updateProvider(idx, { supportsToolUse: c })}
                  size="sm"
                  label="支持工具调用 (tool use)"
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ─── 角色绑定 ─── */}
      <div
        style={{
          padding: "var(--space-3)",
          background: "var(--bg-tertiary)",
          borderRadius: "var(--radius-md)",
        }}
      >
        <div style={{ fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--text-primary)", marginBottom: "var(--space-2)" }}>
          角色绑定
        </div>
        <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: "var(--space-3)" }}>
          把上方已启用的 provider 分配到 10 个角色。留空表示该角色未绑定。
        </div>
        <div style={rolesGridStyle}>
          {PROVIDER_ROLES.map((r) => (
            <div key={r.key} style={roleFieldStyle}>
              <label style={{ fontSize: "var(--text-sm)", color: "var(--text-primary)" }}>
                {r.label}
              </label>
              <Select
                value={defaults[r.key] ?? ""}
                onChange={(v) => updateDefault(r.key, v)}
                options={[
                  { value: "", label: "（未绑定）" },
                  ...bindableOptions,
                ]}
                aria-label={r.label}
              />
            </div>
          ))}
        </div>
      </div>
    </SectionCard>
  );
}

export default ProvidersSection;
