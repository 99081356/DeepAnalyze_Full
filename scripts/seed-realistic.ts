/**
 * 真实测试数据 seed 脚本
 * 用法: bun run scripts/seed-realistic.ts
 *
 * 幂等：可重复运行，每次结果一致（先 TRUNCATE 再插入）
 * 安全门：生产环境拒绝运行
 */

import { query, closePool } from "../src/store/pg.js";
import { randomUUID } from "crypto";
import bcrypt from "bcrypt";
import { createHash } from "crypto";

// ── 安全门 ──
if (process.env.NODE_ENV === "production") {
  console.error("❌ seed script refused in production environment");
  process.exit(1);
}

// ── 数据定义 ──

interface OrgDef {
  id: string; name: string; code: string; type: string;
  level: number; parent_code: string | null; path: string;
}

const ORGS: OrgDef[] = [
  // path 使用 "/" 分隔符，与 domain/organization.ts 的 computePathLevel 一致。
  // getSubtree() 依赖 path LIKE 'root/%' 前缀匹配，不能用 "." 分隔。
  { id: "org_dsi",     name: "深度智能科技",       code: "DSI",   type: "company",    level: 1, parent_code: null,    path: "dsi" },
  { id: "org_prc",     name: "产品研发中心",       code: "PRC",   type: "department", level: 2, parent_code: "DSI",   path: "dsi/prc" },
  { id: "org_infra",   name: "基础平台部",         code: "INFRA", type: "department", level: 3, parent_code: "PRC",   path: "dsi/prc/infra" },
  { id: "org_agent",   name: "Agent 引擎组",       code: "AGENT", type: "team",       level: 4, parent_code: "INFRA", path: "dsi/prc/infra/agent" },
  { id: "org_data",    name: "数据基础设施组",     code: "DATA",  type: "team",       level: 4, parent_code: "INFRA", path: "dsi/prc/infra/data" },
  { id: "org_app",     name: "应用产品部",         code: "APP",   type: "department", level: 3, parent_code: "PRC",   path: "dsi/prc/app" },
  { id: "org_kb",      name: "知识库产品组",       code: "KB",    type: "team",       level: 4, parent_code: "APP",   path: "dsi/prc/app/kb" },
  { id: "org_comm",    name: "商业化中心",         code: "COMM",  type: "department", level: 2, parent_code: "DSI",   path: "dsi/comm" },
  { id: "org_sol",     name: "解决方案部",         code: "SOL",   type: "department", level: 3, parent_code: "COMM",  path: "dsi/comm/sol" },
  { id: "org_cs",      name: "客户成功部",         code: "CS",    type: "department", level: 3, parent_code: "COMM",  path: "dsi/comm/cs" },
  { id: "org_sec",     name: "安全合规部",         code: "SEC",   type: "department", level: 2, parent_code: "DSI",   path: "dsi/sec" },
];

interface UserDef {
  id: string; username: string; display_name: string;
  password: string; org_code: string;
  is_super_admin: boolean; is_org_admin: boolean;
}

const DEFAULT_PW = "Test1234!";
const PW_HASH = bcrypt.hashSync(DEFAULT_PW, 10);

