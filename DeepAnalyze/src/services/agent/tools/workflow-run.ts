// =============================================================================
// DeepAnalyze - workflow_run Agent Tool
// =============================================================================
// An AgentTool that allows an agent to autonomously create and execute
// multi-agent workflows. It resolves teams by name from the AgentTeamManager
// or accepts inline agent definitions, then delegates execution to the
// WorkflowEngine.
// =============================================================================

import { randomUUID } from "node:crypto";
import { AgentTeamManager } from "../agent-team-manager.js";
import { WorkflowEngine } from "../workflow-engine.js";
import { getWorkflowManager } from "../workflow-manager.js";
import { resolveFeatureFlags } from "../feature-flags.js";
import { getRepos } from "../../../store/repos/index.js";
import type { WorkflowAgent, WorkflowMode, WorkflowEvent, WorkflowResult } from "../workflow-engine.js";
import type { AgentTool } from "../types.js";
import type { AgentRunner } from "../agent-runner.js";
import type { ToolRegistry } from "../tool-registry.js";

// ---------------------------------------------------------------------------
// Context needed by the tool
// ---------------------------------------------------------------------------

/**
 * External references that the workflow_run tool needs to operate.
 * These are typically passed in during tool registration.
 */
export interface WorkflowRunContext {
  /** The AgentRunner used to execute individual agents. */
  runner: AgentRunner;
  /** The ToolRegistry for resolving tool names. */
  toolRegistry: ToolRegistry;
  /** Optional event callback for real-time progress reporting. */
  onEvent?: (event: WorkflowEvent) => void;
  /** Root data directory for persisting sub-agent output files. */
  dataDir: string;
}

// ---------------------------------------------------------------------------
// Inline agent schema type (what the LLM sends)
// ---------------------------------------------------------------------------

/** Shape of an inline agent as provided by the calling LLM. */
interface InlineAgent {
  /** Unique identifier within this workflow. */
  id: string;
  /** Role name (e.g. "researcher"). */
  role: string;
  /** Optional system prompt override. */
  systemPrompt?: string;
  /** Task instruction. */
  task: string;
  /** Perspective hint for council mode. */
  perspective?: string;
  /** Agent IDs this agent depends on (graph mode). */
  dependsOn?: string[];
  /** Conditional execution (graph mode). */
  condition?: {
    type: "output_contains" | "output_not_contains";
    node: string;
    text: string;
  };
  /** Tool names. Use ["*"] for all. Defaults to ["*"]. */
  tools?: string[];
  /** Optional context information injected before the sub-agent's task. */
  context?: string;
  /** Whether to inherit the parent agent's conversation context. */
  inheritContext?: boolean;
}

// ---------------------------------------------------------------------------
// Duplicate dispatch detection
// ---------------------------------------------------------------------------
// Tracks dispatched agent tasks per session to detect accidental duplicate
// dispatches. The model may intend to dispatch "batch 2 (chapters 7-12)" but
// the actual tool_call JSON contains the same tasks as batch 1 (chapters 1-6).
// This module detects such parameter/content mismatches.

const sessionDispatchHistory = new Map<string, Array<{
  tasks: string[];
  timestamp: number;
}>>();

const MAX_DISPATCH_HISTORY_PER_SESSION = 10;
const DISPATCH_HISTORY_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Check whether the current dispatch significantly overlaps with previous
 * dispatches in the same session. Returns a warning string if duplicates
 * are detected, null otherwise. Records the dispatch either way.
 */
