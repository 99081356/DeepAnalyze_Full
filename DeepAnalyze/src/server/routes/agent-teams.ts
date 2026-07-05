// =============================================================================
// DeepAnalyze - Agent Teams API Routes
// REST API for managing agent teams (CRUD + templates + workflow execution)
// =============================================================================

import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { getTeamManager, getRunner, getToolRegistry } from "../../services/agent/agent-system.js";
import { WorkflowEngine } from "../../services/agent/workflow-engine.js";
import type { WorkflowAgent, WorkflowEvent } from "../../services/agent/workflow-engine.js";
import type { CreateTeamData, UpdateTeamData } from "../../store/repos/index.js";
import { getRepos } from "../../store/repos/index.js";

export function createAgentTeamRoutes(): Hono {
  const router = new Hono();

  // -----------------------------------------------------------------------
  // Templates
  // -----------------------------------------------------------------------

  /** List all available team templates */
  router.get("/templates", async (c) => {
    const manager = await getTeamManager();
    const templates = manager.getTemplates();
    return c.json(templates);
  });

  // -----------------------------------------------------------------------
  // Team CRUD
  // -----------------------------------------------------------------------

  /** List all teams (with members for display) */
  router.get("/", async (c) => {
    const manager = await getTeamManager();
    const teams = await manager.listTeams();
    // Fetch members for each team to provide complete data to the frontend
    const teamsWithMembers = await Promise.all(
      teams.map(async (t) => {
        const full = await manager.getTeam(t.id);
        return full ?? { ...t, members: [] };
      }),
    );
    return c.json(teamsWithMembers);
  });

  /** Get a single team by ID (with members) */
  router.get("/:id", async (c) => {
    const manager = await getTeamManager();
    const team = await manager.getTeam(c.req.param("id"));
    if (!team) return c.json({ error: "Team not found" }, 404);
    return c.json(team);
  });

  /** Create a new team */
  router.post("/", async (c) => {
    const body = await c.req.json<CreateTeamData>();

    if (!body.name?.trim()) {
      return c.json({ error: "Team name is required" }, 400);
    }
    if (!body.mode) {
      return c.json({ error: "Team mode is required (pipeline | graph | council | parallel)" }, 400);
    }
    if (!body.members || body.members.length === 0) {
      return c.json({ error: "At least one team member is required" }, 400);
    }

    try {
      const manager = await getTeamManager();
      const team = await manager.createTeam(body);
      return c.json(team, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Failed to create team" }, 400);
    }
  });

  /** Update a team */
  router.put("/:id", async (c) => {
    const body = await c.req.json<UpdateTeamData>();

    try {
      const manager = await getTeamManager();
      const team = await manager.updateTeam(c.req.param("id"), body);
      if (!team) return c.json({ error: "Team not found" }, 404);
      return c.json(team);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Failed to update team" }, 400);
    }
  });

  /** Delete a team */
  router.delete("/:id", async (c) => {
    const manager = await getTeamManager();
    const ok = await manager.deleteTeam(c.req.param("id"));
    if (!ok) return c.json({ error: "Team not found" }, 404);
    return c.json({ success: true });
  });

  // -----------------------------------------------------------------------
  // Workflow Execution
  // -----------------------------------------------------------------------

  /**
   * POST /:id/execute
   * Start an asynchronous workflow execution for a team.
   * Returns immediately with the workflow ID and initial status.
   */
  router.post("/:id/execute", async (c) => {
    const teamId = c.req.param("id");

    let goal: string;
    let kbId: string | undefined;
    try {
      const body = await c.req.json<{ goal?: string; kbId?: string }>();
      goal = body.goal ?? "";
      kbId = body.kbId;
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!goal.trim()) {
      return c.json({ error: "goal is required" }, 400);
    }

    const manager = await getTeamManager();
    const team = await manager.getTeam(teamId);
    if (!team) {
      return c.json({ error: "Team not found" }, 404);
    }

    if (!team.members || team.members.length === 0) {
      return c.json({ error: "Team has no members" }, 400);
    }

    const runner = await getRunner();
    const toolRegistry = await getToolRegistry();

    const workflowId = randomUUID();

    const workflowAgents: WorkflowAgent[] = team.members.map((m) => ({
      id: m.id,
      role: m.role,
      systemPrompt: m.systemPrompt,
      task: m.task,
      perspective: m.perspective,
      dependsOn: m.dependsOn,
      condition: m.condition as WorkflowAgent["condition"],
      tools: m.tools,
    }));

    const onEvent = (event: WorkflowEvent): void => {
      globalThis.__workflowEvents?.emit("workflow", event);
    };

    const effectiveGoal = kbId
      ? `${goal}\n\nKnowledge base context: focus on knowledge base ID "${kbId}".`
      : goal;

    const engine = new WorkflowEngine(
      {
        workflowId,
        teamName: team.name,
        mode: team.mode,
        goal: effectiveGoal,
        agents: workflowAgents,
        crossReview: team.crossReview,
      },
      runner,
      toolRegistry,
      onEvent,
    );

    // Persist task record before starting async execution
    const repos = await getRepos();
    await repos.agentTask.create({
      id: workflowId,
      agentType: `workflow_${team.mode}`,
      input: JSON.stringify({ goal, teamId: team.id, mode: team.mode }),
    });

    // Execute asynchronously — do NOT await
    engine.execute()
      .then(async (result) => {
        try {
          const repos = await getRepos();
          const status = result.status === "completed" ? "completed" : "failed";
          const output = result.synthesis ?? JSON.stringify(result);
          await repos.agentTask.updateStatus(workflowId, status, output);
        } catch (err) {
          console.error("[AgentTeams] Failed to persist workflow result:", err);
        }
      })
      .catch(async (err) => {
        console.error(`[WorkflowEngine] Workflow ${workflowId} failed:`, err);
        try {
          const repos = await getRepos();
          const errorMsg = err instanceof Error ? err.message : String(err);
          await repos.agentTask.updateStatus(workflowId, "failed", undefined, errorMsg);
        } catch {}
        globalThis.__workflowEvents?.emit("workflow", {
          type: "workflow_complete",
          workflowId,
          status: "failed",
          totalDuration: 0,
          resultCount: 0,
        });
      });

    return c.json({
      workflowId,
      teamId,
      mode: team.mode,
      status: "running",
    }, 202);
  });

  return router;
}
