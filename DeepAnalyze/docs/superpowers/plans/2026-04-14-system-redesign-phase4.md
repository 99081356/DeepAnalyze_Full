# Phase 4 (P3): 模块D — 多Agent系统（AgentTeams集成）

> 返回 [索引](./2026-04-14-system-redesign.md) | 上一步 [Phase 3](./2026-04-14-system-redesign-phase3.md)

---

## Task 13: Agent团队数据持久化

**文件：** 创建 `src/store/agent-teams.ts`

**步骤：**

- [ ] 13.1 创建 `src/store/agent-teams.ts` — 团队SQLite持久化

```typescript
import { randomUUID } from "crypto";
import { DB } from "./database.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentTeam {
  id: string;
  name: string;
  description: string;
  mode: "pipeline" | "graph" | "council" | "parallel";
  isActive: boolean;
  crossReview: boolean;
  enableSkills: boolean;
  modelConfig?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AgentTeamMember {
  id: string;
  teamId: string;
  role: string;
  systemPrompt?: string;
  task: string;
  perspective?: string;
  dependsOn: string[];
  condition?: { type: "output_contains" | "output_not_contains"; node: string; text: string };
  tools: string[];
  sortOrder: number;
}

// ---------------------------------------------------------------------------
// Schema Migration
// ---------------------------------------------------------------------------

let migrated = false;

export function migrateAgentTeams(): void {
  if (migrated) return;
  migrated = true;

  const db = DB.getInstance().raw;
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_teams (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('pipeline', 'graph', 'council', 'parallel')),
      is_active INTEGER NOT NULL DEFAULT 1,
      cross_review INTEGER NOT NULL DEFAULT 0,
      enable_skills INTEGER NOT NULL DEFAULT 0,
      model_config TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS agent_team_members (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      role TEXT NOT NULL,
      system_prompt TEXT,
      task TEXT NOT NULL,
      perspective TEXT,
      depends_on TEXT,
      condition_config TEXT,
      tools TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (team_id) REFERENCES agent_teams(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_team_members_team ON agent_team_members(team_id);
  `);
}

function getDb() {
  migrateAgentTeams();
  return DB.getInstance().raw;
}

// ---------------------------------------------------------------------------
// Team CRUD
// ---------------------------------------------------------------------------

