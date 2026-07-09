/**
 * Migration 041: 全局默认配置模板 seed
 *
 * 背景：config_templates 表（migration 032）建表后从未 seed 任何默认数据，
 * 导致全新部署的「配置模板 → 全局模板」页面显示「未创建」，Worker 首次拉取
 * `/api/v1/config-templates/by-worker/merged` 时拿到空对象，sync 静默跳过
 * 所有字段（appliedFields = 0）。本 migration 写入一份开箱即用的全局基线。
 *
 * 关键：模板字段名必须与 Worker 消费端 DeepAnalyze/src/services/hub/
 * sync-from-hub.ts 的 SYNC_KEYS 对齐（providers / agentSettings / doclingConfig
 * / enhancedModels / hooks）+ moduleStates + fieldLocks。早期 Hub 类型用的
 * 模型角色名（main/thinking/...）Worker 不识别，已废弃。
 *
 * 默认值来源（逐项核对 Worker 源码）：
 *  - providers          ← EMPTY_PROVIDER_DEFAULTS (settings.ts:4)
 *  - agentSettings      ← DEFAULT_AGENT_SETTINGS  (agent/types.ts:418)
 *  - doclingConfig      ← main.ts:617 (rapidocr + accurate)
 *  - moduleStates.*     ← 029_module_states.ts schema 默认值
 *                        (not_installed / disabled，保留 modules.ts:34 的
 *                         isFirstRun 语义：mode=disabled 即「未配置」)
 *
 * fieldLocks.lockedPaths = [] → 模板仅作为「推荐基线」：仅在 Worker 本地
 * 值为空时填充，不覆盖用户已有自定义配置（sync-from-hub.ts shouldApplyField）。
 *
 * 幂等：ON CONFLICT (id) DO NOTHING（与 008/037 seed 范式一致）。
 * 排序保证 008 (seed admin) 先于 041 运行，故 updated_by='admin' 外键成立。
 */
import type { QueryResultRow } from "pg";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<import("pg").QueryResult<T>>;

const DEFAULT_TEMPLATE = {
  providers: {
    providers: [],
    defaults: {
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
    },
  },
  agentSettings: {
    maxTurns: -1,
    contextWindow: 200000,
    compactionBuffer: 13000,
    sessionMemoryInitThreshold: 10000,
    sessionMemoryUpdateInterval: 5000,
    microcompactKeepTurns: 10,
    autoDreamIntervalHours: 24,
    autoDreamSessionThreshold: 5,
    contextLoadRatio: 0.5,
    toolResultMaxTokens: 8000,
    toolResultKeepRecent: 10,
    smCompactMinTokens: 10000,
    smCompactMaxTokens: 40000,
    stuckDetectionThreshold: 5,
    consecutiveErrorThreshold: 3,
    subAgentMaxTurns: 200,
    outputTokenBudget: 32768,
    reservedOutputTokens: 20000,
    proactiveCompactLowerRatio: 0.7,
    proactiveCompactUpperRatio: 0.85,
  },
  doclingConfig: {
    pipeline: "rapidocr",
    table_mode: "accurate",
    parallelism: 5,
    ocr_engine: "rapidocr",
  },
  moduleStates: {
    embedding: { status: "not_installed", mode: "disabled" },
    asr: { status: "not_installed", mode: "disabled" },
    docling: { status: "not_installed", mode: "disabled" },
    mineru: { status: "not_installed", mode: "disabled" },
  },
  fieldLocks: { lockedPaths: [] },
};

export async function up(query: QueryFn): Promise<void> {
  const content = JSON.stringify(DEFAULT_TEMPLATE);

  // 两条 INSERT 各自幂等，不依赖 SELECT 串行判断（避免 TOCTOU：若第一条成功
  // 第二条失败，重跑时 SELECT 短路会永久漏掉 history 行）。
  // runner 不为 seed 包事务（与 008/033/037 一致），故每条语句必须自幂等。
  //
  // 注意：upsertGlobalTemplate（domain 层）用单连接事务保证模板行 + history
  // 行原子；seed 这里无法拿到同一连接，改用语句级幂等 + 自愈（部分失败重跑
  // 时 history 的 WHERE NOT EXISTS 会补插缺失行）达到等价效果。

  // 1. 写入全局模板：已存在则跳过（不覆盖用户后续编辑）
  await query(
    `INSERT INTO config_templates (id, org_id, scope, content, version, updated_by, updated_at)
     VALUES ('tmpl_global', NULL, 'global', $1::jsonb, 1, 'admin', now())
     ON CONFLICT (id) DO NOTHING`,
    [content],
  );

  // 2. history 审计行：仅当尚无 v1 记录时补插（history 表无 (template_id,
  //    version) 唯一约束、是 BIGSERIAL 主键，故 ON CONFLICT 对它无效，改用
  //    WHERE NOT EXISTS 防重）
  await query(
    `INSERT INTO config_template_history
       (template_id, org_id, scope, content, version, updated_by, updated_at)
     SELECT 'tmpl_global', NULL, 'global', $1::jsonb, 1, 'admin', now()
     WHERE NOT EXISTS (
       SELECT 1 FROM config_template_history
       WHERE template_id = 'tmpl_global' AND version = 1
     )`,
    [content],
  );
}

export async function down(query: QueryFn): Promise<void> {
  await query(
    `DELETE FROM config_template_history WHERE template_id = 'tmpl_global'`,
  );
  await query(`DELETE FROM config_templates WHERE id = 'tmpl_global'`);
}