const USERS: UserDef[] = [
  { id: "u_admin",    username: "admin",         display_name: "系统管理员", password: "admin123", org_code: "DSI",   is_super_admin: true,  is_org_admin: false },
  { id: "u_wangsy",   username: "wang.siyuan",   display_name: "王思远",     password: DEFAULT_PW, org_code: "AGENT", is_super_admin: false, is_org_admin: true },
  { id: "u_linyq",    username: "lin.yuqing",    display_name: "林雨晴",     password: DEFAULT_PW, org_code: "DATA",  is_super_admin: false, is_org_admin: true },
  { id: "u_chenyf",   username: "chen.yifan",    display_name: "陈一帆",     password: DEFAULT_PW, org_code: "KB",    is_super_admin: false, is_org_admin: true },
  { id: "u_zhouml",   username: "zhou.minglang", display_name: "周明朗",     password: DEFAULT_PW, org_code: "SOL",   is_super_admin: false, is_org_admin: true },
  { id: "u_zhaorh",   username: "zhao.ruihua",   display_name: "赵瑞华",     password: DEFAULT_PW, org_code: "SEC",   is_super_admin: false, is_org_admin: true },
  { id: "u_liuty",    username: "liu.tianyu",    display_name: "刘天宇",     password: DEFAULT_PW, org_code: "AGENT", is_super_admin: false, is_org_admin: false },
  { id: "u_sunjy",    username: "sun.jiayi",     display_name: "孙佳怡",     password: DEFAULT_PW, org_code: "KB",    is_super_admin: false, is_org_admin: false },
  { id: "u_wuhr",     username: "wu.haoran",     display_name: "吴浩然",     password: DEFAULT_PW, org_code: "SOL",   is_super_admin: false, is_org_admin: false },
  { id: "u_zhengxy",  username: "zheng.xinyi",   display_name: "郑心怡",     password: DEFAULT_PW, org_code: "CS",    is_super_admin: false, is_org_admin: false },
  { id: "u_huangzx",  username: "huang.zixuan",  display_name: "黄子轩",     password: DEFAULT_PW, org_code: "SEC",   is_super_admin: false, is_org_admin: false },
  { id: "u_xush",     username: "xu.shihan",     display_name: "徐诗涵",     password: DEFAULT_PW, org_code: "DATA",  is_super_admin: false, is_org_admin: false },
  { id: "u_hej",      username: "he.jun",        display_name: "何军",       password: DEFAULT_PW, org_code: "CS",    is_super_admin: false, is_org_admin: false },
  { id: "u_guoy",     username: "guo.yang",      display_name: "郭洋",       password: DEFAULT_PW, org_code: "APP",   is_super_admin: false, is_org_admin: false },
  { id: "u_tangl",    username: "tang.lin",      display_name: "唐琳",       password: DEFAULT_PW, org_code: "AGENT", is_super_admin: false, is_org_admin: false },
  { id: "u_fengxy",   username: "feng.xueyao",   display_name: "冯雪瑶",     password: DEFAULT_PW, org_code: "KB",    is_super_admin: false, is_org_admin: false },
  { id: "u_yangzw",   username: "yang.zhiwei",   display_name: "杨智威",     password: DEFAULT_PW, org_code: "SOL",   is_super_admin: false, is_org_admin: false },
  { id: "u_qinr",     username: "qin.rui",       display_name: "秦蕊",       password: DEFAULT_PW, org_code: "SEC",   is_super_admin: false, is_org_admin: false },
  { id: "u_luoht",    username: "luo.haotian",   display_name: "罗浩天",     password: DEFAULT_PW, org_code: "DATA",  is_super_admin: false, is_org_admin: false },
];

interface SkillDef {
  id: string; name: string; slug: string; display_name: string;
  description: string; scope: "system" | "org" | "user";
  org_code: string | null; author_username: string;
  category: string; tags: string[]; icon: string;
  trust_level: string; version: string; content: string; change_summary: string;
}