export function createTeam(data: {
  name: string;
  description: string;
  mode: AgentTeam["mode"];
  crossReview?: boolean;
  enableSkills?: boolean;
  modelConfig?: Record<string, unknown>;
  members: Array<Omit<AgentTeamMember, "id" | "teamId" | "sortOrder">>;
}): AgentTeam {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO agent_teams (id, name, description, mode, cross_review, enable_skills, model_config, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, data.name, data.description, data.mode,
    data.crossReview ? 1 : 0,
    data.enableSkills ? 1 : 0,
    data.modelConfig ? JSON.stringify(data.modelConfig) : null,
    now, now
  );

  const memberStmt = db.prepare(`
    INSERT INTO agent_team_members (id, team_id, role, system_prompt, task, perspective, depends_on, condition_config, tools, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (let i = 0; i < data.members.length; i++) {
    const m = data.members[i];
    memberStmt.run(
      randomUUID(), id, m.role, m.systemPrompt || null, m.task,
      m.perspective || null,
      JSON.stringify(m.dependsOn || []),
      m.condition ? JSON.stringify(m.condition) : null,
      JSON.stringify(m.tools),
      i
    );
  }

  return { id, name: data.name, description: data.description, mode: data.mode,
    isActive: true, crossReview: !!data.crossReview, enableSkills: !!data.enableSkills,
    modelConfig: data.modelConfig, createdAt: now, updatedAt: now };
}

export function getTeam(teamId: string): (AgentTeam & { members: AgentTeamMember[] }) | null {
  const db = getDb();
  const team = db.prepare("SELECT * FROM agent_teams WHERE id = ?").get(teamId) as any;
  if (!team) return null;

  const memberRows = db.prepare("SELECT * FROM agent_team_members WHERE team_id = ? ORDER BY sort_order").all(teamId) as any[];

  return {
    id: team.id, name: team.name, description: team.description, mode: team.mode,
    isActive: !!team.is_active, crossReview: !!team.cross_review, enableSkills: !!team.enable_skills,
    modelConfig: team.model_config ? JSON.parse(team.model_config) : undefined,
    createdAt: team.created_at, updatedAt: team.updated_at,
    members: memberRows.map(m => ({
      id: m.id, teamId: m.team_id, role: m.role, systemPrompt: m.system_prompt,
      task: m.task, perspective: m.perspective,
      dependsOn: JSON.parse(m.depends_on || "[]"),
      condition: m.condition_config ? JSON.parse(m.condition_config) : undefined,
      tools: JSON.parse(m.tools), sortOrder: m.sort_order,
    })),
  };
}

export function getTeamByName(name: string): (AgentTeam & { members: AgentTeamMember[] }) | null {
  const db = getDb();
  const team = db.prepare("SELECT * FROM agent_teams WHERE name = ?").get(name) as any;
  if (!team) return null;
  return getTeam(team.id);
}

export function listTeams(): AgentTeam[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM agent_teams ORDER BY created_at DESC").all() as any[];
  return rows.map(t => ({
    id: t.id, name: t.name, description: t.description, mode: t.mode,
    isActive: !!t.is_active, crossReview: !!t.cross_review, enableSkills: !!t.enable_skills,
    modelConfig: t.model_config ? JSON.parse(t.model_config) : undefined,
    createdAt: t.created_at, updatedAt: t.updated_at,
  }));
}

export function updateTeam(teamId: string, data: Partial<{
  name: string; description: string; mode: AgentTeam["mode"];
  isActive: boolean; crossReview: boolean; enableSkills: boolean;
  modelConfig: Record<string, unknown>;
}>): boolean {
  const db = getDb();
  const sets: string[] = [];
  const vals: any[] = [];

  if (data.name !== undefined) { sets.push("name = ?"); vals.push(data.name); }
  if (data.description !== undefined) { sets.push("description = ?"); vals.push(data.description); }
  if (data.mode !== undefined) { sets.push("mode = ?"); vals.push(data.mode); }
  if (data.isActive !== undefined) { sets.push("is_active = ?"); vals.push(data.isActive ? 1 : 0); }
  if (data.crossReview !== undefined) { sets.push("cross_review = ?"); vals.push(data.crossReview ? 1 : 0); }
  if (data.enableSkills !== undefined) { sets.push("enable_skills = ?"); vals.push(data.enableSkills ? 1 : 0); }
  if (data.modelConfig !== undefined) { sets.push("model_config = ?"); vals.push(JSON.stringify(data.modelConfig)); }

  if (sets.length === 0) return false;
  sets.push("updated_at = ?");
  vals.push(new Date().toISOString());
  vals.push(teamId);

  const result = db.prepare(`UPDATE agent_teams SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  return result.changes > 0;
}

export function deleteTeam(teamId: string): boolean {
  const db = getDb();
  db.prepare("DELETE FROM agent_team_members WHERE team_id = ?").run(teamId);
  const result = db.prepare("DELETE FROM agent_teams WHERE id = ?").run(teamId);
  return result.changes > 0;
}
```

- [ ] 13.2 在 `src/server/app.ts` 中调用迁移

```typescript
import { migrateAgentTeams } from "../store/agent-teams.js";
// 在 createApp() 中添加:
migrateAgentTeams();
```

- [ ] 13.3 提交

```bash
git add src/store/agent-teams.ts src/server/app.ts && git commit -m "feat(teams): add agent team persistence with SQLite schema"
```

---

## Task 14: WorkflowEngine核心

**文件：** 创建 `src/services/agent/workflow-engine.ts`

**步骤：**

- [ ] 14.1 创建 `src/services/agent/workflow-engine.ts`

```typescript
// =============================================================================
// WorkflowEngine — 支持4种调度模式的多Agent工作流引擎
// Pipeline / Graph(DAG) / Council / Parallel
// =============================================================================

import type { AgentRunner } from "./agent-runner.js";
import type { ToolRegistry } from "./tool-registry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WorkflowMode = "pipeline" | "graph" | "council" | "parallel";

export interface WorkflowAgent {
  id: string;
  role: string;
  systemPrompt?: string;
  task: string;
  perspective?: string;
  dependsOn?: string[];
  condition?: { type: "output_contains" | "output_not_contains"; node: string; text: string };
  tools: string[];
}

export interface WorkflowInput {
  workflowId: string;
  teamName: string;
  mode: WorkflowMode;
  goal: string;
  agents: WorkflowAgent[];
  crossReview?: boolean;
}

export interface AgentResult {
  agentId: string;
  role: string;
  status: "completed" | "failed" | "skipped";
  output: string;
  duration: number;
  error?: string;
}

export interface WorkflowResult {
  workflowId: string;
  status: "completed" | "partial" | "failed";
  agentResults: AgentResult[];
  synthesis: string;
  totalDuration: number;
}

export type WorkflowEvent = {
  type: "workflow_start" | "workflow_complete";
  workflowId: string;
  [key: string]: unknown;
} | {
  type: "workflow_agent_start" | "workflow_agent_complete" | "workflow_agent_chunk" | "workflow_agent_tool_call" | "workflow_agent_tool_result";
  workflowId: string;
  agentId: string;
  [key: string]: unknown;
};

type EventCallback = (event: WorkflowEvent) => void;

// ---------------------------------------------------------------------------
// WorkflowEngine
// ---------------------------------------------------------------------------

export class WorkflowEngine {
  private input: WorkflowInput;
  private runner: AgentRunner;
  private toolRegistry: ToolRegistry;
  private onEvent: EventCallback;
  private nodeOutputs = new Map<string, AgentResult>();

  constructor(
    input: WorkflowInput,
    runner: AgentRunner,
    toolRegistry: ToolRegistry,
    onEvent: EventCallback,
  ) {
    this.input = input;
    this.runner = runner;
    this.toolRegistry = toolRegistry;
    this.onEvent = onEvent;
  }

  async execute(): Promise<WorkflowResult> {
    const startTime = Date.now();
    this.emit({ type: "workflow_start", workflowId: this.input.workflowId,
      teamName: this.input.teamName, mode: this.input.mode, agentCount: this.input.agents.length });

    let agentResults: AgentResult[];
    switch (this.input.mode) {
      case "pipeline":
        agentResults = await this.executePipeline();
        break;
      case "graph":
        agentResults = await this.executeGraph();
        break;
      case "council":
        agentResults = await this.executeCouncil();
        break;
      case "parallel":
        agentResults = await this.executeParallel();
        break;
      default:
        throw new Error(`Unknown workflow mode: ${this.input.mode}`);
    }

    const totalDuration = Date.now() - startTime;
    const failedCount = agentResults.filter(r => r.status === "failed").length;
    const status = failedCount === 0 ? "completed" : failedCount === agentResults.length ? "failed" : "partial";

    this.emit({ type: "workflow_complete", workflowId: this.input.workflowId,
      status, totalDuration, resultCount: agentResults.length });

    return {
      workflowId: this.input.workflowId,
      status,
      agentResults,
      synthesis: this.synthesizeResults(agentResults),
      totalDuration,
    };
  }

  // -------------------------------------------------------------------------
  // Pipeline模式：顺序执行，累积上下文
  // -------------------------------------------------------------------------

  private async executePipeline(): Promise<AgentResult[]> {
    const results: AgentResult[] = [];
    let accumulatedContext = this.input.goal;

    for (const agent of this.input.agents) {
      const result = await this.runAgent(agent, accumulatedContext);
      results.push(result);
      if (result.status === "completed") {
        accumulatedContext += `\n\n--- ${agent.role} Output ---\n${result.output}`;
      } else {
        break; // Pipeline中一旦失败就停止
      }
    }
    return results;
  }

  // -------------------------------------------------------------------------
  // Graph(DAG)模式：依赖调度，自动并行
  // -------------------------------------------------------------------------

  private async executeGraph(): Promise<AgentResult[]> {
    // 环检测
    const cycle = this.detectCycle(this.input.agents);
    if (cycle) throw new Error(`Cycle detected in workflow graph: ${cycle.join(" -> ")}`);

    const results: AgentResult[] = [];
    const completed = new Set<string>();

    while (completed.size < this.input.agents.length) {
      // 找出所有就绪节点（依赖已完成且条件满足）
      const ready = this.input.agents.filter((agent) => {
        if (completed.has(agent.id)) return false;
        const deps = agent.dependsOn || [];
        const depsComplete = deps.every(d => completed.has(d));
        if (!depsComplete) return false;
        // 检查条件
        if (agent.condition) {
          return this.evaluateCondition(agent.condition);
        }
        return true;
      });

      if (ready.length === 0) {
        // 剩余节点永远无法满足依赖（上游失败），标记为skipped
        for (const agent of this.input.agents) {
          if (!completed.has(agent.id)) {
            results.push({ agentId: agent.id, role: agent.role, status: "skipped", output: "", duration: 0 });
            completed.add(agent.id);
          }
        }
        break;
      }

      // 并行执行就绪节点
      const roundResults = await Promise.allSettled(
        ready.map(agent => this.runAgent(agent, this.buildContextForNode(agent)))
      );

      for (let i = 0; i < ready.length; i++) {
        const settled = roundResults[i];
        if (settled.status === "fulfilled") {
          results.push(settled.value);
        } else {
          results.push({
            agentId: ready[i].id, role: ready[i].role, status: "failed",
            output: "", duration: 0, error: String(settled.reason),
          });
        }
        completed.add(ready[i].id);
      }
    }

    return results;
  }

  // -------------------------------------------------------------------------
  // Council模式：并行分析 + 可选交叉评审
  // -------------------------------------------------------------------------

  private async executeCouncil(): Promise<AgentResult[]> {
    const results: AgentResult[] = [];

    // Round 1: 并行分析
    const round1 = await Promise.allSettled(
      this.input.agents.map(agent =>
        this.runAgent(agent, `${this.input.goal}\n\n请从${agent.perspective || "你的专业"}视角进行分析。`)
      )
    );

    const round1Results: AgentResult[] = round1.map((r, i) =>
      r.status === "fulfilled" ? r.value : {
        agentId: this.input.agents[i].id, role: this.input.agents[i].role,
        status: "failed", output: "", duration: 0, error: String(r.reason),
      }
    );
    results.push(...round1Results);

    // Round 2 (可选): 交叉评审
    if (this.input.crossReview && round1Results.some(r => r.status === "completed")) {
      const otherOutputs = round1Results
        .filter(r => r.status === "completed")
        .map(r => `${r.role}: ${r.output}`)
        .join("\n\n");

      const crossReviewResults = await Promise.allSettled(
        this.input.agents.map((agent) =>
          this.runAgent(
            { ...agent, id: `${agent.id}-cross-review` },
            `${this.input.goal}\n\n其他成员的分析：\n${otherOutputs}\n\n请综合其他成员的观点，优化你的分析。`
          )
        )
      );

      results.push(...crossReviewResults.map((r, i) =>
        r.status === "fulfilled" ? r.value : {
          agentId: `${this.input.agents[i].id}-cross-review`,
          role: `${this.input.agents[i].role} (交叉评审)`,
          status: "failed", output: "", duration: 0, error: String(r.reason),
        }
      ));
    }

    return results;
  }

  // -------------------------------------------------------------------------
  // Parallel模式：并行执行 + 结果综合
  // -------------------------------------------------------------------------

  private async executeParallel(): Promise<AgentResult[]> {
    const results = await Promise.allSettled(
      this.input.agents.map(agent => this.runAgent(agent, this.input.goal))
    );

    return results.map((r, i) =>
      r.status === "fulfilled" ? r.value : {
        agentId: this.input.agents[i].id, role: this.input.agents[i].role,
        status: "failed", output: "", duration: 0, error: String(r.reason),
      }
    );
  }

  // -------------------------------------------------------------------------
  // Helper: 运行单个Agent
  // -------------------------------------------------------------------------

  private async runAgent(agent: WorkflowAgent, context: string): Promise<AgentResult> {
    const start = Date.now();
    this.emit({ type: "workflow_agent_start", workflowId: this.input.workflowId,
      agentId: agent.id, role: agent.role, task: agent.task });

    try {
      // 使用 AgentRunner.run() 执行
      const result = await this.runner.run({
        sessionId: `${this.input.workflowId}-${agent.id}`,
        agentType: "general",
        input: context,
        systemPrompt: agent.systemPrompt || `You are a ${agent.role}. Task: ${agent.task}`,
        toolNames: agent.tools,
        maxTurns: 20,
        onEvent: (evt: any) => {
          // 将AgentRunner事件映射为workflow事件
          this.emit({
            type: "workflow_agent_chunk",
            workflowId: this.input.workflowId,
            agentId: agent.id,
            chunk: evt.content || "",
          });
        },
      });

      const duration = Date.now() - start;
      this.emit({ type: "workflow_agent_complete", workflowId: this.input.workflowId,
        agentId: agent.id, status: "completed", duration });

      const agentResult: AgentResult = {
        agentId: agent.id, role: agent.role, status: "completed",
        output: result.output || "", duration,
      };
      this.nodeOutputs.set(agent.id, agentResult);
      return agentResult;
    } catch (err) {
      const duration = Date.now() - start;
      this.emit({ type: "workflow_agent_complete", workflowId: this.input.workflowId,
        agentId: agent.id, status: "failed", duration });

      return {
        agentId: agent.id, role: agent.role, status: "failed",
        output: "", duration, error: String(err),
      };
    }
  }

  // -------------------------------------------------------------------------
  // Helper: 环检测 (DFS)
  // -------------------------------------------------------------------------

  private detectCycle(agents: WorkflowAgent[]): string[] | null {
    const visited = new Set<string>();
    const stack = new Set<string>();
    const path: string[] = [];

    const dfs = (id: string): boolean => {
      visited.add(id);
      stack.add(id);
      path.push(id);

      const agent = agents.find(a => a.id === id);
      for (const dep of agent?.dependsOn || []) {
        if (!visited.has(dep)) {
          if (dfs(dep)) return true;
        } else if (stack.has(dep)) {
          path.push(dep);
          return true;
        }
      }

      stack.delete(id);
      path.pop();
      return false;
    };

    for (const agent of agents) {
      if (!visited.has(agent.id)) {
        if (dfs(agent.id)) return path;
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Helper: 条件评估
  // -------------------------------------------------------------------------

  private evaluateCondition(condition: { type: string; node: string; text: string }): boolean {
    const output = this.nodeOutputs.get(condition.node);
    if (!output) return false;
    const text = JSON.stringify(output.output);
    if (condition.type === "output_contains") return text.includes(condition.text);
    return !text.includes(condition.text);
  }

  // -------------------------------------------------------------------------
  // Helper: 构建节点上下文
  // -------------------------------------------------------------------------

  private buildContextForNode(agent: WorkflowAgent): string {
    let context = this.input.goal;
    for (const depId of agent.dependsOn || []) {
      const depResult = this.nodeOutputs.get(depId);
      if (depResult && depResult.status === "completed") {
        context += `\n\n--- ${depResult.role} Output ---\n${depResult.output}`;
      }
    }
    return context;
  }

  // -------------------------------------------------------------------------
  // Helper: 结果综合
  // -------------------------------------------------------------------------

  private synthesizeResults(results: AgentResult[]): string {
    const completed = results.filter(r => r.status === "completed");
    if (completed.length === 0) return "All agents failed.";

    return completed.map(r =>
      `## ${r.role}\n${r.output.slice(0, 1000)}`
    ).join("\n\n");
  }

  // -------------------------------------------------------------------------
  // Helper: 事件发送
  // -------------------------------------------------------------------------

  private emit(event: WorkflowEvent): void {
    try { this.onEvent(event); } catch { /* ignore event errors */ }
  }
}
```

- [ ] 14.2 验证编译

```bash
cd /mnt/d/code/deepanalyze/deepanalyze && npx tsc --noEmit 2>&1 | head -20
```

- [ ] 14.3 提交

```bash
git add src/services/agent/workflow-engine.ts && git commit -m "feat(workflow): add WorkflowEngine with pipeline, graph, council, and parallel modes"
```

---

## Task 15: Agent团队管理器 + workflow_run工具

**文件：** 创建 `src/services/agent/agent-team-manager.ts`，创建 `src/services/agent/tools/workflow-run.ts`

**步骤：**

- [ ] 15.1 创建 `src/services/agent/agent-team-manager.ts`

```typescript
import {
  createTeam, getTeam, getTeamByName, listTeams, updateTeam, deleteTeam,
  type AgentTeam, type AgentTeamMember,
} from "../../store/agent-teams.js";

export class AgentTeamManager {
  /** 预设模板 */
  private templates = [
    {
      name: "研究管道",
      description: "通用文档研究流程",
      mode: "pipeline" as const,
      members: [
        { role: "Researcher", task: "Research all case documents", tools: ["kb_search", "wiki_browse"] },
        { role: "Organizer", task: "Organize findings into categories", tools: ["kb_search"] },
        { role: "Reporter", task: "Generate final report", tools: ["report_generate"] },
      ],
    },
    {
      name: "多视角分析",
      description: "从不同视角平衡分析",
      mode: "council" as const,
      crossReview: true,
      members: [
        { role: "Legal Analyst", task: "Analyze from legal perspective", perspective: "legal", tools: ["kb_search", "wiki_browse"] },
        { role: "Financial Analyst", task: "Analyze from financial perspective", perspective: "financial", tools: ["kb_search", "wiki_browse"] },
        { role: "Evidence Analyst", task: "Analyze evidence chain", perspective: "evidence", tools: ["kb_search", "wiki_browse"] },
      ],
    },
    {
      name: "并行研究",
      description: "快速并行文档扫描",
      mode: "parallel" as const,
      members: [
        { role: "Researcher 1", task: "Research assigned documents", tools: ["kb_search", "wiki_browse"] },
        { role: "Researcher 2", task: "Research assigned documents", tools: ["kb_search", "wiki_browse"] },
        { role: "Researcher 3", task: "Research assigned documents", tools: ["kb_search", "wiki_browse"] },
      ],
    },
    {
      name: "全面分析",
      description: "DAG驱动的复杂案件分析",
      mode: "graph" as const,
      members: [
        { role: "Research-1", task: "Research bank records", dependsOn: [], tools: ["kb_search"] },
        { role: "Research-2", task: "Research witness statements", dependsOn: [], tools: ["kb_search"] },
        { role: "Research-3", task: "Research evidence chain", dependsOn: [], tools: ["kb_search"] },
        { role: "Analyzer", task: "Analyze all findings", dependsOn: ["Research-1", "Research-2", "Research-3"], tools: ["kb_search", "wiki_browse"] },
        { role: "Reporter", task: "Generate final report", dependsOn: ["Analyzer"], tools: ["report_generate"] },
      ],
    },
  ];

  getTeam = getTeam;
  getTeamByName = getTeamByName;
  listTeams = listTeams;
  createTeam = createTeam;
  updateTeam = updateTeam;
  deleteTeam = deleteTeam;

  getTemplates() { return this.templates; }

  createFromTemplate(templateName: string, customName?: string): AgentTeam & { members: AgentTeamMember[] } {
    const tpl = this.templates.find(t => t.name === templateName);
    if (!tpl) throw new Error(`Template not found: ${templateName}`);
    return createTeam({
      name: customName || tpl.name,
      description: tpl.description,
      mode: tpl.mode,
      crossReview: (tpl as any).crossReview,
      members: tpl.members.map(m => ({
        role: m.role,
        task: m.task,
        perspective: (m as any).perspective,
        dependsOn: m.dependsOn || [],
        tools: m.tools,
      })),
    });
  }
}
```

- [ ] 15.2 创建 `src/services/agent/tools/workflow-run.ts`

```typescript
import type { AgentTool } from "../types.js";
import type { AgentRunner } from "../agent-runner.js";
import type { ToolRegistry } from "../tool-registry.js";
import { WorkflowEngine, type WorkflowEvent } from "../workflow-engine.js";
import { randomUUID } from "crypto";

interface WorkflowRunContext {
  runner: AgentRunner;
  toolRegistry: ToolRegistry;
  getTeamManager: () => Promise<import("../agent-team-manager.js").AgentTeamManager>;
  emitWs: (event: WorkflowEvent) => void;
}

export function createWorkflowRunTool(ctx: WorkflowRunContext): AgentTool {
  return {
    name: "workflow_run",
    description:
      "Create and execute a multi-agent workflow. Supports pipeline (sequential), " +
      "graph (DAG with dependencies), council (multi-perspective with cross-review), " +
      "and parallel modes. Specify an existing team name or provide agents inline.",
    inputSchema: {
      type: "object",
      properties: {
        teamName: {
          type: "string",
          description: "Existing team name to use (optional, if provided 'agents' is ignored)",
        },
        mode: {
          type: "string",
          enum: ["pipeline", "graph", "council", "parallel"],
          description: "Workflow scheduling mode",
        },
        goal: {
          type: "string",
          description: "The overall goal/task for the workflow",
        },
        agents: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Unique agent ID" },
              role: { type: "string", description: "Agent role name" },
              task: { type: "string", description: "Specific task for this agent" },
              dependsOn: { type: "array", items: { type: "string" }, description: "Agent IDs this depends on (graph mode)" },
              tools: { type: "array", items: { type: "string" }, description: "Tool names this agent can use" },
            },
            required: ["id", "role", "task"],
          },
          description: "Agent definitions (ignored if teamName is provided)",
        },
      },
      required: ["goal"],
    },
    async execute(input: Record<string, unknown>) {
      const goal = input.goal as string;
      const mode = (input.mode as string) || "parallel";
      const teamName = input.teamName as string | undefined;

      let agents: any[];

      if (teamName) {
        // 加载已有团队
        const teamManager = await ctx.getTeamManager();
        const team = teamManager.getTeamByName(teamName);
        if (!team) throw new Error(`Team not found: ${teamName}`);
        agents = team.members.map(m => ({
          id: m.id, role: m.role, task: m.task, tools: m.tools,
          dependsOn: m.dependsOn, systemPrompt: m.systemPrompt,
          perspective: m.perspective, condition: m.condition,
        }));
      } else {
        agents = (input.agents as any[]) || [];
        if (agents.length === 0) {
          return { error: "Either teamName or agents must be provided" };
        }
      }

      const workflowId = randomUUID();

      const engine = new WorkflowEngine(
        { workflowId, teamName: teamName || "ad-hoc", mode: mode as any, goal, agents },
        ctx.runner,
        ctx.toolRegistry,
        (event) => ctx.emitWs(event),
      );

      const result = await engine.execute();

      return {
        workflowId: result.workflowId,
        status: result.status,
        mode,
        agentResults: result.agentResults.map(r => ({
          agentId: r.agentId, role: r.role, status: r.status,
          outputPreview: r.output.slice(0, 500),
          duration: r.duration,
        })),
        synthesis: result.synthesis,
        totalDuration: result.totalDuration,
      };
    },
  };
}
```

- [ ] 15.3 提交

```bash
git add src/services/agent/agent-team-manager.ts src/services/agent/tools/workflow-run.ts && git commit -m "feat(teams): add team manager with templates and workflow_run tool"
```

---

## Task 16: Agent系统集成

**文件：** 修改 `src/services/agent/tool-setup.ts`，修改 `src/services/agent/agent-system.ts`，修改 `src/server/app.ts`

**步骤：**

- [ ] 16.1 在 `src/services/agent/tool-setup.ts` 中注册 workflow_run 工具

```typescript
// 在 createConfiguredToolRegistry 函数末尾，return registry; 之前添加:

// workflow_run 工具 — 需要在 agent-system 初始化时注入依赖
// 先注册一个占位符，在 agent-system.ts 中替换
```

然后在 `tool-setup.ts` 中导出一个函数用于后续注入：

```typescript
// 在 tool-setup.ts 中添加:
export interface WorkflowRunDeps {
  runner: any; // AgentRunner
  toolRegistry: ToolRegistry;
  getTeamManager: () => Promise<any>;
  emitWs: (event: any) => void;
}

export function registerWorkflowRunTool(registry: ToolRegistry, deps: WorkflowRunDeps): void {
  const { createWorkflowRunTool } = require("./tools/workflow-run.js");
  registry.register(createWorkflowRunTool(deps));
}
```

- [ ] 16.2 在 `src/services/agent/agent-system.ts` 中初始化 WorkflowEngine 和 AgentTeamManager

在 `initializeOrchestrator()` 函数中，Step 9 之后添加：

```typescript
// Step 10: WorkflowEngine + AgentTeamManager
const { AgentTeamManager } = await import("./agent-team-manager.js");
const teamManager = new AgentTeamManager();

const { registerWorkflowRunTool } = await import("./tool-setup.js");

// 创建WebSocket发射器
const emitWs = (event: any) => {
  // 通过全局事件总线发送
  // 在 ws.ts 中会订阅这些事件
  if (typeof globalThis.__workflowEvents !== "undefined") {
    globalThis.__workflowEvents.emit("workflow", event);
  }
};

registerWorkflowRunTool(toolRegistry, {
  runner,
  toolRegistry,
  getTeamManager: async () => teamManager,
  emitWs,
});
```

同时导出 teamManager 和 emitWs：

```typescript
// 在 agent-system.ts 中添加单例导出
let teamManagerInstance: any = null;

export async function getTeamManager() {
  if (!teamManagerInstance) {
    await getOrchestrator();
  }
  return teamManagerInstance!;
}

// 在 initializeOrchestrator 中设置:
teamManagerInstance = teamManager;
```

- [ ] 16.3 创建 `src/server/routes/agent-teams.ts` — REST API

```typescript
import { Hono } from "hono";

export function createAgentTeamRoutes(): Hono {
  const app = new Hono();

  // GET /agent-teams
  app.get("/agent-teams", async (c) => {
    const { getTeamManager } = await import("../../services/agent/agent-system.js");
    const tm = await getTeamManager();
    const teams = tm.listTeams();
    return c.json({ teams });
  });

  // GET /agent-teams/templates
  app.get("/agent-teams/templates", async (c) => {
    const { getTeamManager } = await import("../../services/agent/agent-system.js");
    const tm = await getTeamManager();
    return c.json({ templates: tm.getTemplates() });
  });

  // GET /agent-teams/:id
  app.get("/agent-teams/:id", async (c) => {
    const id = c.req.param("id");
    const { getTeamManager } = await import("../../services/agent/agent-system.js");
    const tm = await getTeamManager();
    const team = tm.getTeam(id);
    if (!team) return c.json({ error: "Team not found" }, 404);
    return c.json(team);
  });

  // POST /agent-teams
  app.post("/agent-teams", async (c) => {
    const body = await c.req.json();
    const { getTeamManager } = await import("../../services/agent/agent-system.js");
    const tm = await getTeamManager();
    const team = tm.createTeam(body);
    return c.json(team, 201);
  });

  // PUT /agent-teams/:id
  app.put("/agent-teams/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();
    const { getTeamManager } = await import("../../services/agent/agent-system.js");
    const tm = await getTeamManager();
    const updated = tm.updateTeam(id, body);
    if (!updated) return c.json({ error: "Team not found" }, 404);
    return c.json({ success: true });
  });

  // DELETE /agent-teams/:id
  app.delete("/agent-teams/:id", async (c) => {
    const id = c.req.param("id");
    const { getTeamManager } = await import("../../services/agent/agent-system.js");
    const tm = await getTeamManager();
    const deleted = tm.deleteTeam(id);
    if (!deleted) return c.json({ error: "Team not found" }, 404);
    return c.json({ success: true });
  });

  return app;
}
```

- [ ] 16.4 在 `src/server/app.ts` 中挂载 agent-teams 路由

```typescript
// 在 app.ts 中添加:
import { createAgentTeamRoutes } from "./routes/agent-teams.js";

