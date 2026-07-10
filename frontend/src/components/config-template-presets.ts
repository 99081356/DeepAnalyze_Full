// config-template-presets.ts
//
// Preset templates + field reference data for the Config Template editor's
// guidance UI. Kept as a separate module so ConfigTemplateGuide.tsx stays
// presentational.
//
// IMPORTANT: top-level key names MUST match what DA's sync-from-hub.ts
// recognizes (its SYNC_KEYS): providers / agentSettings / doclingConfig /
// enhancedModels / hooks / moduleStates / fieldLocks. The doclingConfig inner
// fields must match DA's DoclingConfig (layout_model / ocr_engine / ...), NOT
// the legacy "pipeline" name.

/* -------------------------------------------------------------------------- */
/*  Preset templates                                                          */
/* -------------------------------------------------------------------------- */

export interface PresetTemplate {
  key: string;
  label: string;
  description: string;
  content: Record<string, unknown>;
}

export const PRESET_TEMPLATES: PresetTemplate[] = [
  {
    key: "unified-baseline",
    label: "统一模型基线",
    description:
      "预填 providers + agentSettings + doclingConfig + moduleStates 作为推荐基线（不锁，不覆盖 DA 已有值）。改完 apiKey/模型名即可保存。",
    content: {
      providers: {
        providers: [
          {
            id: "glm",
            name: "智谱GLM",
            type: "openai-compatible",
            endpoint: "https://open.bigmodel.cn/api/paas/v4",
            apiKey: "在此填API Key",
            model: "glm-4.6",
            enabled: true,
            supportsToolUse: true,
          },
        ],
        defaults: {
          main: "glm",
          summarizer: "glm",
          embedding: "",
          vlm: "",
          tts: "",
          image_gen: "",
          video_gen: "",
          music_gen: "",
          audio_transcribe: "",
          video_understand: "",
        },
      },
      agentSettings: {
        maxTurns: -1,
        contextWindow: 200000,
        outputTokenBudget: 32768,
        compactionBuffer: 13000,
        subAgentMaxTurns: 200,
        consecutiveErrorThreshold: 3,
        stuckDetectionThreshold: 5,
        toolResultMaxTokens: 8000,
        proactiveCompactLowerRatio: 0.7,
        proactiveCompactUpperRatio: 0.85,
      },
      doclingConfig: {
        ocr_engine: "rapidocr",
        ocr_backend: "torch",
        table_mode: "accurate",
        parallelism: 5,
        use_vlm: false,
        layout_model: "docling-project/docling-layout-heron",
        vlm_model: "zai-org/GLM-OCR",
        vlm_mode: "inline",
      },
      moduleStates: {
        embedding: { status: "not_installed", mode: "disabled" },
        asr: { status: "not_installed", mode: "disabled" },
        docling: { status: "not_installed", mode: "disabled" },
        mineru: { status: "not_installed", mode: "disabled" },
      },
      enhancedModels: [],
      hooks: [],
      // No locks by default — a preset is a recommendation baseline, not an
      // override. Locking providers here would risk force-pushing the
      // placeholder apiKey below into every worker if a user saved without
      // editing it. Users who want enforcement can add locks per the field
      // guide (fieldLocks.lockedPaths).
      fieldLocks: { lockedPaths: [] },
    },
  },
];

/* -------------------------------------------------------------------------- */
/*  Field reference                                                           */
/* -------------------------------------------------------------------------- */

export interface FieldGuideEntry {
  /** Top-level JSON key (or "fieldLocks" note). */
  field: string;
  /** One-line purpose. */
  purpose: string;
  /** What it controls / where it shows up in DA. */
  detail: string;
  /** What to put in fieldLocks.lockedPaths to lock it, or null if N/A. */
  lockPath: string | null;
}

export const FIELD_GUIDE: FieldGuideEntry[] = [
  {
    field: "providers",
    purpose: "AI 模型清单 + 角色分配",
    detail:
      "providers[] 是模型配置（id/地址/key/模型名），defaults 把 10 个角色（main 主模型、summarizer 辅助、embedding 向量化、vlm 图像理解…）映射到 provider id。对应 DA 设置→模型配置。",
    lockPath: '"providers"',
  },
  {
    field: "agentSettings",
    purpose: "Agent 运行参数",
    detail:
      "maxTurns 最大轮次(-1无限)、contextWindow 上下文窗口、outputTokenBudget 输出预算、subAgentMaxTurns 子Agent轮次等。对应 DA 设置→通用→Agent 运行参数。",
    lockPath: '"agentSettings"',
  },
  {
    field: "doclingConfig",
    purpose: "文档解析选项",
    detail:
      "ocr_engine(rapidocr/easyocr)、ocr_backend(torch/onnxruntime)、table_mode(accurate/fast)、parallelism(1-10)、use_vlm。对应 DA 设置→模型配置→Docling。",
    lockPath: '"doclingConfig"',
  },
  {
    field: "moduleStates",
    purpose: "4 个本地模块状态",
    detail:
      "embedding/asr/docling/mineru 各一项。mode: disabled(关)/local(本地部署)/remote(远端API)。建议保持 disabled 让用户自行安装。remote 时加 endpoint。",
    lockPath: '"moduleStates.docling"（锁单个模块）',
  },
  {
    field: "enhancedModels",
    purpose: "图像/视频/音乐/语音生成模型",
    detail: "数组，每项含 modelType(image_gen/video_gen/music_gen/tts) 和 providerId。不用就留空 []。",
    lockPath: '"enhancedModels"',
  },
  {
    field: "hooks",
    purpose: "生命周期钩子",
    detail: "在工具调用前后、会话开始结束等事件挂 shell 命令或 HTTP 回调。DA 端无 UI，仅靠模板下发。不用就留空 []。",
    lockPath: '"hooks"',
  },
  {
    field: "fieldLocks",
    purpose: "锁定字段（决定强制覆盖还是只填空）",
    detail:
      'lockedPaths 里列出的字段=强制覆盖 DA 本地值；不在列表的=只在 DA 本地为空时填充。providers/agentSettings/doclingConfig 等只能锁整个（填顶层 key 名），不支持锁子字段。模块需锁到具体 id，如 "moduleStates.docling"。',
    lockPath: null,
  },
];