const SKILLS: SkillDef[] = [
  {
    id: "sk_agent_debug", name: "da-agent-debug", slug: "da-agent-debug",
    display_name: "DA Agent 调试技巧",
    description: "DA Agent 调试技巧：如何定位工具调用失败、流式中断、上下文超限等问题。包含常见错误模式、日志排查路径、以及工具链断点恢复策略。",
    scope: "system", org_code: null, author_username: "wang.siyuan",
    category: "engineering", tags: ["agent", "debug", "streaming"], icon: "🔧",
    trust_level: "verified", version: "1.0.0",
    content: "## DA Agent 调试技巧\n\n### 工具调用失败\n\n- 检查 `tool-setup.ts` 中工具是否正确注册\n- 查看 `/tmp/da_debug*.log` 中 ERROR 级别日志\n- 确认工具参数符合 zod schema\n\n### 流式中断\n\n- SSE 连接超时通常是 30s 无输出\n- 检查 `orchestrator.ts` 中 `streamTimeout`\n- 心跳机制：每 5s 发空注释保持连接\n\n### 上下文超限\n\n- 用 `context_window` 监控 token 使用\n- 超过 80% 时触发摘要压缩\n- 子 Agent 结果用 `push_content` 而非全文返回",
    change_summary: "初版发布：涵盖工具调用、流式、上下文三大场景",
  },
  {
    id: "sk_report_writing", name: "kb-report-writing", slug: "kb-report-writing",
    display_name: "知识库报告写作",
    description: "知识库报告写作规范：结构化输出、引用校验、避免幻觉的实用指南。适用于分析报告、调研报告、技术文档等场景。",
    scope: "system", org_code: null, author_username: "chen.yifan",
    category: "writing", tags: ["report", "citation", "anti-hallucination"], icon: "📝",
    trust_level: "verified", version: "2.1.0",
    content: "## 报告写作规范\n\n### 结构\n\n1. **摘要**：100 字以内，结论先行\n2. **正文**：每个发现一个 H2\n3. **引用**：格式 `[[doc:页面ID]]`\n\n### 引用校验\n\n- 每个事实必须有引用\n- 引用 ID 必须在 `wiki_pages` 表存在\n- 避免引用空白页\n\n### 幻觉防护\n\n- 不确定时标注「未找到确凿证据」\n- 数值需要交叉验证\n- 避免跨文档拼接无关信息",
    change_summary: "v2.1：增加引用校验章节，强化幻觉防护",
  },
  {
    id: "sk_cost_opt", name: "infra-cost-opt", slug: "infra-cost-opt",
    display_name: "云成本优化清单",
    description: "AWS/阿里云成本优化 checklist：闲置资源识别、reserved instance 决策、存储生命周期管理。按月执行一次可有效降低 15-30% 云开支。",
    scope: "org", org_code: "DSI", author_username: "lin.yuqing",
    category: "operations", tags: ["aws", "cost", "ri"], icon: "⚙️",
    trust_level: "verified", version: "1.2.0",
    content: "## 云成本优化清单\n\n### 闲置资源\n\n- [ ] EC2/ECS 实例 CPU < 5% 连续 7 天\n- [ ] RDS 连接数 < 10 持续 14 天\n- [ ] Load Balancer 无健康目标\n\n### Reserved Instance\n\n- 1 年承诺节省 ~40%\n- 3 年承诺节省 ~60%\n- 建议对稳定负载选 1 年 RI\n\n### 存储生命周期\n\n- S3/OSS：30 天后转 IA\n- 90 天后转 Archive\n- 日志类数据直接 Archive",
    change_summary: "v1.2：补充存储生命周期管理章节",
  },
  {
    id: "sk_onboarding", name: "customer-onboarding", slug: "customer-onboarding",
    display_name: "客户 Onboarding 流程",
    description: "新客户 onboarding 标准流程：需求确认 → 环境配置 → 培训交付 → 验收签字。平均周期 2 周，确保客户首月活跃率 > 80%。",
    scope: "org", org_code: "SOL", author_username: "zhou.minglang",
    category: "business", tags: ["onboarding", "sop"], icon: "💼",
    trust_level: "verified", version: "3.0.0",
    content: "## 客户 Onboarding 流程\n\n### 第一周：需求确认\n\n1. Kickoff 会议（1h）\n2. 收集业务场景清单\n3. 确认 KPI 指标\n4. 输出《需求确认书》\n\n### 第二周：环境配置\n\n1. 创建 Hub 组织\n2. 配置 SSO（如需要）\n3. 部署 Worker\n4. 加载初始 Skill 包\n\n### 第三周：培训交付\n\n1. 管理员培训（2h）\n2. 终端用户培训（2h × N 场）\n3. 发放操作手册\n\n### 验收\n\n- 客户完成 3 个真实场景测试\n- 签字确认",
    change_summary: "v3.0：全面重构，按周拆分交付物",
  },
  {
    id: "sk_audit_prep", name: "security-audit-prep", slug: "security-audit-prep",
    display_name: "等保 2.0 审计准备",
    description: "等保 2.0 二级/三级审计准备清单：日志保留 6 个月、访问审计完整性、漏洞扫描证据链。配合安全合规部年度审计使用。",
    scope: "org", org_code: "SEC", author_username: "zhao.ruihua",
    category: "security", tags: ["compliance", "audit", "等保"], icon: "🛡️",
    trust_level: "verified", version: "1.1.0",
    content: "## 等保 2.0 审计准备\n\n### 日志保留\n\n- 操作日志 ≥ 6 个月\n- 审计日志 ≥ 12 个月\n- 日志不可篡改（append-only）\n\n### 访问审计\n\n- 所有管理操作有审计记录\n- 审计记录包含：时间、操作人、操作内容、结果\n- 定期导出审计报告\n\n### 漏洞扫描\n\n- 每月一次全量扫描\n- 高危漏洞 24h 内修复\n- 中危漏洞 7 天内修复\n\n### 证据链\n\n- 扫描报告 PDF\n- 修复 commit 记录\n- 复测报告",
    change_summary: "v1.1：增加证据链章节",
  },
  {
    id: "sk_note_taking", name: "personal-note-taking", slug: "personal-note-taking",
    display_name: "个人笔记管理",
    description: "个人笔记整理习惯：obsidian tag 体系、Zettelkasten 实践、每日回顾流程。帮助知识工作者建立可持续的个人知识库。",
    scope: "user", org_code: null, author_username: "sun.jiayi",
    category: "productivity", tags: ["obsidian", "notes", "zettelkasten"], icon: "🗒️",
    trust_level: "community", version: "1.0.0",
    content: "## 个人笔记管理\n\n### Tag 体系\n\n- `#area/xxx` — 持续关注领域\n- `#project/xxx` — 进行中项目\n- `#resource/xxx` — 参考资料\n- `#archive/xxx` — 已归档\n\n### Zettelkasten\n\n- 每个 note 只讲一件事\n- note 之间用 `[[wikilink]]` 连接\n- 定期整理 backlinks\n\n### 每日回顾\n\n- 晨间：规划今日 3 件事\n- 晚间：记录完成 + 反思\n- 周末：整理本周笔记",
    change_summary: "初版发布",
  },
];