// 在路由注册处:
app.route("/api", createAgentTeamRoutes());
```

- [ ] 16.5 提交

```bash
git add src/services/agent/tool-setup.ts src/services/agent/agent-system.ts src/server/routes/agent-teams.ts src/server/app.ts && git commit -m "feat(teams): integrate workflow engine into agent system with REST API"
```

---

## Task 17: WebSocket工作流事件

**文件：** 修改 `src/server/ws.ts`

**步骤：**

- [ ] 17.1 在 `src/server/ws.ts` 中添加工作流事件类型

```typescript
// 在 WsServerMessage 类型联合中添加:
export type WsServerMessage =
  // ... 现有类型 ...
  // 新增工作流事件
  | { type: "workflow_start"; workflowId: string; teamName: string; mode: string; agentCount: number }
  | { type: "workflow_agent_start"; workflowId: string; agentId: string; role: string; task: string }
  | { type: "workflow_agent_tool_call"; workflowId: string; agentId: string; tool: string; args: Record<string, unknown> }
  | { type: "workflow_agent_tool_result"; workflowId: string; agentId: string; tool: string; result: string }
  | { type: "workflow_agent_chunk"; workflowId: string; agentId: string; chunk: string }
  | { type: "workflow_agent_complete"; workflowId: string; agentId: string; status: string; duration: number }
  | { type: "workflow_complete"; workflowId: string; status: string; totalDuration: number; resultCount: number };
