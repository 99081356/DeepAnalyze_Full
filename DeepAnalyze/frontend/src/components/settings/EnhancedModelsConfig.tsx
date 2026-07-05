// =============================================================================
// DeepAnalyze - EnhancedModelsConfig
// Generative model management (生成模型)
// =============================================================================

import { useState, useEffect, useCallback } from "react";
import { api } from "../../api/client";
import { useToast } from "../../hooks/useToast";
import type { ProviderConfig, EnhancedModelEntry, EnhancedModelType } from "../../types/index";
import {
  Sparkles, Video, Music, Headphones, ToggleLeft,
  Plus, Trash2, Edit2, Check, X,
} from "lucide-react";

const MODEL_TYPE_OPTIONS: { value: EnhancedModelType; label: string; icon: React.ReactNode }[] = [
  { value: "image_gen", label: "图像生成", icon: <Sparkles size={14} /> },
  { value: "video_gen", label: "视频生成", icon: <Video size={14} /> },
  { value: "music_gen", label: "音乐生成", icon: <Music size={14} /> },
  { value: "tts", label: "语音合成", icon: <Headphones size={14} /> },
];

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "var(--space-2) var(--space-3)",
  border: "1px solid var(--border-primary)",
  borderRadius: "var(--radius-lg)",
  fontSize: "var(--text-sm)",
  background: "var(--bg-primary)",
  color: "var(--text-primary)",
  outline: "none",
  boxSizing: "border-box",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--font-medium)",
  color: "var(--text-secondary)",
  marginBottom: "var(--space-1)",
};

interface EnhancedModelsConfigProps {
  providers: ProviderConfig[];
}

