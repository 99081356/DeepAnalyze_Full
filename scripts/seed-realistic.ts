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
  {
    id: "sk_contract_review", name: "contract-review-assistant", slug: "contract-review",
    display_name: "合同审查助手",
    description: "智能合同审查：自动识别风险条款、违约金计算、知识产权归属、保密期限等关键条款。支持中英文合同，输出结构化审查报告。",
    scope: "org", org_code: "SEC", author_username: "zhao.ruihua",
    category: "business", tags: ["法务", "合同", "风险审查"], icon: "📋",
    trust_level: "verified", version: "2.3.1",
    content: "## 合同审查助手\n\n### 审查流程\n\n1. **结构解析**：识别合同主体、标的、金额、期限\n2. **风险扫描**：违约金过高、知识产权模糊、保密条款缺失\n3. **合规校验**：对照《合同法》及公司合规手册\n4. **报告输出**：风险等级 + 修改建议\n\n### 关键检查项\n\n- 违约金是否超过标的额 30%\n- 知识产权归属是否明确\n- 保密期限是否合理（通常 3-5 年）\n- 争议解决方式（仲裁 vs 诉讼）\n- 不可抗力条款覆盖范围",
    change_summary: "v2.3：增加英文合同支持，优化知识产权条款识别",
  },
  {
    id: "sk_code_review", name: "code-review-expert", slug: "code-review-expert",
    display_name: "代码 Review 专家",
    description: "深度代码审查：安全漏洞、性能瓶颈、架构设计、代码规范。支持 12 种主流语言，输出可操作的修改建议。",
    scope: "org", org_code: "AGENT", author_username: "wang.siyuan",
    category: "engineering", tags: ["代码审查", "安全", "性能"], icon: "🔍",
    trust_level: "verified", version: "3.5.0",
    content: "## 代码 Review 专家\n\n### 审查维度\n\n1. **安全**：SQL 注入、XSS、CSRF、越权访问、敏感信息泄露\n2. **性能**：N+1 查询、内存泄漏、死锁风险、算法复杂度\n3. **架构**：分层是否清晰、耦合度、扩展性、SOLID 原则\n4. **规范**：命名、注释、错误处理、日志完整性\n\n### 输出格式\n\n- 严重问题（必须修复）：🔴\n- 建议修改（推荐）：🟡\n- 优化建议（可选）：🟢\n\n每个问题附带：代码位置、问题描述、修复建议、修复代码片段",
    change_summary: "v3.5：新增 Rust 和 Go 支持，强化安全漏洞检测",
  },
  {
    id: "sk_paper_analysis", name: "paper-deep-analysis", slug: "paper-analysis",
    display_name: "论文深度分析",
    description: "学术论文深度阅读助手：自动提取研究方法、实验设计、数据集、核心结论。支持跨论文对比和引用网络分析。",
    scope: "system", org_code: null, author_username: "chen.yifan",
    category: "general", tags: ["学术", "论文", "研究方法"], icon: "📄",
    trust_level: "official", version: "1.8.0",
    content: "## 论文深度分析\n\n### 分析框架\n\n1. **元数据提取**：标题、作者、机构、发表 venue、引用数\n2. **问题定义**：研究什么问题、为什么重要\n3. **方法分析**：核心创新点、技术路线、与已有工作的区别\n4. **实验评估**：数据集、baseline、评价指标、消融实验\n5. **结论与局限**：核心贡献、适用边界、未来方向\n\n### 跨论文分析\n\n- 方法对比表：自动生成多论文的方法对比矩阵\n- 引用网络：构建引用关系图，识别关键论文\n- 时间线：研究领域的发展脉络",
    change_summary: "v1.8：增加跨论文对比和引用网络分析",
  },
  {
    id: "sk_security_scan", name: "security-vulnerability-scan", slug: "security-scan",
    display_name: "安全漏洞扫描",
    description: "全面安全扫描：依赖漏洞、代码注入、配置风险、密钥泄露。集成 CVE 数据库和 OWASP Top 10。",
    scope: "org", org_code: "AGENT", author_username: "liu.tianyu",
    category: "security", tags: ["安全", "漏洞", "CVE"], icon: "🛡️",
    trust_level: "verified", version: "2.0.0",
    content: "## 安全漏洞扫描\n\n### 扫描范围\n\n1. **依赖漏洞**：NPM/PyPI/Maven 包的已知 CVE\n2. **代码注入**：SQL/Command/XSS/Template 注入\n3. **配置风险**：Debug 模式、默认密钥、开放端口\n4. **密钥泄露**：API Key、Token、私钥硬编码\n\n### OWASP Top 10 覆盖\n\n- A01 失效的访问控制\n- A02 加密失败\n- A03 注入\n- A04 不安全设计\n- A05 安全配置错误\n- A06 易受攻击的组件\n- A07 身份验证失败\n- A08 软件和数据完整性故障\n- A09 日志和监控不足\n- A10 服务端请求伪造",
    change_summary: "v2.0：全面覆盖 OWASP Top 10 2021",
  },
  {
    id: "sk_market_research", name: "market-research-report", slug: "market-research",
    display_name: "市场调研报告",
    description: "自动化市场调研：行业规模、竞争格局、趋势分析、投资机会。整合公开数据和新闻情报。",
    scope: "org", org_code: "SOL", author_username: "zhou.minglang",
    category: "business", tags: ["市场", "调研", "竞品分析"], icon: "📊",
    trust_level: "verified", version: "1.4.0",
    content: "## 市场调研报告\n\n### 报告结构\n\n1. **行业概览**：市场规模、增长率、产业链\n2. **竞争格局**：头部玩家、市场份额、差异化定位\n3. **趋势分析**：技术趋势、政策影响、消费者行为变化\n4. **投资机会**：细分赛道、进入壁垒、ROI 测算\n\n### 数据来源\n\n- 行业协会公开报告\n- 上市公司财报\n- 新闻和社交媒体情报\n- 专利和论文数据库",
    change_summary: "v1.4：增加社交媒体情报数据源",
  },
  {
    id: "sk_test_case_gen", name: "test-case-generator", slug: "test-case-gen",
    display_name: "测试用例生成",
    description: "基于需求和代码自动生成测试用例：单元测试、集成测试、边界用例、异常路径。支持 Jest/PyTest/JUnit。",
    scope: "org", org_code: "AGENT", author_username: "liu.tianyu",
    category: "engineering", tags: ["测试", "自动化", "覆盖率"], icon: "🧪",
    trust_level: "community", version: "1.6.0",
    content: "## 测试用例生成\n\n### 用例类型\n\n1. **正常路径**：标准输入 → 预期输出\n2. **边界值**：空、零、最大值、最小值\n3. **异常路径**：非法输入、网络超时、权限不足\n4. **并发场景**：竞态条件、死锁\n\n### 覆盖率目标\n\n- 语句覆盖 > 80%\n- 分支覆盖 > 70%\n- 关键路径 100%",
    change_summary: "v1.6：增加并发测试场景支持",
  },
];