```

- [ ] 17.2 添加全局事件总线用于工作流事件分发

```typescript
// 在 ws.ts 中添加全局事件总线
import { EventEmitter } from "events";

// 全局工作流事件发射器
if (!globalThis.__workflowEvents) {
  globalThis.__workflowEvents = new EventEmitter();
}

// 在 WebSocket 连接建立时，订阅工作流事件并转发给客户端
// 在 ws handler 的 connection 回调中添加:
globalThis.__workflowEvents.on("workflow", (event: any) => {
  // 将工作流事件转发给所有订阅了该工作流的WebSocket客户端
  ws.send(JSON.stringify(event));
});
```

- [ ] 17.3 提交

```bash
git add src/server/ws.ts && git commit -m "feat(ws): add workflow event types and WebSocket broadcasting"
```

---

## Task 18: 前端工作流状态管理 + API客户端

**文件：** 创建 `frontend/src/store/workflow.ts`，创建 `frontend/src/api/agentTeams.ts`

**步骤：**

- [ ] 18.1 创建 `frontend/src/api/agentTeams.ts`

```typescript
import { api } from "./client";

export interface TeamInfo {
  id: string;
  name: string;
  description: string;
  mode: "pipeline" | "graph" | "council" | "parallel";
  isActive: boolean;
  crossReview: boolean;
  members: Array<{
    id: string; role: string; task: string;
    tools: string[]; dependsOn: string[]; perspective?: string;
  }>;
  createdAt: string;
}

