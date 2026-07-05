// =============================================================================
// DeepAnalyze - ModelsPanel
// 4-tab container for model configuration: main/sub/embedding/enhanced
// =============================================================================

import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { useToast } from "../../hooks/useToast";
import { ModuleStatusBar } from "./ModuleStatusBar";
import { MainModelConfig } from "./MainModelConfig";
import { SubModelConfig } from "./SubModelConfig";
import { EmbeddingModelConfig } from "./EmbeddingModelConfig";
import { VLMModelConfig } from "./VLMModelConfig";
import { ASRModelConfig } from "./ASRModelConfig";
import { VideoUnderstandModelConfig } from "./VideoUnderstandModelConfig";
import { EnhancedModelsConfig } from "./EnhancedModelsConfig";
import { DoclingConfig } from "./DoclingConfig";
import { MinerUConfig } from "./MinerUConfig";
import type { ProviderConfig, ProviderDefaults, ProviderSettings, ProviderMetadata } from "../../types/index";
import {
  Bot,
  Sparkles,
  Binary,
  Eye,
  Mic,
  Video,
  Wand,
  FileText,
  Server,
} from "lucide-react";

type ModelTabId = "main" | "sub" | "embedding" | "vlm" | "audio_transcribe" | "video_understand" | "enhanced" | "docling" | "mineru";

const modelTabsRow1: { id: ModelTabId; label: string; icon: React.ReactNode }[] = [
  { id: "main", label: "主模型", icon: <Bot size={14} /> },
  { id: "sub", label: "辅助模型", icon: <Sparkles size={14} /> },
  { id: "embedding", label: "嵌入模型", icon: <Binary size={14} /> },
  { id: "vlm", label: "图像理解", icon: <Eye size={14} /> },
  { id: "video_understand", label: "视频理解", icon: <Video size={14} /> },
];

const modelTabsRow2: { id: ModelTabId; label: string; icon: React.ReactNode }[] = [
  { id: "audio_transcribe", label: "ASR", icon: <Mic size={14} /> },
  { id: "enhanced", label: "生成模型", icon: <Wand size={14} /> },
  { id: "docling", label: "Docling", icon: <FileText size={14} /> },
  { id: "mineru", label: "MinerU", icon: <Server size={14} /> },
];

interface ModelsPanelProps {
  providers: ProviderConfig[];
  settings: ProviderSettings | null;
  registry: ProviderMetadata[];
  onSettingsChanged: () => void;
}

export function ModelsPanel({ providers, settings, registry, onSettingsChanged }: ModelsPanelProps) {
  const { success, error: showError } = useToast();
  const [activeTab, setActiveTab] = useState<ModelTabId>("main");

  const defaults = settings?.defaults ?? null;

  // ModuleStatusBar emits this event when a pill is clicked — decoupled tab navigation
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as ModelTabId;
      if (detail) {
        setActiveTab(detail);
      }
    };
    window.addEventListener("models-tab-navigate", handler);
    return () => window.removeEventListener("models-tab-navigate", handler);
  }, []);

  const handleSetDefault = async (role: string, providerId: string) => {
    try {
      await api.saveDefaults({ [role]: providerId });
      success("默认模型已更新");
      onSettingsChanged();
    } catch {
      showError("更新默认模型失败");
    }
  };

  const handleEmbeddingSave = async (providerId: string) => {
    await api.saveDefaults({ embedding: providerId });
    onSettingsChanged();
  };

  const handleEmbeddingTest = async (providerId: string) => {
    const result = await api.testProvider(providerId);
    return {
      success: result.success,
      message: result.success ? "嵌入模型连接成功!" : (result.error ?? "连接失败"),
    };
  };

  const handleSaveProvider = async (provider: ProviderConfig) => {
    await api.saveProvider(provider);
    onSettingsChanged();
  };

  const tabButtonStyle = (isActive: boolean): React.CSSProperties => ({
    display: "flex",
    alignItems: "center",
    gap: "var(--space-1)",
    padding: "var(--space-2) var(--space-3)",
    border: "none",
    borderBottom: isActive ? "2px solid var(--interactive)" : "2px solid transparent",
    borderRadius: "var(--radius-md) var(--radius-md) 0 0",
    background: isActive ? "var(--interactive-light)" : "transparent",
    color: isActive ? "var(--interactive)" : "var(--text-secondary)",
    fontSize: "var(--text-sm)",
    fontWeight: isActive ? 500 : 400,
    cursor: "pointer",
    transition: "all var(--transition-fast)",
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
      {/* Module status pills — real-time health at the top */}
      <ModuleStatusBar />

      {/* Sub-tabs — two rows */}
      <div style={{ borderBottom: "1px solid var(--border-primary)", paddingBottom: "var(--space-1)" }}>
        {/* Row 1: Core models */}
        <div style={{ display: "flex", gap: "var(--space-1)" }}>
          {modelTabsRow1.map((tab) => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)} style={tabButtonStyle(activeTab === tab.id)}>
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>
        {/* Row 2: Generation & processing */}
        <div style={{ display: "flex", gap: "var(--space-1)", marginTop: "var(--space-1)" }}>
          {modelTabsRow2.map((tab) => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)} style={tabButtonStyle(activeTab === tab.id)}>
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      {activeTab === "main" && (
        <MainModelConfig providers={providers} defaults={defaults} registry={registry} onSetDefault={handleSetDefault} onSaveProvider={handleSaveProvider} />
      )}
      {activeTab === "sub" && (
        <SubModelConfig providers={providers} defaults={defaults} registry={registry} onSetDefault={handleSetDefault} onSaveProvider={handleSaveProvider} />
      )}
      {activeTab === "embedding" && (
        <EmbeddingModelConfig providers={providers} defaults={defaults} onSave={handleEmbeddingSave} onTest={handleEmbeddingTest} />
      )}
      {activeTab === "vlm" && (
        <VLMModelConfig providers={providers} defaults={defaults} registry={registry} onSetDefault={handleSetDefault} onSaveProvider={handleSaveProvider} />
      )}
      {activeTab === "audio_transcribe" && (
        <ASRModelConfig providers={providers} defaults={defaults} registry={registry} onSetDefault={handleSetDefault} onSaveProvider={handleSaveProvider} />
      )}
      {activeTab === "video_understand" && (
        <VideoUnderstandModelConfig providers={providers} defaults={defaults} registry={registry} onSetDefault={handleSetDefault} onSaveProvider={handleSaveProvider} />
      )}
      {activeTab === "enhanced" && (
        <EnhancedModelsConfig providers={providers} />
      )}
      {activeTab === "docling" && (
        <DoclingConfig />
      )}
      {activeTab === "mineru" && (
        <MinerUConfig />
      )}
    </div>
  );
}
