// =============================================================================
// DeepAnalyze - ModuleStatusBar
// 4-pill status bar showing real-time health of embedding/ASR/Docling/MinerU
// Auto-refreshes every 5s. Clicking a pill navigates to the corresponding
// sub-tab in ModelsPanel via a CustomEvent (decoupling — no prop drilling).
// =============================================================================

import { useEffect, useState } from "react";
import { api, type ModuleState } from "../../api/client";
import "./ModuleStatusBar.css";

const MODULE_TO_TAB: Record<string, string> = {
  embedding: "embedding",
  asr: "audio_transcribe",
  docling: "docling",
  mineru: "mineru",
};

const MODULE_LABELS: Record<string, string> = {
  embedding: "嵌入",
  asr: "ASR",
  docling: "Docling",
  mineru: "MinerU",
};

const ORDER = ["embedding", "asr", "docling", "mineru"] as const;

const STATUS_LABELS: Record<ModuleState["status"], string> = {
  not_installed: "未安装",
  installing: "安装中",
  installed: "已就绪",
  running: "运行中",
  error: "错误",
};

export function ModuleStatusBar() {
  const [states, setStates] = useState<Record<string, ModuleState>>({});

  const refresh = async () => {
    try {
      const { modules } = await api.listModules();
      const map: Record<string, ModuleState> = {};
      for (const m of modules) map[m.moduleId] = m;
      setStates(map);
    } catch {
      // Silently fail — status bar is informational only
    }
  };

  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, 5000); // refresh every 5s
    return () => window.clearInterval(id);
  }, []);

  const handleClick = (moduleId: string) => {
    const tabId = MODULE_TO_TAB[moduleId];
    if (!tabId) return;
    // Decoupled navigation: ModelsPanel listens and switches its own tab state
    window.dispatchEvent(new CustomEvent("models-tab-navigate", { detail: tabId }));
  };

  return (
    <div className="module-status-bar">
      {ORDER.map((id) => {
        const state = states[id];
        const status: ModuleState["status"] = state?.status ?? "not_installed";
        return (
          <button
            key={id}
            className={`module-pill module-pill--${status}`}
            onClick={() => handleClick(id)}
            title={state?.lastError ?? `${MODULE_LABELS[id]}: ${status}`}
          >
            <span className={`module-pill__dot module-pill__dot--${status}`} />
            <span className="module-pill__label">{MODULE_LABELS[id]}</span>
            <span className="module-pill__status">{STATUS_LABELS[status]}</span>
          </button>
        );
      })}
    </div>
  );
}