export const agentTeamsApi = {
  list: () => api.get<{ teams: TeamInfo[] }>("/api/agent-teams").then(r => r.teams),
  get: (id: string) => api.get<TeamInfo>(`/api/agent-teams/${id}`),
  create: (data: any) => api.post<TeamInfo>("/api/agent-teams", data),
  update: (id: string, data: any) => api.put(`/api/agent-teams/${id}`, data),
  delete: (id: string) => api.delete(`/api/agent-teams/${id}`),
  templates: () => api.get<{ templates: any[] }>("/api/agent-teams/templates").then(r => r.templates),
};
```

- [ ] 18.2 创建 `frontend/src/store/workflow.ts`

```typescript
import { create } from "zustand";

interface AgentState {
  agentId: string;
  role: string;
  task: string;
  status: "queued" | "running" | "waiting" | "completed" | "error";
  duration: number;
  toolCallCount: number;
  progress: number;
  messages: Array<{
    type: "tool_call" | "tool_result" | "assistant_chunk" | "system";
    content: string;
    expanded?: boolean;
  }>;
}

interface WorkflowState {
  activeWorkflows: Map<string, {
    workflowId: string;
    teamName: string;
    mode: string;
    startedAt: string;
    agents: Map<string, AgentState>;
  }>;

  handleWorkflowStart: (event: any) => void;
  handleAgentStart: (event: any) => void;
  handleAgentToolCall: (event: any) => void;
  handleAgentToolResult: (event: any) => void;
  handleAgentChunk: (event: any) => void;
  handleAgentComplete: (event: any) => void;
  handleWorkflowComplete: (event: any) => void;
  clearWorkflow: (workflowId: string) => void;
}