// ── Worker 节点 ──
interface WorkerDef {
  id: string; name: string; hostname: string; endpoint: string;
  status: string; org_code: string; user_username: string;
  version: string; capabilities: Record<string, unknown>;
}

const WORKERS: WorkerDef[] = [
  { id: "wk_prod_01", name: "生产节点-01", hostname: "prod-da-01.dsi.local", endpoint: "http://10.0.1.10:21000", status: "online", org_code: "AGENT", user_username: "wang.siyuan", version: "0.7.6", capabilities: { gpu: false, maxMemory: "32GB", skills: 18, maxConcurrency: 10 } },
  { id: "wk_prod_02", name: "生产节点-02", hostname: "prod-da-02.dsi.local", endpoint: "http://10.0.1.11:21000", status: "online", org_code: "KB", user_username: "chen.yifan", version: "0.7.6", capabilities: { gpu: true, maxMemory: "64GB", skills: 22, maxConcurrency: 15 } },
  { id: "wk_legal_01", name: "法务节点-01", hostname: "legal-da-01.dsi.local", endpoint: "http://10.0.2.10:21000", status: "online", org_code: "SEC", user_username: "zhao.ruihua", version: "0.7.6", capabilities: { gpu: false, maxMemory: "16GB", skills: 12, maxConcurrency: 5 } },
  { id: "wk_dev_01", name: "开发节点-01", hostname: "dev-da-01.dsi.local", endpoint: "http://10.0.3.10:21000", status: "offline", org_code: "AGENT", user_username: "liu.tianyu", version: "0.7.7-beta", capabilities: { gpu: false, maxMemory: "16GB", skills: 8, maxConcurrency: 3 } },
  { id: "wk_pending_01", name: "新接入节点", hostname: "new-da-01.dsi.local", endpoint: "http://10.0.4.10:21000", status: "pending", org_code: "SOL", user_username: "zhou.minglang", version: "0.7.6", capabilities: { gpu: false, maxMemory: "8GB", skills: 5, maxConcurrency: 2 } },
];

