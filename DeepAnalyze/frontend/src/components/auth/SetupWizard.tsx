// frontend/src/components/auth/SetupWizard.tsx
import { useState, useEffect, type CSSProperties } from "react";
import { api } from "../../api/client";

// ─── Types ────────────────────────────────────────────────────────────────
type Mode = "personal" | "enterprise_worker";
type AuthChoice = "none" | "local";
type ModelStrategy = "all_cloud" | "all_local" | "hybrid" | "manual";
type ModelSource = "auto" | "hf" | "hf_mirror" | "enterprise" | "manual";

interface EnvReport {
  cpu: { cores: number; model?: string };
  memory: { totalGb: number; availableGb?: number };
  disk: { totalGb?: number; availableGb: number };
  gpu: { available: boolean; name?: string | null };
  network: { huggingFace: boolean; hfMirror: boolean };
  existingModels?: string[];
}

interface SetupInput {
  mode: Mode;
  authChoice: AuthChoice;
  adminUsername?: string;
  adminPassword?: string;
  hubUrl?: string;
  joinToken?: string;
  modelStrategy: ModelStrategy;
  modelSource: ModelSource;
}

const STEPS = ["环境检测", "模式选择", "认证配置", "模型策略", "模型下载", "完成"];

// ─── Shared styles (match LoginPage patterns) ─────────────────────────────
const fullScreen: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: "100vh",
  background: "var(--bg-primary)",
  padding: "20px",
};

const card: CSSProperties = {
  width: "560px",
  maxWidth: "100%",
  background: "var(--bg-secondary)",
  borderRadius: "var(--radius-lg)",
  border: "1px solid var(--border-primary)",
  boxShadow: "var(--shadow-lg)",
  padding: "32px",
  display: "flex",
  flexDirection: "column",
  gap: "16px",
};

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  border: "1px solid var(--border-primary)",
  borderRadius: "var(--radius-md)",
  background: "var(--bg-tertiary, var(--bg-secondary))",
  color: "var(--text-primary)",
  fontSize: "14px",
  outline: "none",
  boxSizing: "border-box",
};

const labelStyle: CSSProperties = {
  color: "var(--text-secondary)",
  fontSize: "13px",
  marginBottom: "4px",
  display: "block",
};

const primaryBtn: CSSProperties = {
  padding: "10px 20px",
  border: "none",
  borderRadius: "var(--radius-md)",
  background: "var(--accent-primary, #0d6efd)",
  color: "var(--btn-text, #fff)",
  fontSize: "14px",
  cursor: "pointer",
  fontWeight: 500,
};

const secondaryBtn: CSSProperties = {
  ...primaryBtn,
  background: "var(--bg-tertiary, #f8f9fa)",
  color: "var(--text-primary)",
  border: "1px solid var(--border-primary)",
};

const optionBtn = (selected: boolean): CSSProperties => ({
  ...inputStyle,
  cursor: "pointer",
  textAlign: "left" as const,
  background: selected ? "var(--accent-bg, rgba(13,110,253,0.1))" : "var(--bg-tertiary, var(--bg-secondary))",
  border: selected ? "1px solid var(--accent-primary, #0d6efd)" : "1px solid var(--border-primary)",
  padding: "12px",
  borderRadius: "var(--radius-md)",
  color: "var(--text-primary)",
  fontSize: "14px",
  transition: "border-color 0.15s",
});

const infoBox: CSSProperties = {
  padding: "10px 12px",
  background: "var(--bg-tertiary, rgba(0,0,0,0.03))",
  borderRadius: "var(--radius-sm, 4px)",
  border: "1px solid var(--border-primary)",
  color: "var(--text-primary)",
  fontSize: "13px",
};

const sectionTitle: CSSProperties = {
  margin: 0,
  color: "var(--text-primary)",
  fontSize: "18px",
  fontWeight: 600,
};

const sectionDesc: CSSProperties = {
  margin: 0,
  color: "var(--text-secondary)",
  fontSize: "13px",
};