export const useWorkflowStore = create<WorkflowState>((set, get) => ({
  activeWorkflows: new Map(),

  handleWorkflowStart: (event) => {
    set((state) => {
      const next = new Map(state.activeWorkflows);
      next.set(event.workflowId, {
        workflowId: event.workflowId,
        teamName: event.teamName,
        mode: event.mode,
        startedAt: new Date().toISOString(),
        agents: new Map(),
      });
      return { activeWorkflows: next };
    });
  },

  handleAgentStart: (event) => {
    set((state) => {
      const next = new Map(state.activeWorkflows);
      const wf = next.get(event.workflowId);
      if (wf) {
        const agents = new Map(wf.agents);
        agents.set(event.agentId, {
          agentId: event.agentId,
          role: event.role,
          task: event.task,
          status: "running",
          duration: 0,
          toolCallCount: 0,
          progress: 10,
          messages: [],
        });
        next.set(event.workflowId, { ...wf, agents });
      }
      return { activeWorkflows: next };
    });
  },

  handleAgentToolCall: (event) => {
    set((state) => {
      const next = new Map(state.activeWorkflows);
      const wf = next.get(event.workflowId);
      if (wf) {
        const agents = new Map(wf.agents);
        const agent = agents.get(event.agentId);
        if (agent) {
          agents.set(event.agentId, {
            ...agent,
            toolCallCount: agent.toolCallCount + 1,
            progress: Math.min(90, agent.progress + 15),
            messages: [...agent.messages, { type: "tool_call", content: `${event.tool}(${JSON.stringify(event.args || {}).slice(0, 100)})` }],
          });
          next.set(event.workflowId, { ...wf, agents });
        }
      }
      return { activeWorkflows: next };
    });
  },

  handleAgentToolResult: (event) => {
    set((state) => {
      const next = new Map(state.activeWorkflows);
      const wf = next.get(event.workflowId);
      if (wf) {
        const agents = new Map(wf.agents);
        const agent = agents.get(event.agentId);
        if (agent) {
          agents.set(event.agentId, {
            ...agent,
            messages: [...agent.messages, { type: "tool_result", content: String(event.result || "").slice(0, 200) }],
          });
          next.set(event.workflowId, { ...wf, agents });
        }
      }
      return { activeWorkflows: next };
    });
  },

  handleAgentChunk: (event) => {
    // 流式文本不需要每次更新state，使用ref或直接DOM操作更高效
  },

  handleAgentComplete: (event) => {
    set((state) => {
      const next = new Map(state.activeWorkflows);
      const wf = next.get(event.workflowId);
      if (wf) {
        const agents = new Map(wf.agents);
        const agent = agents.get(event.agentId);
        if (agent) {
          agents.set(event.agentId, {
            ...agent,
            status: event.status === "completed" ? "completed" : "error",
            duration: event.duration,
            progress: 100,
          });
          next.set(event.workflowId, { ...wf, agents });
        }
      }
      return { activeWorkflows: next };
    });
  },

  handleWorkflowComplete: (event) => {
    // 工作流完成，保留状态供UI显示最终结果
  },

  clearWorkflow: (workflowId) => {
    set((state) => {
      const next = new Map(state.activeWorkflows);
      next.delete(workflowId);
      return { activeWorkflows: next };
    });
  },
}));
```

- [ ] 18.3 提交

```bash
git add frontend/src/store/workflow.ts frontend/src/api/agentTeams.ts && git commit -m "feat(teams): add frontend workflow store and API client"
```

---

## Task 19: 前端多Agent可视化组件

**文件：** 创建 `frontend/src/components/teams/SubAgentPanel.tsx`、`SubAgentSlot.tsx`、`TeamManager.tsx`、`TeamEditor.tsx`

**步骤：**

- [ ] 19.1 创建 `frontend/src/components/teams/SubAgentSlot.tsx` — 单个Agent卡片

```typescript
import React from "react";

interface SubAgentSlotProps {
  role: string;
  task: string;
  status: "queued" | "running" | "waiting" | "completed" | "error";
  duration: number;
  toolCallCount: number;
  progress: number;
  messages: Array<{ type: string; content: string; expanded?: boolean }>;
}

const statusColors: Record<string, string> = {
  queued: "bg-gray-400",
  running: "bg-green-500 animate-pulse",
  waiting: "bg-yellow-500 animate-pulse",
  completed: "bg-blue-500",
  error: "bg-red-500",
};