function checkAndRecordDispatch(
  sessionId: string,
  currentTasks: string[],
): string | null {
  const now = Date.now();
  let history = sessionDispatchHistory.get(sessionId);

  // Clean expired entries
  if (history) {
    history = history.filter(h => now - h.timestamp < DISPATCH_HISTORY_TTL_MS);
  } else {
    history = [];
  }

  // Check overlap with each previous dispatch
  for (const prev of history) {
    const overlapCount = currentTasks.filter(t => prev.tasks.includes(t)).length;
    const overlapRatio = currentTasks.length > 0
      ? overlapCount / currentTasks.length
      : 0;

    // If ≥70% of tasks overlap with a previous dispatch, flag as duplicate
    if (overlapRatio >= 0.7 && overlapCount >= 2) {
      // Still record this attempt so repeated retries are tracked
      history.push({ tasks: currentTasks, timestamp: now });
      if (history.length > MAX_DISPATCH_HISTORY_PER_SESSION) history.shift();
      sessionDispatchHistory.set(sessionId, history);

      return (
        `⚠️ 重复派发检测：当前 ${currentTasks.length} 个子Agent中有 ${overlapCount} 个的任务描述与之前同一会话中已派发的子Agent完全相同。\n\n` +
        `这通常是因为参数传递错误：模型的文本输出描述了不同的子任务范围，但实际的 agents 参数复制了之前批次的定义。\n\n` +
        `请执行以下检查：\n` +
        `1. 回顾本批次应负责的子任务范围（与之前已派发的批次应不同）\n` +
        `2. 确认每个子Agent的 task 描述正确反映了本批次的范围，而非之前批次的\n` +
        `3. 修正 agents 参数后重新提交\n` +
        `4. 如果确实需要重做之前失败的任务，请在 task 描述中明确标注（如"重做：..."）`
      );
    }
  }

  // No significant overlap — record this dispatch
  history.push({ tasks: currentTasks, timestamp: now });
  if (history.length > MAX_DISPATCH_HISTORY_PER_SESSION) history.shift();
  sessionDispatchHistory.set(sessionId, history);

  return null;
}

// ---------------------------------------------------------------------------
// workflow_run tool
// ---------------------------------------------------------------------------

/**
 * Resolve the effective sessionId for a workflow.
 *
 * Primary source: execContext.sessionId (set by the caller's ALS context).
 * Fallback: query the DB for the parent task's sessionId — this handles the
 * sub-agent / skill-invocation case where the workflow_run caller doesn't
 * have sessionId in its own ALS context but the parent agent task does.
 *
 * Returns the sessionId, or undefined if neither source yields one. Never
 * returns the literal "unknown" — that sentinel breaks session-scoped event
 * routing and UI card association.
 */