// ─── Main Component ────────────────────────────────────────────────────────
export function SetupWizard({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState(0);
  const [env, setEnv] = useState<EnvReport | null>(null);
  const [envError, setEnvError] = useState("");
  const [input, setInput] = useState<SetupInput>({
    mode: "personal",
    authChoice: "none",
    modelStrategy: "hybrid",
    modelSource: "auto",
  });
  const [downloading, setDownloading] = useState(false);
  const [downloadedModels, setDownloadedModels] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  // Fetch environment report on mount
  useEffect(() => {
    api.setup.getEnvironment()
      .then(d => setEnv(d as EnvReport))
      .catch(e => setEnvError(e instanceof Error ? e.message : String(e)));
  }, []);

  const update = (patch: Partial<SetupInput>) => setInput(prev => ({ ...prev, ...patch }));
  const next = () => setStep(s => Math.min(s + 1, STEPS.length - 1));
  const prev = () => setStep(s => Math.max(s - 1, 0));

  const triggerDownloads = async () => {
    if (input.modelStrategy === "all_cloud" || input.modelSource === "manual" || !env) return;
    setDownloading(true);
    // Trigger downloads for embedding + optionally whisper models
    const models = input.modelStrategy === "all_local"
      ? ["bge-m3", "whisper-tiny", "docling", "paddleocr"]
      : ["bge-m3"]; // hybrid: just embedding
    for (const m of models) {
      try {
        await api.setup.download(m, input.modelSource);
        setDownloadedModels(prev => [...prev, m]);
      } catch (e) {
        console.warn(`Download trigger failed for ${m}:`, e);
      }
    }
    setDownloading(false);
  };

  const finish = async () => {
    setError("");
    setSubmitting(true);
    try {
      await api.setup.complete({
        ...input,
        environment: env,
        providerKeys: {},
      });
      onComplete();
    } catch (e: any) {
      // setup already complete (409) — 视为成功，避免死循环
      if (e && (e.status === 409 || (typeof e.message === "string" && e.message.includes("already complete")))) {
        onComplete();
        return;
      }
      setError(e instanceof Error ? e.message : String(e));
      setStep(STEPS.length - 2); // back to download step on error
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={fullScreen}>
      <div style={card}>
        <Stepper steps={STEPS} current={step} />

        {error && (
          <div style={{
            padding: "8px 12px",
            background: "var(--danger-bg, rgba(220,53,69,0.1))",
            color: "var(--danger-text, #dc3545)",
            borderRadius: "var(--radius-sm, 4px)",
            fontSize: "13px",
          }}>
            {error}
          </div>
        )}

        {step === 0 && <EnvPanel env={env} error={envError} onNext={next} />}
        {step === 1 && <ModePanel input={input} update={update} onNext={next} />}
        {step === 2 && <AuthPanel input={input} update={update} onNext={next} onPrev={prev} />}
        {step === 3 && <ModelStrategyPanel input={input} update={update} onNext={next} onPrev={prev} />}
        {step === 4 && (
          <DownloadPanel
            input={input}
            downloading={downloading}
            downloadedModels={downloadedModels}
            onTrigger={triggerDownloads}
            onNext={next}
            onPrev={prev}
          />
        )}
        {step === 5 && (
          <CompletionPanel input={input} submitting={submitting} onFinish={finish} onPrev={prev} />
        )}
      </div>
    </div>
  );
}

// ─── Stepper ───────────────────────────────────────────────────────────────
function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <div style={{ display: "flex", gap: "4px", marginBottom: "8px", flexWrap: "wrap" }}>
      {steps.map((label, i) => (
        <div key={label} style={{ display: "flex", alignItems: "center", gap: "4px", flex: "1 1 auto", minWidth: "80px" }}>
          <div style={{
            width: "24px",
            height: "24px",
            borderRadius: "50%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "12px",
            fontWeight: 600,
            flexShrink: 0,
            background: i < current ? "var(--success, #198754)"
              : i === current ? "var(--accent-primary, #0d6efd)"
              : "var(--bg-tertiary, #e9ecef)",
            color: i <= current ? "var(--btn-text, #fff)" : "var(--text-secondary)",
          }}>
            {i < current ? "✓" : i + 1}
          </div>
          <span style={{
            fontSize: "12px",
            color: i === current ? "var(--text-primary)" : "var(--text-tertiary, var(--text-secondary))",
            fontWeight: i === current ? 600 : 400,
            whiteSpace: "nowrap",
          }}>
            {label}
          </span>
          {i < steps.length - 1 && (
            <div style={{
              flex: 1,
              height: "1px",
              background: i < current ? "var(--success, #198754)" : "var(--border-primary)",
              minWidth: "12px",
            }} />
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Panel: Environment Detection ──────────────────────────────────────────
function EnvPanel({ env, error, onNext }: { env: EnvReport | null; error: string; onNext: () => void }) {
  return (
    <>
      <h2 style={sectionTitle}>环境检测</h2>
      <p style={sectionDesc}>系统检测到以下硬件和网络环境：</p>

      {error && <div style={{ ...infoBox, color: "var(--danger-text, #dc3545)" }}>检测失败：{error}</div>}

      {!env && !error && <div style={infoBox}>正在检测...</div>}

      {env && (
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <div style={infoBox}>
            <strong>CPU：</strong>{env.cpu.cores} 核心{env.cpu.model ? ` (${env.cpu.model})` : ""}
          </div>
          <div style={infoBox}>
            <strong>内存：</strong>{env.memory.totalGb} GB
            {env.memory.availableGb != null && `（可用 ${env.memory.availableGb} GB）`}
          </div>
          <div style={infoBox}>
            <strong>磁盘：</strong>{env.disk.availableGb} GB 可用
          </div>
          <div style={infoBox}>
            <strong>GPU：</strong>
            {env.gpu.available ? env.gpu.name ?? "已检测" : "未检测到（将使用 CPU 推理）"}
          </div>
          <div style={infoBox}>
            <strong>网络：</strong>
            HuggingFace {env.network.huggingFace ? "✓" : "✗"}
            ｜ 镜像 {env.network.hfMirror ? "✓" : "✗"}
          </div>
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button style={primaryBtn} onClick={onNext} disabled={!env && !error}>
          下一步
        </button>
      </div>
    </>
  );
}

// ─── Panel: Mode Selection ─────────────────────────────────────────────────
function ModePanel({ input, update, onNext }: {
  input: SetupInput; update: (p: Partial<SetupInput>) => void; onNext: () => void;
}) {
  return (
    <>
      <h2 style={sectionTitle}>运行模式</h2>
      <p style={sectionDesc}>选择 DeepAnalyze 的部署模式：</p>

      <button style={optionBtn(input.mode === "personal")} onClick={() => update({ mode: "personal" })}>
        <strong>个人版（Standalone）</strong>
        <br />
        <span style={{ color: "var(--text-secondary)" }}>独立运行，数据本地存储，适合个人使用或开发</span>
      </button>
      <button style={optionBtn(input.mode === "enterprise_worker")} onClick={() => update({ mode: "enterprise_worker" })}>
        <strong>企业 Worker（接入 Hub）</strong>
        <br />
        <span style={{ color: "var(--text-secondary)" }}>连接到企业 Hub 服务器，统一管理认证和技能分发</span>
      </button>

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button style={primaryBtn} onClick={onNext}>下一步</button>
      </div>
    </>
  );
}

// ─── Panel: Auth Configuration ─────────────────────────────────────────────
function AuthPanel({ input, update, onNext, onPrev }: {
  input: SetupInput;
  update: (p: Partial<SetupInput>) => void;
  onNext: () => void;
  onPrev: () => void;
}) {
  const canProceed = input.mode === "enterprise_worker"
    ? (!!input.hubUrl && !!input.joinToken)
    : (input.authChoice === "none" || (!!input.adminUsername && !!input.adminPassword && input.adminPassword.length >= 6));

  return (
    <>
      <h2 style={sectionTitle}>认证配置</h2>

      {input.mode === "personal" ? (
        <>
          <p style={sectionDesc}>选择是否启用登录认证：</p>
          <button style={optionBtn(input.authChoice === "none")} onClick={() => update({ authChoice: "none" })}>
            <strong>免登录</strong>
            <br />
            <span style={{ color: "var(--text-secondary)" }}>直接进入应用，不设置密码（适合本地个人使用）</span>
          </button>
          <button style={optionBtn(input.authChoice === "local")} onClick={() => update({ authChoice: "local" })}>
            <strong>启用登录</strong>
            <br />
            <span style={{ color: "var(--text-secondary)" }}>创建管理员账号，每次访问需要登录</span>
          </button>

          {input.authChoice === "local" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "4px" }}>
              <div>
                <label style={labelStyle}>管理员用户名</label>
                <input
                  style={inputStyle}
                  value={input.adminUsername ?? ""}
                  onChange={e => update({ adminUsername: e.target.value })}
                  placeholder="admin"
                />
              </div>
              <div>
                <label style={labelStyle}>管理员密码（≥6 位）</label>
                <input
                  type="password"
                  style={inputStyle}
                  value={input.adminPassword ?? ""}
                  onChange={e => update({ adminPassword: e.target.value })}
                  placeholder="••••••"
                />
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          <p style={sectionDesc}>填写 Hub 服务器信息（从 Hub 管理员获取）：</p>
          <div>
            <label style={labelStyle}>Hub URL</label>
            <input
              style={inputStyle}
              value={input.hubUrl ?? ""}
              onChange={e => update({ hubUrl: e.target.value })}
              placeholder="https://hub.corp.com:22000"
            />
          </div>
          <div>
            <label style={labelStyle}>Join Token</label>
            <input
              type="password"
              style={inputStyle}
              value={input.joinToken ?? ""}
              onChange={e => update({ joinToken: e.target.value })}
              placeholder="djt_..."
            />
          </div>
        </>
      )}

      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <button style={secondaryBtn} onClick={onPrev}>上一步</button>
        <button style={primaryBtn} onClick={onNext} disabled={!canProceed}>下一步</button>
      </div>
    </>
  );
}

// ─── Panel: Model Strategy ─────────────────────────────────────────────────
function ModelStrategyPanel({ input, update, onNext, onPrev }: {
  input: SetupInput;
  update: (p: Partial<SetupInput>) => void;
  onNext: () => void;
  onPrev: () => void;
}) {
  return (
    <>
      <h2 style={sectionTitle}>模型策略</h2>
      <p style={sectionDesc}>选择模型运行方式：</p>

      <button style={optionBtn(input.modelStrategy === "all_cloud")} onClick={() => update({ modelStrategy: "all_cloud" })}>
        <strong>全部云端 API</strong>
        <br />
        <span style={{ color: "var(--text-secondary)" }}>使用 OpenRouter / GLM 等云端模型，无需本地 GPU</span>
      </button>
      <button style={optionBtn(input.modelStrategy === "all_local")} onClick={() => update({ modelStrategy: "all_local" })}>
        <strong>全部本地</strong>
        <br />
        <span style={{ color: "var(--text-secondary)" }}>所有模型本地运行，完全离线，需要足够硬件</span>
      </button>
      <button style={optionBtn(input.modelStrategy === "hybrid")} onClick={() => update({ modelStrategy: "hybrid" })}>
        <strong>混合（推荐）</strong>
        <br />
        <span style={{ color: "var(--text-secondary)" }}>云端 LLM + 本地 embedding/ASR，平衡性能和成本</span>
      </button>
      <button style={optionBtn(input.modelStrategy === "manual")} onClick={() => update({ modelStrategy: "manual" })}>
        <strong>手动拷贝</strong>
        <br />
        <span style={{ color: "var(--text-secondary)" }}>自行将模型文件放到 data/models/ 目录</span>
      </button>

      <div style={{ marginTop: "8px" }}>
        <label style={labelStyle}>模型下载源</label>
        <select
          style={inputStyle}
          value={input.modelSource}
          onChange={e => update({ modelSource: e.target.value as ModelSource })}
        >
          <option value="auto">自动（探测可用性）</option>
          <option value="hf">HuggingFace 官方</option>
          <option value="hf_mirror">中国镜像（hf-mirror.com）</option>
          {input.mode === "enterprise_worker" && <option value="enterprise">企业内部仓库</option>}
          <option value="manual">手动（不下载）</option>
        </select>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <button style={secondaryBtn} onClick={onPrev}>上一步</button>
        <button style={primaryBtn} onClick={onNext}>下一步</button>
      </div>
    </>
  );
}

// ─── Panel: Model Download ─────────────────────────────────────────────────
function DownloadPanel({ input, downloading, downloadedModels, onTrigger, onNext, onPrev }: {
  input: SetupInput;
  downloading: boolean;
  downloadedModels: string[];
  onTrigger: () => void;
  onNext: () => void;
  onPrev: () => void;
}) {
  const needsDownload = input.modelStrategy !== "all_cloud" && input.modelSource !== "manual";

  return (
    <>
      <h2 style={sectionTitle}>模型下载</h2>

      {!needsDownload && (
        <>
          <p style={sectionDesc}>当前策略不需要下载本地模型。</p>
          <div style={infoBox}>
            {input.modelStrategy === "all_cloud"
              ? "已选择全部云端模式，跳过本地模型下载。"
              : "已选择手动模式，请自行将模型放入 data/models/ 目录。"}
          </div>
        </>
      )}

      {needsDownload && (
        <>
          <p style={sectionDesc}>
            点击下方按钮触发必要的本地模型下载。下载在后台进行，可稍后在设置面板查看进度。
          </p>

          {downloadedModels.length > 0 && (
            <div style={infoBox}>
              已触发下载：{downloadedModels.join(", ")}
            </div>
          )}

          <button
            style={downloading ? { ...primaryBtn, opacity: 0.6 } : primaryBtn}
            onClick={onTrigger}
            disabled={downloading}
          >
            {downloading ? "正在触发下载..." : downloadedModels.length > 0 ? "重新触发下载" : "开始下载"}
          </button>

          <div style={{ ...infoBox, color: "var(--text-secondary)" }}>
            提示：下载是异步的，您可以继续完成设置。模型会在后台下载，下载完成后重启服务即可使用。
          </div>
        </>
      )}

      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <button style={secondaryBtn} onClick={onPrev}>上一步</button>
        <button style={primaryBtn} onClick={onNext}>下一步</button>
      </div>
    </>
  );
}

// ─── Panel: Completion ─────────────────────────────────────────────────────
function CompletionPanel({ input, submitting, onFinish, onPrev }: {
  input: SetupInput;
  submitting: boolean;
  onFinish: () => void;
  onPrev: () => void;
}) {
  const summary: Array<[string, string]> = [
    ["运行模式", input.mode === "personal" ? "个人版" : "企业 Worker"],
    ["认证方式", input.mode === "personal"
      ? (input.authChoice === "local" ? `本地登录（${input.adminUsername}）` : "免登录")
      : `Hub: ${input.hubUrl ?? "-"}`],
    ["模型策略", {
      all_cloud: "全部云端",
      all_local: "全部本地",
      hybrid: "混合",
      manual: "手动",
    }[input.modelStrategy]],
    ["下载源", {
      auto: "自动",
      hf: "HuggingFace",
      hf_mirror: "中国镜像",
      enterprise: "企业仓库",
      manual: "手动",
    }[input.modelSource]],
  ];

  return (
    <>
      <h2 style={sectionTitle}>设置完成</h2>
      <p style={sectionDesc}>请确认配置无误，点击"完成"保存设置：</p>

      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        {summary.map(([k, v]) => (
          <div key={k} style={infoBox}>
            <strong>{k}：</strong>{v}
          </div>
        ))}
      </div>

      <div style={{ ...infoBox, color: "var(--text-secondary)" }}>
        完成后需要重启 DeepAnalyze 以应用新配置。
      </div>

      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <button style={secondaryBtn} onClick={onPrev} disabled={submitting}>上一步</button>
        <button style={submitting ? { ...primaryBtn, opacity: 0.6 } : primaryBtn} onClick={onFinish} disabled={submitting}>
          {submitting ? "保存中..." : "完成设置"}
        </button>
      </div>
    </>
  );
}