export const SubAgentSlot: React.FC<SubAgentSlotProps> = ({
  role, task, status, duration, toolCallCount, progress, messages,
}) => (
  <div className="border rounded-lg p-3 dark:border-gray-600 bg-white dark:bg-gray-800">
    <div className="flex items-center gap-2 mb-2">
      <span className={`w-2.5 h-2.5 rounded-full ${statusColors[status]}`} />
      <span className="font-medium text-sm text-gray-900 dark:text-gray-100">{role}</span>
      <span className="ml-auto text-xs text-gray-400">
        {status === "running" ? `${(duration / 1000).toFixed(1)}s...` :
         status === "completed" || status === "error" ? `${(duration / 1000).toFixed(1)}s` : "--"}
      </span>
    </div>
    <div className="text-xs text-gray-500 mb-2">{task}</div>
    <div className="flex items-center gap-2 mb-2">
      <div className="flex-1 h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${
            status === "error" ? "bg-red-500" : status === "completed" ? "bg-blue-500" : "bg-green-500"
          }`}
          style={{ width: `${progress}%` }}
        />
      </div>
      <span className="text-xs text-gray-400">{progress}%</span>
      {toolCallCount > 0 && (
        <span className="text-xs bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 rounded">
          {toolCallCount} tools
        </span>
      )}
    </div>
    {messages.length > 0 && (
      <div className="space-y-1 max-h-32 overflow-y-auto">
        {messages.slice(-5).map((msg, i) => (
          <div key={i} className="text-xs text-gray-400 truncate">
            {msg.type === "tool_call" ? `> ${msg.content}` : msg.content}
          </div>
        ))}
      </div>
    )}
  </div>
);
```

- [ ] 19.2 创建 `frontend/src/components/teams/SubAgentPanel.tsx` — 工作流面板

```typescript
import React from "react";
import { useWorkflowStore } from "../../store/workflow";

interface SubAgentPanelProps {
  workflowId: string;
}

export const SubAgentPanel: React.FC<SubAgentPanelProps> = ({ workflowId }) => {
  const workflow = useWorkflowStore((s) => s.activeWorkflows.get(workflowId));

  if (!workflow) return null;

  const agents = Array.from(workflow.agents.values());
  const completed = agents.filter(a => a.status === "completed" || a.status === "error").length;
  const running = agents.filter(a => a.status === "running").length;

  return (
    <div className="border rounded-lg dark:border-gray-600 bg-white dark:bg-gray-800 my-2">
      <div className="flex items-center justify-between p-3 border-b dark:border-gray-700 bg-gray-50 dark:bg-gray-750">
        <div>
          <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100">
            Workflow: {workflow.teamName}
          </h4>
          <span className="text-xs text-gray-500">
            {workflow.mode} · {agents.length} agents · {completed} completed · {running} running
          </span>
        </div>
      </div>
      <div className="p-3 grid grid-cols-2 gap-2">
        {agents.map((agent) => (
          <SubAgentSlot key={agent.agentId} {...agent} />
        ))}
      </div>
    </div>
  );
};

// 需要导入 SubAgentSlot
import { SubAgentSlot } from "./SubAgentSlot";
```

- [ ] 19.3 创建 `frontend/src/components/teams/TeamManager.tsx`

```typescript
import React, { useState, useEffect } from "react";
import { agentTeamsApi, type TeamInfo } from "../../api/agentTeams";
import { TeamEditor } from "./TeamEditor";

const modeLabels: Record<string, string> = {
  pipeline: "Pipeline",
  graph: "Graph (DAG)",
  council: "Council",
  parallel: "Parallel",
};

export const TeamManager: React.FC = () => {
  const [teams, setTeams] = useState<TeamInfo[]>([]);
  const [showEditor, setShowEditor] = useState(false);
  const [editTeam, setEditTeam] = useState<TeamInfo | null>(null);

  const loadTeams = async () => {
    try { setTeams(await agentTeamsApi.list()); } catch {}
  };

  useEffect(() => { loadTeams(); }, []);

  const handleDelete = async (id: string) => {
    await agentTeamsApi.delete(id);
    loadTeams();
  };

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">Agent Teams</h3>
        <button
          onClick={() => { setEditTeam(null); setShowEditor(true); }}
          className="px-3 py-1.5 bg-blue-500 text-white rounded-lg text-sm hover:bg-blue-600"
        >
          + 新建团队
        </button>
      </div>

      <div className="space-y-3">
        {teams.map((team) => (
          <div key={team.id} className="border rounded-lg p-4 dark:border-gray-600 bg-white dark:bg-gray-800">
            <div className="flex items-center justify-between mb-2">
              <h4 className="font-medium text-gray-900 dark:text-gray-100">{team.name}</h4>
              <span className="px-2 py-0.5 text-xs rounded bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400">
                {modeLabels[team.mode]}
              </span>
            </div>
            <p className="text-sm text-gray-500 mb-2">{team.description}</p>
            <div className="text-xs text-gray-400 mb-3">
              {team.members.map(m => m.role).join(" → ")} · {team.members.length} agents
            </div>
            <div className="flex gap-2">
              <button onClick={() => { setEditTeam(team); setShowEditor(true); }}
                className="px-3 py-1 text-xs bg-gray-100 dark:bg-gray-700 rounded hover:bg-gray-200">
                编辑
              </button>
              <button onClick={() => handleDelete(team.id)}
                className="px-3 py-1 text-xs bg-red-50 text-red-600 dark:bg-red-900/20 rounded hover:bg-red-100">
                删除
              </button>
            </div>
          </div>
        ))}
      </div>

      {showEditor && (
        <TeamEditor
          team={editTeam}
          onClose={() => setShowEditor(false)}
          onSaved={() => { setShowEditor(false); loadTeams(); }}
        />
      )}
    </div>
  );
};
```

- [ ] 19.4 创建 `frontend/src/components/teams/TeamEditor.tsx`

