// =============================================================================
// DeepAnalyze - SystemStatusBanner
// Polls /api/health and surfaces non-fatal system issues (embedding fallback,
// no LLM configured) as a small banner at the top of the app.
// =============================================================================

import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { AlertTriangle, AlertCircle } from "lucide-react";

interface BannerState {
  kind: "embedding_degraded" | "embedding_not_configured" | "llm_not_configured";
  message: string;
}

// --- Subservice status (ModelServiceSupervisor) ---

type ServiceStatus = "running" | "degraded" | "missing_weights" | "disabled";

const SERVICE_STATUS_COLOR: Record<ServiceStatus, string> = {
  running: "var(--success)",
  degraded: "var(--warning)",
  missing_weights: "var(--error)",
  disabled: "var(--text-tertiary)",
};

const SERVICE_STATUS_LABEL: Record<ServiceStatus, string> = {
  running: "正常",
  degraded: "降级",
  missing_weights: "缺权重",
  disabled: "未启用",
};

const SERVICE_LABELS: Record<string, string> = {
  embedding: "Embedding",
  whisper: "Whisper",
  docling: "Docling",
  paddleocr: "PaddleOCR",
};

export function SystemStatusBanner() {
  const [banners, setBanners] = useState<BannerState[]>([]);
  const [serviceStatus, setServiceStatus] = useState<Record<string, ServiceStatus>>({});

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const POLL_INTERVAL_MS = 60_000;

    const poll = async () => {
      try {
        const result = await api.health();
        if (cancelled) return;

        const next: BannerState[] = [];

        if (result.embedding?.status === "not_configured") {
          // Proactive: cloud embedding provider preset without API key.
          // Fires at startup before the first indexing call fails. See issue #77.
          next.push({
            kind: "embedding_not_configured",
            message: "默认 embedding provider 缺 API key，语义检索将降级为 hash 兜底。请到「设置 → 模型配置」添加 key，或选择本地 embedding。",
          });
        } else if (result.embedding?.degraded) {
          const cooldown = result.embedding.cooldownRemainingMs ?? 0;
          next.push({
            kind: "embedding_degraded",
            message: cooldown > 0
              ? `嵌入服务降级中（hash 兜底），语义检索质量下降。将在 ${Math.ceil(cooldown / 1000)}s 后重试。`
              : "嵌入服务降级中（hash 兜底），语义检索质量下降。",
          });
        }

        if (result.llm?.status === "not_configured") {
          next.push({
            kind: "llm_not_configured",
            message: "尚未配置任何 LLM provider。请到「设置 → 模型配置」添加至少一个 API key。",
          });
        }

        if (!cancelled) setBanners(next);
      } catch {
        // Network glitch — silently retry on next interval.
      } finally {
        if (!cancelled) {
          timer = setTimeout(poll, POLL_INTERVAL_MS);
        }
      }
    };

    poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  // --- Subservice status poll (ModelServiceSupervisor) ---
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const POLL_MS = 30_000;

    const poll = async () => {
      try {
        const data = await api.get<Record<string, ServiceStatus>>("/api/settings/services");
        if (!cancelled) setServiceStatus(data);
      } catch {
        // Silently skip — supervisor may not be initialized
      } finally {
        if (!cancelled) timer = setTimeout(poll, POLL_MS);
      }
    };

    poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const serviceEntries = Object.entries(serviceStatus);

  if (banners.length === 0 && serviceEntries.length === 0) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)", flexShrink: 0 }}>
      {serviceEntries.length > 0 && (
        <div style={{
          display: "flex",
          gap: "var(--space-2)",
          padding: "var(--space-1) var(--space-3)",
          flexWrap: "wrap",
        }}>
          {serviceEntries.map(([name, st]) => (
            <span
              key={name}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "var(--space-1)",
                padding: "2px var(--space-2)",
                borderRadius: "var(--radius-sm)",
                background: SERVICE_STATUS_COLOR[st],
                color: "#fff",
                fontSize: "var(--text-xs)",
                fontWeight: "var(--font-medium)",
              }}
            >
              <span style={{
                width: 6, height: 6, borderRadius: "50%",
                background: "#fff", flexShrink: 0,
              }} />
              {SERVICE_LABELS[name] || name}: {SERVICE_STATUS_LABEL[st]}
            </span>
          ))}
        </div>
      )}
      {/* Existing health banners below */}
      {banners.map((b, i) => {
        // Only "llm_not_configured" is truly critical (app cannot chat).
        // "embedding_not_configured" degrades search to FTS/hash fallback but chat works —
        // same severity as runtime "embedding_degraded" (warning). See issue #79.
        const isCritical = b.kind === "llm_not_configured";
        const Icon = isCritical ? AlertCircle : AlertTriangle;
        const bg = isCritical ? "var(--error)" : "var(--warning)";
        return (
          <div
            key={`${b.kind}-${i}`}
            role="status"
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-2)",
              padding: "var(--space-2) var(--space-3)",
              backgroundColor: bg,
              color: "#fff",
              fontSize: "var(--text-sm)",
              fontWeight: "var(--font-medium)",
            }}
          >
            <Icon size={14} />
            <span>{b.message}</span>
          </div>
        );
      })}
    </div>
  );
}

export default SystemStatusBanner;