// ── 执行 ──

async function seed() {
  console.log("🌱 Starting realistic seed...\n");

  // 1. TRUNCATE
  console.log("1. TRUNCATE business tables...");
  await query(`
    TRUNCATE skill_audit_logs, skill_usage_logs, skill_subscriptions,
      skill_sharings, skill_versions, skill_packages, skill_sync_queue,
      skill_approvals, worker_skill_cache, workers, user_api_keys,
      user_roles, users, organizations CASCADE
  `);

  // 1.5. 重建系统角色 + 权限映射
  // TRUNCATE ... CASCADE 会级联清除 roles（因 roles.org_id → organizations）
  // 和 role_permissions（因 role_permissions.role_id → roles），需在此重建。
  console.log("1.5. Re-seed system roles + permission mappings...");
  await query(`
    INSERT INTO roles (id, name, org_id, description, is_system) VALUES
      ('role_super_admin', '超级管理员', NULL, '系统全权限', TRUE),
      ('role_org_admin', '组织管理员', NULL, '本组织管理权限', TRUE),
      ('role_user', '普通用户', NULL, '基本使用权限', TRUE)
    ON CONFLICT (id) DO NOTHING
  `);
  // super_admin 拥有所有权限（自动适配后续 migration 新增的权限码）
  await query(`
    INSERT INTO role_permissions (role_id, permission_id)
    SELECT 'role_super_admin', id FROM permissions
    ON CONFLICT DO NOTHING
  `);
  // org_admin: 组织/用户/角色/Worker/Skill 管理 + 只读配置
  await query(`
    INSERT INTO role_permissions (role_id, permission_id)
    SELECT 'role_org_admin', p.id FROM permissions p
    WHERE p.code = ANY($1::text[])
    ON CONFLICT DO NOTHING
  `, [[
    "org:read", "org:create", "org:update",
    "user:create", "user:read", "user:update", "user:delete",
    "role:read", "role:assign",
    "worker:read", "worker:approve", "worker:reject",
    "skill:read", "skill:create", "skill:share", "skill:approve",
    "skill:kill", "skill:publish", "skill:subscribe",
    "config:read", "usage:read",
  ]]);
  // user: 基本只读 + 订阅
  await query(`
    INSERT INTO role_permissions (role_id, permission_id)
    SELECT 'role_user', p.id FROM permissions p
    WHERE p.code = ANY($1::text[])
    ON CONFLICT DO NOTHING
  `, [["skill:read", "worker:read", "config:read", "skill:subscribe"]]);

  // 2. 插入组织树
  console.log("2. Insert org tree (11 nodes)...");
  for (const org of ORGS) {
    const parent = org.parent_code ? ORGS.find(o => o.code === org.parent_code) : null;
    await query(
      `INSERT INTO organizations (id, name, code, description, parent_id, level, path, type, status, settings)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', '{}')`,
      [org.id, org.name, org.code, `${org.name}（${org.code}）`,
       parent?.id ?? null, org.level, org.path, org.type],
    );
  }

  // 3. 插入用户
  console.log("3. Insert users (19 people)...");
  for (const u of USERS) {
    const org = ORGS.find(o => o.code === u.org_code)!;
    const hash = u.username === "admin" ? bcrypt.hashSync(u.password, 10) : PW_HASH;
    await query(
      `INSERT INTO users (id, username, display_name, password_hash, role, status, auth_source,
         is_super_admin, is_org_admin, organization_id)
       VALUES ($1, $2, $3, $4, 'admin', 'active', 'local', $5, $6, $7)`,
      [u.id, u.username, u.display_name, hash,
       u.is_super_admin, u.is_org_admin, org.id],
    );
  }

  // 4. 绑定角色
  console.log("4. Assign roles...");
  const { rows: roles } = await query<{ id: string; name: string }>(
    "SELECT id, name FROM roles WHERE is_system = TRUE",
  );
  const roleByCode = Object.fromEntries(roles.map(r => [r.id, r.id]));

  const ORG_ADMINS: Record<string, string> = {
    "wang.siyuan": "AGENT",
    "lin.yuqing": "DATA",
    "chen.yifan": "KB",
    "zhou.minglang": "SOL",
    "zhao.ruihua": "SEC",
  };

  for (const [username, orgCode] of Object.entries(ORG_ADMINS)) {
    const user = USERS.find(u => u.username === username)!;
    const org = ORGS.find(o => o.code === orgCode)!;
    const roleId = randomUUID();
    await query(
      `INSERT INTO roles (id, name, org_id, description, is_system)
       VALUES ($1, $2, $3, '子组织管理员', FALSE)`,
      [roleId, `org_admin_${org.code}`, org.id],
    );
    await query(
      `INSERT INTO role_permissions (role_id, permission_id)
       SELECT $1, permission_id FROM role_permissions WHERE role_id = $2`,
      [roleId, roleByCode["role_org_admin"]],
    );
    await query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`,
      [user.id, roleId],
    );
  }

  await query(
    `INSERT INTO user_roles (user_id, role_id)
     SELECT 'u_admin', id FROM roles WHERE name = 'role_super_admin'`,
  );

  // 5. 插入 Skill 包 + 版本
  console.log("5. Insert skill packages + versions (6 packages)...");
  for (const sk of SKILLS) {
    const author = USERS.find(u => u.username === sk.author_username)!;
    const org = sk.org_code ? ORGS.find(o => o.code === sk.org_code) : null;
    const pkgId = sk.id;
    const versionId = `${sk.id}_v1`;

    await query(
      `INSERT INTO skill_packages (id, name, slug, display_name, description, org_id, author_id,
         scope, category, tags, icon, stats, trust_level, active_version_id, is_kill_switched)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
         '{"downloads":0,"subscriptions":0,"rating_avg":0}', $12, $13, FALSE)`,
      [pkgId, sk.name, sk.slug, sk.display_name, sk.description,
       org?.id ?? null, author.id, sk.scope, sk.category, JSON.stringify(sk.tags),
       sk.icon, sk.trust_level, versionId],
    );

    // Use Node.js crypto for content_hash instead of pgcrypto digest()
    const contentHash = createHash("sha256").update(sk.content).digest("hex");

    await query(
      `INSERT INTO skill_versions (id, package_id, version, content, when_to_use, paths,
         allowed_tools, data_classification, hooks, test_cases, content_hash, status,
         change_summary, created_by, published_at)
       VALUES ($1, $2, $3, $4, NULL, '[]', '[]', 'public', '{}', '[]',
         $5, 'published', $6, $7, NOW())`,
      [versionId, pkgId, sk.version, sk.content, contentHash, sk.change_summary, author.id],
    );

    await query(
      `INSERT INTO skill_subscriptions (id, package_id, subscriber_type, subscriber_id, source)
       VALUES ($1, $2, 'user', $3, 'market')`,
      [randomUUID(), pkgId, author.id],
    );
  }

  // 6. 创建 1 个共享记录 (INFRA → SOL)
  console.log("6. Insert cross-org sharing (INFRA → SOL)...");
  const costOptPkg = SKILLS.find(s => s.slug === "infra-cost-opt")!;
  const solOrg = ORGS.find(o => o.code === "SOL")!;
  const infraOrg = ORGS.find(o => o.code === "INFRA")!;
  const adminUser = USERS.find(u => u.username === "admin")!;
  await query(
    `INSERT INTO skill_sharings (id, package_id, source_org_id, target_org_id, status,
       initiated_by, approved_by, restrictions, created_at, approved_at, usage_intent, business_justification)
     VALUES ($1, $2, $3, $4, 'approved', $5, $5,
       '{"max_users": 20}', NOW(), NOW(),
       'SOL 团队需要成本优化指导方案', '新客户项目交付中频繁涉及云成本优化')`,
    [randomUUID(), costOptPkg.id, infraOrg.id, solOrg.id, adminUser.id],
  );

  console.log("\n✅ Seed complete!");
  console.log(`   Organizations: ${ORGS.length}`);
  console.log(`   Users: ${USERS.length}`);
  console.log(`   Skills: ${SKILLS.length}`);
  console.log(`   Sharings: 1`);
}

seed()
  .then(() => { console.log("\n🎉 All done!"); return closePool(); })
  .then(() => process.exit(0))
  .catch((err) => { console.error("❌ Seed failed:", err); process.exit(1); });