```typescript
import React, { useState } from "react";
import { agentTeamsApi, type TeamInfo } from "../../api/agentTeams";

interface TeamEditorProps {
  team: TeamInfo | null;
  onClose: () => void;
  onSaved: () => void;
}

export const TeamEditor: React.FC<TeamEditorProps> = ({ team, onClose, onSaved }) => {
  const isEdit = !!team;
  const [name, setName] = useState(team?.name || "");
  const [description, setDescription] = useState(team?.description || "");
  const [mode, setMode] = useState(team?.mode || "pipeline");
  const [members, setMembers] = useState(
    team?.members.map(m => ({ ...m })) || [
      { id: `agent-${Date.now()}`, role: "", task: "", tools: ["kb_search"], dependsOn: [] as string[] },
    ]
  );

  const addMember = () => {
    setMembers([...members, { id: `agent-${Date.now()}`, role: "", task: "", tools: ["kb_search"], dependsOn: [] }]);
  };

  const updateMember = (index: number, field: string, value: any) => {
    const next = [...members];
    next[index] = { ...next[index], [field]: value };
    setMembers(next);
  };

  const handleSave = async () => {
    const payload = { name, description, mode, members: members.map(m => ({ ...m })) };
    if (isEdit) {
      await agentTeamsApi.update(team!.id, payload);
    } else {
      await agentTeamsApi.create(payload);
    }
    onSaved();
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-800 rounded-xl w-full max-w-2xl max-h-[80vh] overflow-y-auto p-6">
        <h3 className="text-lg font-medium mb-4 text-gray-900 dark:text-gray-100">
          {isEdit ? "编辑团队" : "创建团队"}
        </h3>

        <div className="space-y-3">
          <div>
            <label className="text-sm text-gray-600 dark:text-gray-400">名称</label>
            <input value={name} onChange={e => setName(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600 dark:text-white mt-1" />
          </div>
          <div>
            <label className="text-sm text-gray-600 dark:text-gray-400">描述</label>
            <textarea value={description} onChange={e => setDescription(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600 dark:text-white mt-1" rows={2} />
          </div>
          <div>
            <label className="text-sm text-gray-600 dark:text-gray-400">调度模式</label>
            <select value={mode} onChange={e => setMode(e.target.value as any)}
              className="w-full px-3 py-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600 dark:text-white mt-1">
              <option value="pipeline">Pipeline（管道）</option>
              <option value="graph">Graph（DAG依赖图）</option>
              <option value="council">Council（议会讨论）</option>
              <option value="parallel">Parallel（并行）</option>
            </select>
          </div>

          <div>
            <label className="text-sm text-gray-600 dark:text-gray-400 block mb-2">Agent成员</label>
            {members.map((m, i) => (
              <div key={m.id} className="border rounded p-3 mb-2 dark:border-gray-600">
                <div className="grid grid-cols-2 gap-2">
                  <input placeholder="角色" value={m.role} onChange={e => updateMember(i, "role", e.target.value)}
                    className="px-2 py-1 border rounded text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
                  <input placeholder="任务" value={m.task} onChange={e => updateMember(i, "task", e.target.value)}
                    className="px-2 py-1 border rounded text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
                </div>
              </div>
            ))}
            <button onClick={addMember} className="text-sm text-blue-500 hover:underline">+ 添加Agent</button>
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose}
            className="px-4 py-2 text-sm bg-gray-100 dark:bg-gray-700 rounded-lg hover:bg-gray-200">取消</button>
          <button onClick={handleSave}
            className="px-4 py-2 text-sm bg-blue-500 text-white rounded-lg hover:bg-blue-600">保存</button>
        </div>
      </div>
    </div>
  );
};
```

- [ ] 19.5 提交

```bash
git add frontend/src/components/teams/SubAgentPanel.tsx frontend/src/components/teams/SubAgentSlot.tsx frontend/src/components/teams/TeamManager.tsx frontend/src/components/teams/TeamEditor.tsx && git commit -m "feat(teams): add frontend visualization components for multi-agent workflows"
```

---

## Task 20: ChatWindow集成 + WebSocket工作流事件连接

**文件：** 修改 `frontend/src/components/ChatWindow.tsx`，修改 `frontend/src/store/chat.ts`

**步骤：**

- [ ] 20.1 在 `frontend/src/store/chat.ts` 中连接工作流WebSocket事件

```typescript
// 在 chat.ts 中添加工作流事件处理
import { useWorkflowStore } from "./workflow";

// 在 WebSocket 消息处理函数中添加 workflow_* 事件分发:
// 现有的 ws.onmessage 处理中添加:
const wfStore = useWorkflowStore.getState();

switch (event.type) {
  case "workflow_start":
    wfStore.handleWorkflowStart(event);
    break;
  case "workflow_agent_start":
    wfStore.handleAgentStart(event);
    break;
  case "workflow_agent_tool_call":
    wfStore.handleAgentToolCall(event);
    break;
  case "workflow_agent_tool_result":
    wfStore.handleAgentToolResult(event);
    break;
  case "workflow_agent_complete":
    wfStore.handleAgentComplete(event);
    break;
  case "workflow_complete":
    wfStore.handleWorkflowComplete(event);
    break;
}
```

- [ ] 20.2 在 `frontend/src/components/ChatWindow.tsx` 中显示工作流面板

```typescript
// 在 ChatWindow.tsx 中导入:
import { SubAgentPanel } from "./teams/SubAgentPanel";
import { useWorkflowStore } from "../store/workflow";

// 在消息渲染中，检测工作流激活状态:
const activeWorkflows = useWorkflowStore((s) => Array.from(s.activeWorkflows.keys()));

// 在 assistant 消息渲染后，如果有活跃工作流，显示 SubAgentPanel:
{activeWorkflows.length > 0 && activeWorkflows.map(wfId => (
  <SubAgentPanel key={wfId} workflowId={wfId} />
))}
```

- [ ] 20.3 在知识面板的设置tab中添加 TeamManager 入口

```typescript
// 在 KnowledgePanel.tsx 的设置 tab 中添加:
import { TeamManager } from "../teams/TeamManager";

// 添加一个新的 "Agent Teams" tab:
{activeTab === "teams" && <TeamManager />}
```

- [ ] 20.4 验证完整编译

```bash
cd /mnt/d/code/deepanalyze/deepanalyze && npx tsc --noEmit 2>&1 | head -20
```

- [ ] 20.5 提交

```bash
git add frontend/src/components/ChatWindow.tsx frontend/src/store/chat.ts frontend/src/components/knowledge/KnowledgePanel.tsx && git commit -m "feat(teams): integrate workflow visualization into chat and knowledge panel"
```

---

## Task 21: 扩展SkillDefinition + PluginManager

**文件：** 修改 `src/services/plugins/types.ts`，修改 `src/services/plugins/plugin-manager.ts`

**步骤：**

- [ ] 21.1 在 `src/services/plugins/types.ts` 中为 SkillDefinition 添加 scheduling 字段

```typescript
// 在 SkillDefinition 接口中添加可选字段:
export interface SkillDefinition {
  // ... 现有字段 ...

  /** 多Agent调度建议（可选） */
  scheduling?: {
    mode: "pipeline" | "graph" | "council" | "parallel";
    teamName?: string;
    agents?: Array<{
      role: string;
      task: string;
      tools: string[];
    }>;
  };
}
```

- [ ] 21.2 在 `src/services/plugins/plugin-manager.ts` 中添加团队调度策略支持

```typescript
// 在 PluginManager 类中添加:
import type { AgentTeamManager } from "../agent/agent-team-manager.js";

private teamManager: AgentTeamManager | null = null;

setTeamManager(tm: AgentTeamManager): void {
  this.teamManager = tm;
}

/** 获取技能的调度建议 */
getSkillScheduling(skillName: string): SkillDefinition["scheduling"] | undefined {
  const skill = this.listSkills().find(s => s.name === skillName);
  return skill?.scheduling;
}
```

- [ ] 21.3 验证编译

```bash
cd /mnt/d/code/deepanalyze/deepanalyze && npx tsc --noEmit 2>&1 | head -20
```

- [ ] 21.4 提交

```bash
git add src/services/plugins/types.ts src/services/plugins/plugin-manager.ts && git commit -m "feat(plugins): extend SkillDefinition with scheduling field for multi-agent workflows"
```

---

**Phase 4 完成。** 全部计划编写完毕。返回 [索引](./2026-04-14-system-redesign.md)