export function EnhancedModelsConfig({ providers }: EnhancedModelsConfigProps) {
  const { success, error: showError } = useToast();

  const [models, setModels] = useState<EnhancedModelEntry[]>([]);
  const [activeType, setActiveType] = useState<EnhancedModelType>("image_gen");
  const [loading, setLoading] = useState(true);
  const [editingModel, setEditingModel] = useState<EnhancedModelEntry | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const loadModels = useCallback(async () => {
    try {
      const data = await api.getEnhancedModels();
      setModels(data);
    } catch {
      // No enhanced models yet is fine
      setModels([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadModels(); }, [loadModels]);

  const filteredModels = models.filter((m) => m.modelType === activeType);

  const handleSave = async (updatedModels: EnhancedModelEntry[]) => {
    try {
      await api.saveEnhancedModels(updatedModels);
      setModels(updatedModels);
      success("生成模型已保存");
    } catch {
      showError("保存失败");
    }
  };

  const handleToggleEnabled = (id: string) => {
    const updated = models.map((m) => m.id === id ? { ...m, enabled: !m.enabled } : m);
    handleSave(updated);
  };

  const handleDelete = (id: string) => {
    const updated = models.filter((m) => m.id !== id);
    handleSave(updated);
  };

  const handleCreateNew = () => {
    const newModel: EnhancedModelEntry = {
      id: `enhanced_${Date.now()}`,
      modelType: activeType,
      name: "",
      description: "",
      providerId: "",
      model: "",
      enabled: true,
      capabilities: [],
      priority: 50,
    };
    setEditingModel(newModel);
    setIsCreating(true);
  };

  const handleEditSave = () => {
    if (!editingModel) return;
    let updated: EnhancedModelEntry[];
    if (isCreating) {
      updated = [...models, editingModel];
    } else {
      updated = models.map((m) => m.id === editingModel.id ? editingModel : m);
    }
    handleSave(updated);
    setEditingModel(null);
    setIsCreating(false);
  };

  const handleEditCancel = () => {
    setEditingModel(null);
    setIsCreating(false);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      {/* Description */}
      <p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: 0 }}>
        管理生成模型：图像、视频、音乐、语音合成等专用模型。
      </p>

      {/* Type filter tabs */}
      <div style={{
        display: "flex", gap: 2, overflowX: "auto", paddingBottom: "var(--space-1)",
        borderBottom: "1px solid var(--border-primary)",
      }}>
        {MODEL_TYPE_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => setActiveType(opt.value)}
            style={{
              display: "flex", alignItems: "center", gap: "var(--space-1)",
              padding: "var(--space-1) var(--space-3)",
              border: "none",
              borderBottom: activeType === opt.value ? "2px solid var(--interactive)" : "2px solid transparent",
              background: activeType === opt.value ? "var(--interactive-light)" : "transparent",
              color: activeType === opt.value ? "var(--interactive)" : "var(--text-secondary)",
              fontSize: "var(--text-xs)", fontWeight: activeType === opt.value ? 500 : 400,
              cursor: "pointer", transition: "all var(--transition-fast)",
              whiteSpace: "nowrap" as const, borderRadius: "var(--radius-sm) var(--radius-sm) 0 0",
            }}
          >
            {opt.icon}
            {opt.label}
          </button>
        ))}
      </div>

      {/* Add button */}
      <div>
        <button
          onClick={handleCreateNew}
          style={{
            display: "flex", alignItems: "center", gap: "var(--space-1)",
            padding: "var(--space-2) var(--space-3)",
            background: "var(--interactive)", color: "#fff",
            fontSize: "var(--text-sm)", fontWeight: "var(--font-medium)",
            borderRadius: "var(--radius-lg)", border: "none", cursor: "pointer",
            transition: "background var(--transition-fast)",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--interactive-hover)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "var(--interactive)"; }}
        >
          <Plus size={14} /> 添加模型
        </button>
      </div>

      {/* Editor modal */}
      {editingModel && (
        <div style={{
          padding: "var(--space-4)", background: "var(--bg-secondary)",
          border: "1px solid var(--interactive)", borderRadius: "var(--radius-xl)",
        }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
            <div>
              <label style={labelStyle}>名称</label>
              <input value={editingModel.name} onChange={(e) => setEditingModel({ ...editingModel, name: e.target.value })} placeholder="模型名称" style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>类型</label>
              <select value={editingModel.modelType} onChange={(e) => setEditingModel({ ...editingModel, modelType: e.target.value as EnhancedModelType })} style={{ ...inputStyle, padding: "8px var(--space-3)", cursor: "pointer" }}>
                {MODEL_TYPE_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
              </select>
            </div>
            <div>
              <label style={labelStyle}>提供商</label>
              <select value={editingModel.providerId} onChange={(e) => setEditingModel({ ...editingModel, providerId: e.target.value })} style={{ ...inputStyle, padding: "8px var(--space-3)", cursor: "pointer" }}>
                <option value="">-- 选择 --</option>
                {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div>
              <label style={labelStyle}>模型 ID</label>
              <input value={editingModel.model} onChange={(e) => setEditingModel({ ...editingModel, model: e.target.value })} placeholder="如 gpt-4-vision-preview" style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>描述</label>
              <input value={editingModel.description} onChange={(e) => setEditingModel({ ...editingModel, description: e.target.value })} placeholder="模型描述" style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>能力标签 (逗号分隔)</label>
              <input
                value={editingModel.capabilities.join(", ")}
                onChange={(e) => setEditingModel({ ...editingModel, capabilities: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
                placeholder="如 vision, image-understanding"
                style={inputStyle}
              />
            </div>
            <div>
              <label style={labelStyle}>优先级: {editingModel.priority}</label>
              <input type="range" min={0} max={100} value={editingModel.priority} onChange={(e) => setEditingModel({ ...editingModel, priority: parseInt(e.target.value) })} style={{ width: "100%", accentColor: "var(--interactive)" }} />
            </div>
            <div style={{ display: "flex", gap: "var(--space-2)" }}>
              <button onClick={handleEditSave} style={{
                display: "flex", alignItems: "center", gap: "var(--space-1)",
                padding: "var(--space-2) var(--space-4)", background: "var(--interactive)", color: "#fff",
                fontSize: "var(--text-sm)", borderRadius: "var(--radius-lg)", border: "none", cursor: "pointer",
              }}><Check size={14} /> 保存</button>
              <button onClick={handleEditCancel} style={{
                display: "flex", alignItems: "center", gap: "var(--space-1)",
                padding: "var(--space-2) var(--space-4)", background: "var(--bg-hover)", color: "var(--text-secondary)",
                fontSize: "var(--text-sm)", borderRadius: "var(--radius-lg)", border: "none", cursor: "pointer",
              }}><X size={14} /> 取消</button>
            </div>
          </div>
        </div>
      )}

      {/* Model list */}
      {filteredModels.length === 0 ? (
        <div style={{ textAlign: "center", padding: "var(--space-6)", color: "var(--text-tertiary)", fontSize: "var(--text-sm)" }}>
          暂无该类型的生成模型，点击「添加模型」创建
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
          {filteredModels.map((m) => (
            <div key={m.id} style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: "var(--space-3) var(--space-4)", background: "var(--bg-secondary)",
              border: "1px solid var(--border-primary)", borderRadius: "var(--radius-lg)",
            }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                  <span style={{ fontSize: "var(--text-sm)", fontWeight: "var(--font-medium)", color: "var(--text-primary)" }}>
                    {m.name || "未命名"}
                  </span>
                  <span style={{ fontSize: "var(--text-xs)", padding: "1px 6px", borderRadius: "var(--radius-sm)", background: m.enabled ? "var(--success-light)" : "var(--bg-tertiary)", color: m.enabled ? "var(--success)" : "var(--text-tertiary)" }}>
                    {m.enabled ? "启用" : "禁用"}
                  </span>
                </div>
                <div style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)", marginTop: 2 }}>
                  {providers.find((p) => p.id === m.providerId)?.name ?? m.providerId} / {m.model}
                  {m.capabilities?.length > 0 && ` · ${m.capabilities.join(", ")}`}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-1)", flexShrink: 0 }}>
                <button onClick={() => { setEditingModel({ ...m }); setIsCreating(false); }} title="编辑" style={{
                  padding: 4, border: "none", background: "transparent", color: "var(--text-tertiary)",
                  cursor: "pointer", borderRadius: "var(--radius-sm)",
                }} onMouseEnter={(e) => { e.currentTarget.style.color = "var(--interactive)"; }} onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-tertiary)"; }}>
                  <Edit2 size={14} />
                </button>
                <button onClick={() => handleToggleEnabled(m.id)} title={m.enabled ? "禁用" : "启用"} style={{
                  padding: 4, border: "none", background: "transparent", color: m.enabled ? "var(--success)" : "var(--text-tertiary)",
                  cursor: "pointer", borderRadius: "var(--radius-sm)",
                }}>
                  <ToggleLeft size={14} />
                </button>
                <button onClick={() => handleDelete(m.id)} title="删除" style={{
                  padding: 4, border: "none", background: "transparent", color: "var(--text-tertiary)",
                  cursor: "pointer", borderRadius: "var(--radius-sm)",
                }} onMouseEnter={(e) => { e.currentTarget.style.color = "var(--error)"; }} onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-tertiary)"; }}>
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