async function resolveWorkflowSessionId(
  execContextSessionId: unknown,
  parentTaskId: unknown,
): Promise<string | undefined> {
  if (typeof execContextSessionId === "string" && execContextSessionId.length > 0) {
    return execContextSessionId;
  }
  if (typeof parentTaskId !== "string" || parentTaskId.length === 0) {
    return undefined;
  }
  try {
    const repos = await getRepos();
    const task = await repos.agentTask.get(parentTaskId);
    return task?.sessionId ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Create the `workflow_run` agent tool.
 *
 * This tool lets an agent spawn a multi-agent workflow either by referencing
 * a persisted team name or by providing an inline agent array.
 *
 * @param ctx - External references (runner, toolRegistry, optional event callback).
 * @returns An AgentTool instance named "workflow_run".
 */
export function createWorkflowRunTool(ctx: WorkflowRunContext): AgentTool {
  const teamManager = new AgentTeamManager();

  return {
    name: "workflow_run",

    description:
      "启动多 Agent 并行工作流。适用于：同时分析多个文档/知识库、多角度并行分析、可拆分为独立子任务的大型任务。\n" +
      "所有子Agent同时执行（parallel/council 模式），总耗时约等于最慢的一个子Agent。" +
      "提供 teamName 使用已保存团队模板，或直接提供内联 Agent 定义。" +
      "模式: pipeline(串行) | graph(依赖图) | council(多角度+交叉审查) | parallel(并行) | single(委托单个Agent，仅用于只需1个子任务的场景)。" +
      "每个子Agent拥有独立的完整上下文窗口。简单查询不需要使用此工具。\n\n" +
      "**必填参数**: mode（调度模式）和 goal（工作流的高层目标，如用户的原始问题或本次分析的总体目的，用于子Agent间协调和交叉审查）。\n\n" +
      "**Agent分配要点**: 先用 wiki_browse(listDocuments) 获取文档清单，按相关性分组，" +
      "合理分配 Agent 数量和职责——确保每个文档/维度都有明确的负责 Agent。" +
      "在每个Agent的task中明确指定其负责的范围（文档类型、目录路径、文件名特征或文档ID列表），大量文件优先用目录或类别概括。相关文档分配给同一Agent。" +
      "context 字段可传递用户问题、文档清单等背景信息。inheritContext:true 继承对话历史（消耗更多token）。\n\n" +
      "**返回后处理**: 工作流返回子Agent简介和推送清单。处理步骤：\n" +
      "1. 检查推送清单中的审核状态——只有 ✓（审核通过）的才能推送\n" +
      "2. 如果有 ⚠（审核未通过）的项，用 delegate_task 派发新子Agent重做该部分任务\n" +
      "3. 根据用户需求，从清单中选择 ✓ 的文件，用 push_content(filePath=路径) 逐一推送\n" +
      "4. 补做完成后的结果也要检查并推送\n" +
      "5. 推送完毕后调用 finish\n" +
      "不要读取子Agent的输出文件，不要合并重写。",

    inputSchema: {
      type: "object",
      properties: {
        teamName: {
          type: "string",
          description:
            "要加载的已保存团队名称。如果提供，agents 字段将被忽略。",
        },
        mode: {
          type: "string",
          enum: ["pipeline", "graph", "council", "parallel", "single"],
          description: "工作流调度模式。",
        },
        goal: {
          type: "string",
          description: "工作流的高层目标或问题。",
        },
        crossReview: {
          type: "boolean",
          description:
            "是否运行交叉审查轮（仅 council 模式）。默认：false。",
        },
        agents: {
          type: "array",
          description:
            "内联 Agent 定义。提供 teamName 时忽略此字段。",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "工作流内的唯一 Agent 标识符。" },
              role: { type: "string", description: "角色名称。" },
              systemPrompt: { type: "string", description: "可选的系统提示词覆盖。" },
              task: { type: "string", description: "任务指令。" },
              perspective: { type: "string", description: "视角提示（council 模式）。" },
              dependsOn: {
                type: "array",
                items: { type: "string" },
                description: "此 Agent 依赖的 Agent ID 列表（graph 模式）。",
              },
              condition: {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["output_contains", "output_not_contains"] },
                  node: { type: "string" },
                  text: { type: "string" },
                },
                description: "条件执行（graph 模式）。",
              },
              tools: {
                type: "array",
                items: { type: "string" },
                description: "工具名称列表。使用 ['*'] 表示所有工具。",
              },
              context: {
                type: "string",
                description: "可选的上下文信息，注入到子Agent任务前。用于传递用户原始问题、知识库文档清单、其他Agent的职责分配等背景信息。",
              },
              inheritContext: {
                type: "boolean",
                description: "是否继承主Agent的对话上下文。设为 true 时子Agent可以看到主Agent的完整对话历史，适合需要理解完整任务背景的子任务。默认 false。",
              },
            },
            required: ["id", "role", "task"],
          },
        },
      },
      required: ["mode", "goal"],
    },

    async execute(input: Record<string, unknown>): Promise<WorkflowResult> {
      const mode = input.mode as WorkflowMode;
      const teamName = input.teamName as string | undefined;
      const crossReview = (input.crossReview as boolean) ?? false;
      const inlineAgents = input.agents as InlineAgent[] | undefined;

      // -------------------------------------------------------------------
      // Resolve agents: from team name or inline definitions
      // -------------------------------------------------------------------
      let workflowAgents: WorkflowAgent[];
      let resolvedTeamName: string;
      let resolvedCrossReview = crossReview;

      if (teamName) {
        // Load team from the store
        const team = await teamManager.getTeamByName(teamName);
        if (!team) {
          throw new Error(`Team not found: "${teamName}"`);
        }

        resolvedTeamName = team.name;
        resolvedCrossReview = crossReview || team.crossReview;

        // Map stored members to WorkflowAgent shape
        workflowAgents = team.members.map((member) => ({
          id: member.id,
          role: member.role,
          systemPrompt: member.systemPrompt,
          task: member.task,
          perspective: member.perspective,
          dependsOn: member.dependsOn,
          condition: member.condition as WorkflowAgent["condition"],
          tools: member.tools,
        }));
      } else if (inlineAgents && inlineAgents.length > 0) {
        // Use inline definitions
        resolvedTeamName = "inline";

        workflowAgents = inlineAgents.map((a) => ({
          id: a.id,
          role: a.role,
          systemPrompt: a.systemPrompt,
          task: a.task,
          perspective: a.perspective,
          dependsOn: a.dependsOn,
          condition: a.condition,
          tools: a.tools ?? ["*"],
          contextText: a.context,
          inheritContext: a.inheritContext,
        }));
      } else {
        throw new Error(
          "Either 'teamName' or 'agents' must be provided to workflow_run.",
        );
      }

      // -------------------------------------------------------------------
      // Resolve goal — derive from agents' tasks if model didn't provide it
      // -------------------------------------------------------------------
      const goal = (input.goal as string) || workflowAgents
        .map(a => `${a.role}: ${(a.task ?? "").slice(0, 80)}`)
        .join("; ") || "Multi-agent workflow";

      // -------------------------------------------------------------------
      // Duplicate dispatch detection
      // -------------------------------------------------------------------
      const execContext = ctx.toolRegistry.getExecutionContext();
      // Resolve sessionId from execContext, falling back to parent task's
      // sessionId via DB lookup. Never use "unknown" sentinel — it breaks
      // session-scoped event routing and duplicate detection across the real
      // session. If we can't resolve, use the parentTaskId as a stable key.
      const resolvedSessionId = await resolveWorkflowSessionId(
        execContext.sessionId,
        execContext.taskId,
      );
      const sessionId = resolvedSessionId
        ?? (typeof execContext.taskId === "string" ? execContext.taskId : "orphan");
      const currentTasks = workflowAgents
        .map(a => (a.task ?? "").trim())
        .filter(t => t.length > 0);

      const duplicateWarning = checkAndRecordDispatch(sessionId, currentTasks);
      if (duplicateWarning) {
        return {
          workflowId: randomUUID(),
          status: "failed" as const,
          agentResults: [],
          synthesis: duplicateWarning,
          totalDuration: 0,
        };
      }

      // -------------------------------------------------------------------
      // Determine effective mode
      // -------------------------------------------------------------------
      const effectiveMode: WorkflowMode = mode;

      // -------------------------------------------------------------------
      // Build and execute the workflow
      // -------------------------------------------------------------------
      const workflowId = randomUUID();

      // Initialize mailbox for inter-agent communication (graph/parallel modes)
      const needsMailbox = effectiveMode === "graph" || effectiveMode === "parallel";
      if (needsMailbox) {
        const mailbox = new Map<string, Array<{ from: string; message: string; timestamp: string }>>();
        for (const agent of workflowAgents) {
          mailbox.set(agent.id, []);
        }
        // Directly mutate the per-task context (ALS provides per-task isolation)
        const execCtx = ctx.toolRegistry.getExecutionContext();
        (execCtx as Record<string, unknown>).mailbox = mailbox;
      }

      // Extract parent signal from execution context (injected by agent-runner)
      const parentSignal = execContext.signal as AbortSignal | undefined;

      // Check if background (non-blocking) workflow mode is enabled
      const featureFlags = resolveFeatureFlags();
      if (featureFlags.backgroundWorkflows) {
        // Non-blocking mode: start workflow in background, return immediately
        const wm = getWorkflowManager();
        const bgWorkflowId = wm.startWorkflow({
          sessionId: resolvedSessionId,
          goal,
          mode: effectiveMode,
          teamName: resolvedTeamName,
          agents: workflowAgents,
          crossReview: resolvedCrossReview,
          runner: ctx.runner,
          toolRegistry: ctx.toolRegistry,
          onEvent: ctx.onEvent,
          signal: parentSignal,
          dataDir: ctx.dataDir,
        });

        return {
          status: "dispatched" as const,
          workflowId: bgWorkflowId,
          agentCount: workflowAgents.length,
          agentRoles: workflowAgents.map((a) => a.role),
          message: `工作流已在后台启动（${workflowAgents.length}个子Agent）。使用 workflow_status 查看进度，完成后系统自动通知。`,
        } as unknown as WorkflowResult;
      }

      // Blocking mode (default): original behavior
      const engine = new WorkflowEngine(
        {
          workflowId,
          sessionId: resolvedSessionId,
          parentTaskId: execContext.taskId as string | undefined,
          teamName: resolvedTeamName,
          mode: effectiveMode,
          goal,
          agents: workflowAgents,
          crossReview: resolvedCrossReview,
          dataDir: ctx.dataDir,
        },
        ctx.runner,
        ctx.toolRegistry,
        ctx.onEvent,
        parentSignal,
      );

      const result = await engine.execute();

      return result;
    },
  };
}