// ── 跨组织共享 ──
interface SharingDef {
  package_slug: string; source_org_code: string; target_org_code: string;
  status: "pending" | "approved" | "rejected" | "revoked";
  initiated_by: string; usage_intent: string; business_justification: string;
}

const SHARINGS: SharingDef[] = [
  { package_slug: "infra-cost-opt", source_org_code: "INFRA", target_org_code: "SOL", status: "approved", initiated_by: "lin.yuqing", usage_intent: "解决方案团队向客户输出成本优化方案", business_justification: "新客户项目交付中频繁涉及云成本优化咨询" },
  { package_slug: "contract-review", source_org_code: "SEC", target_org_code: "SOL", status: "approved", initiated_by: "zhao.ruihua", usage_intent: "客户合同审查标准化", business_justification: "解决方案部需要法务支持审查客户合同" },
  { package_slug: "code-review-expert", source_org_code: "AGENT", target_org_code: "KB", status: "pending", initiated_by: "wang.siyuan", usage_intent: "知识库团队提升代码质量", business_justification: "KB 团队正在重构知识库引擎，需要深度代码审查" },
  { package_slug: "security-scan", source_org_code: "AGENT", target_org_code: "SEC", status: "rejected", initiated_by: "wang.siyuan", usage_intent: "安全合规部扫描代码", business_justification: "安全部已有专用扫描工具，重复引入" },
  { package_slug: "market-research", source_org_code: "SOL", target_org_code: "SEC", status: "revoked", initiated_by: "zhou.minglang", usage_intent: "安全部市场情报收集", business_justification: "试用期内使用频次过低，自动撤销" },
];

// ── Marketplace Skills（Worker 技能市场）──
interface MarketSkillDef {
  slug: string; name: string; description: string; prompt: string;
  tools: string[]; tags: string[]; version: string;
  author_username: string; category: string;
  review_status: "pending" | "approved" | "rejected" | "deprecated";
  download_count: number; rating_avg: number; review_count: number;
  anti_hallucination_level: string;
}

const MARKET_SKILLS: MarketSkillDef[] = [
  {
    slug: "quick-summary", name: "一键摘要", description: "快速生成长文档的摘要，支持 PDF/Word/网页。100 页文档 30 秒出摘要。",
    prompt: "请阅读以下文档，生成 300 字以内的摘要，包含：核心观点（3 条）、关键数据、结论建议。",
    tools: ["read_file", "web_fetch"], tags: ["摘要", "文档", "效率"], version: "1.2.0",
    author_username: "chen.yifan", category: "productivity",
    review_status: "approved", download_count: 342, rating_avg: 4.7, review_count: 28,
    anti_hallucination_level: "strict",
  },
  {
    slug: "meeting-notes", name: "会议纪要助手", description: "从会议录音/文字记录生成结构化纪要：决议、待办、责任人、截止日期。",
    prompt: "请从以下会议记录中提取：1.讨论议题 2.决议事项 3.待办任务（含责任人、截止日期）4.遗留问题。输出 Markdown 表格。",
    tools: ["read_file", "structured_output"], tags: ["会议", "纪要", "待办"], version: "2.0.0",
    author_username: "sun.jiayi", category: "productivity",
    review_status: "approved", download_count: 218, rating_avg: 4.5, review_count: 19,
    anti_hallucination_level: "normal",
  },
  {
    slug: "data-cleaner", name: "数据清洗专家", description: "自动识别并清洗脏数据：缺失值、异常值、重复行、格式不一致。",
    prompt: "请分析提供的数据集，识别：1.缺失值及处理建议 2.异常值（3σ原则）3.重复行 4.格式问题。输出清洗后的 CSV 和清洗报告。",
    tools: ["run_sql", "bash"], tags: ["数据", "清洗", "ETL"], version: "1.5.0",
    author_username: "lin.yuqing", category: "engineering",
    review_status: "approved", download_count: 156, rating_avg: 4.3, review_count: 12,
    anti_hallucination_level: "strict",
  },
  {
    slug: "email-drafter", name: "邮件起草助手", description: "根据要点生成专业邮件：商务沟通、客户回复、内部通知。支持语气调节。",
    prompt: "请根据以下要点起草一封专业邮件。要求：1.主题明确 2.开头礼貌 3.要点清晰 4.行动号召 5.专业落款。语气：{formal|friendly|urgent}。",
    tools: [], tags: ["邮件", "沟通", "写作"], version: "1.0.0",
    author_username: "zheng.xinyi", category: "writing",
    review_status: "approved", download_count: 98, rating_avg: 4.1, review_count: 7,
    anti_hallucination_level: "normal",
  },
  {
    slug: "api-doc-gen", name: "API 文档生成器", description: "从代码注释自动生成 OpenAPI 文档，支持 Swagger UI 渲染。",
    prompt: "请分析提供的 API 代码，生成 OpenAPI 3.0 规范文档。包含：端点、参数、响应体、示例、错误码。",
    tools: ["read_file", "grep", "glob"], tags: ["API", "文档", "Swagger"], version: "1.3.0",
    author_username: "liu.tianyu", category: "engineering",
    review_status: "pending", download_count: 0, rating_avg: 0, review_count: 0,
    anti_hallucination_level: "strict",
  },
  {
    slug: "competitor-watch", name: "竞品监控", description: "定期监控竞品官网、产品更新、融资动态，生成周报。",
    prompt: "请搜索以下竞品的最新动态：产品更新、融资、招聘、专利。整理为周报格式，附来源链接。",
    tools: ["web_search", "web_fetch"], tags: ["竞品", "监控", "情报"], version: "0.9.0",
    author_username: "zhou.minglang", category: "business",
    review_status: "pending", download_count: 0, rating_avg: 0, review_count: 0,
    anti_hallucination_level: "strict",
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

  // 6. 创建多个共享记录
  console.log("6. Insert cross-org sharings (5 records)...");
  for (const sh of SHARINGS) {
    const pkg = SKILLS.find(s => s.slug === sh.package_slug)!;
    const sourceOrg = ORGS.find(o => o.code === sh.source_org_code)!;
    const targetOrg = ORGS.find(o => o.code === sh.target_org_code)!;
    const initiator = USERS.find(u => u.username === sh.initiated_by)!;
    const adminUser = USERS.find(u => u.username === "admin")!;

    const approvedBy = sh.status === "approved" ? adminUser.id : null;
    const approvedAt = sh.status === "approved" ? "NOW()" : "NULL";
    const revokedAt = sh.status === "revoked" ? "NOW()" : "NULL";
    const revokedBy = sh.status === "revoked" ? adminUser.id : null;

    await query(
      `INSERT INTO skill_sharings (id, package_id, source_org_id, target_org_id, status,
         initiated_by, approved_by, restrictions, created_at, approved_at, revoked_at, revoked_by,
         usage_intent, business_justification)
       VALUES ($1, $2, $3, $4, $5, $6, $7,
         '{"max_users": 20, "allow_redistribute": false}',
         NOW() - ($8 || ' days')::interval,
         ${approvedAt}, ${revokedAt}, $9,
         $10, $11)`,
      [randomUUID(), pkg.id, sourceOrg.id, targetOrg.id, sh.status,
       initiator.id, approvedBy, String(Math.floor(Math.random() * 14) + 1),
       revokedBy, sh.usage_intent, sh.business_justification],
    );
  }

  // 7. 插入 Worker 节点
  console.log("7. Insert workers (5 nodes)...");
  for (const w of WORKERS) {
    const org = ORGS.find(o => o.code === w.org_code)!;
    const user = USERS.find(u => u.username === w.user_username)!;
    const token = `wk_${randomUUID().replace(/-/g, "")}`;
    const adminUser = USERS.find(u => u.username === "admin")!;
    const isApproved = w.status === "online" || w.status === "offline";
    const regDaysAgo = Math.floor(Math.random() * 80) + 10;
    const approvedDaysAgo = Math.floor(Math.random() * 60) + 5;
    const hbMinAgo = Math.floor(Math.random() * 5);
    const hbInterval = w.status === "online" ? `${hbMinAgo} minutes` : null;
    const approvedInterval = isApproved ? `${approvedDaysAgo} days` : null;

    await query(
      `INSERT INTO workers (id, name, display_name, hostname, endpoint, version, capabilities,
         status, worker_token, last_heartbeat, active_sessions, active_tasks, resource_usage,
         registered_at, approved_at, approved_by, user_id, organization_id, protocol_version, applied_at)
       VALUES ($1, $2, $2, $3, $4, $5, $6,
         $7, $8,
         CASE WHEN $9::text IS NOT NULL THEN NOW() - ($9 || ' minutes')::interval ELSE NULL END,
         $10, $11, $12,
         NOW() - ($13 || ' days')::interval,
         CASE WHEN $14::text IS NOT NULL THEN NOW() - ($14 || ' days')::interval ELSE NULL END,
         $15, $16, $17, 1, NOW() - ($18 || ' days')::interval)`,
      [
        w.id, w.name, w.hostname, w.endpoint, w.version, JSON.stringify(w.capabilities),
        w.status, token,
        hbInterval ? String(hbMinAgo) : null,
        Math.floor(Math.random() * 5), Math.floor(Math.random() * 3),
        JSON.stringify({ cpu: Math.floor(Math.random() * 40) + 10, memory: Math.floor(Math.random() * 50) + 20 }),
        String(regDaysAgo),
        isApproved ? String(approvedDaysAgo) : null,
        isApproved ? adminUser.id : null,
        user.id,
        org.id,
        String(regDaysAgo + 2),
      ],
    );
  }

  // 8. 插入 Marketplace Skills (Worker 技能市场)
  console.log("8. Insert marketplace skills (6 entries)...");
  for (const ms of MARKET_SKILLS) {
    const author = USERS.find(u => u.username === ms.author_username)!;
    const reviewer = ms.review_status !== "pending" ? USERS.find(u => u.username === "admin")!.id : null;
    const reviewedAt = ms.review_status !== "pending" ? "NOW() - (RANDOM() * 30 || ' days')::interval" : "NULL";

    await query(
      `INSERT INTO marketplace_skills (id, slug, name, description, prompt, tools, model_role,
         anti_hallucination_level, tags, version, author_id, submitter_id, download_count,
         rating_avg, review_count, review_status, reviewer_id, published_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'main',
         $7, $8, $9, $10, $10, $11,
         $12, $13, $14, $15,
         ${ms.review_status === "approved" ? "NOW() - (RANDOM() * 60 || ' days')::interval" : "NULL"},
         NOW() - (RANDOM() * 90 || ' days')::interval,
         NOW() - (RANDOM() * 7 || ' days')::interval)`,
      [
        randomUUID(), ms.slug, ms.name, ms.description, ms.prompt, ms.tools,
        ms.anti_hallucination_level, ms.tags, ms.version, author.id,
        ms.download_count, ms.rating_avg, ms.review_count, ms.review_status, reviewer,
      ],
    );
  }

  // 9. 批量插入 skill subscriptions（让 Skill 看起来有真实分发量）
  console.log("9. Insert skill subscriptions...");
  for (const sk of SKILLS) {
    // 每个 skill 被 2-5 个用户订阅
    const subscriberCount = Math.floor(Math.random() * 4) + 2;
    const pool = USERS.filter(u => !u.is_super_admin);
    const shuffled = pool.sort(() => Math.random() - 0.5).slice(0, subscriberCount);
    for (const sub of shuffled) {
      await query(
        `INSERT INTO skill_subscriptions (id, package_id, subscriber_type, subscriber_id, source, is_forced)
         VALUES ($1, $2, 'user', $3, $4, $5)
         ON CONFLICT (package_id, subscriber_type, subscriber_id) DO NOTHING`,
        [randomUUID(), sk.id, sub.id, Math.random() > 0.5 ? "market" : "admin", Math.random() > 0.7],
      );
    }
  }

  // 10. 插入 usage logs
  console.log("10. Insert skill usage logs (30 entries)...");
  const usageStatuses = ["success", "success", "success", "success", "failure", "timeout"];
  for (let i = 0; i < 30; i++) {
    const sk = SKILLS[Math.floor(Math.random() * SKILLS.length)];
    const wk = WORKERS[Math.floor(Math.random() * WORKERS.length)];
    const user = USERS[Math.floor(Math.random() * USERS.length)];
    const status = usageStatuses[Math.floor(Math.random() * usageStatuses.length)];
    await query(
      `INSERT INTO skill_usage_logs (package_id, version_id, worker_id, user_id, executor_type,
         status, duration_ms, session_id, details, created_at)
       VALUES ($1, $2, $3, $4, 'main_agent', $5, $6, $7, $8,
         NOW() - (RANDOM() * 7 || ' days')::interval)`,
      [
        sk.id, `${sk.id}_v1`, wk.id, user.id, status,
        Math.floor(Math.random() * 30000) + 1000,
        randomUUID(),
        JSON.stringify({ input_length: Math.floor(Math.random() * 5000), output_length: Math.floor(Math.random() * 8000) }),
      ],
    );
  }

  // 11. 插入 audit logs
  console.log("11. Insert audit logs (15 entries)...");
  const auditActions = [
    { action: "user.login", target_type: "user", details: { method: "password" } },
    { action: "skill.publish", target_type: "skill_package", details: { version: "1.0.0" } },
    { action: "worker.approve", target_type: "worker", details: {} },
    { action: "sharing.approve", target_type: "skill_sharing", details: {} },
    { action: "skill.kill_switch", target_type: "skill_package", details: { reason: "security review" } },
    { action: "user.create", target_type: "user", details: {} },
    { action: "org.update", target_type: "organization", details: { field: "settings" } },
  ];
  for (let i = 0; i < 15; i++) {
    const act = auditActions[Math.floor(Math.random() * auditActions.length)];
    const user = USERS[Math.floor(Math.random() * USERS.length)];
    const target = WORKERS[Math.floor(Math.random() * WORKERS.length)];
    await query(
      `INSERT INTO audit_log (user_id, action, target_type, target_id, details, ip_address, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW() - (RANDOM() * 30 || ' days')::interval)`,
      [
        user.id, act.action, act.target_type, target.id,
        JSON.stringify(act.details),
        `10.0.${Math.floor(Math.random() * 5)}.${Math.floor(Math.random() * 250) + 1}`,
      ],
    );
  }

  console.log("\n✅ Seed complete!");
  console.log(`   Organizations: ${ORGS.length}`);
  console.log(`   Users: ${USERS.length}`);
  console.log(`   Skills (enterprise): ${SKILLS.length}`);
  console.log(`   Workers: ${WORKERS.length}`);
  console.log(`   Sharings: ${SHARINGS.length}`);
  console.log(`   Marketplace Skills: ${MARKET_SKILLS.length}`);
  console.log(`   Usage Logs: 30`);
  console.log(`   Audit Logs: 15`);
}

seed()
  .then(() => { console.log("\n🎉 All done!"); return closePool(); })
  .then(() => process.exit(0))
  .catch((err) => { console.error("❌ Seed failed:", err); process.exit(1); });
