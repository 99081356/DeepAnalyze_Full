# Sub-Project 4: Agent System Optimization

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Teams UI to Header right panel, implement main/sub model split for agents, fix WorkflowEngine defects (cancel support, parallel council round 2, result persistence), fix orchestrator task ID, implement web_search with SearXNG/Serper backends, and expand TeamEditor fields.

**Architecture:** Header gains a "Teams" button that opens the right panel with TeamManager. AgentRunner uses main model for primary agents (general, report) and summarizer model for sub-agents (explore, compile, verify, coordinator), with automatic failover. WorkflowEngine gets AbortController support and persists results. web_search supports SearXNG (self-hosted) and Serper API (cloud) backends.

**Tech Stack:** TypeScript, Hono (backend), React 19 + Zustand (frontend)

**Spec:** `docs/superpowers/specs/2026-04-18-deepanalyze-system-redesign.md` Section 六

---

## File Structure

| File | Responsibility |
|------|---------------|
| `frontend/src/store/ui.ts` | Add 'teams' to PanelContentType |
| `frontend/src/components/layout/Header.tsx` | Add Teams action button |
| `frontend/src/components/layout/RightPanel.tsx` | Add teams panel case |
| `src/services/agent/agent-runner.ts` | Main/sub model split with failover |
| `src/services/agent/workflow-engine.ts` | AbortController, parallel R2, result persistence |
| `src/services/agent/orchestrator.ts` | Task ID passthrough fix |
| `src/services/agent/tool-setup.ts` | web_search implementation (SearXNG + Serper) |
| `src/server/routes/agents.ts` | Remove double compounding |
| `src/server/routes/agent-teams.ts` | Result persistence |
| `frontend/src/components/teams/TeamEditor.tsx` | Expanded fields (tools, dependsOn, perspective, systemPrompt) |

---

### Task 1: Frontend — Add Teams to Header Right Panel

**Files:**
- Modify: `frontend/src/store/ui.ts`
- Modify: `frontend/src/components/layout/Header.tsx`
- Modify: `frontend/src/components/layout/RightPanel.tsx`

The Teams UI currently exists as components but has no navigation entry. We add it as a right panel option in the Header, alongside sessions/plugins/skills/cron/settings.

- [ ] **Step 1: Add 'teams' to PanelContentType in ui.ts**

In `frontend/src/store/ui.ts` line 6, add `'teams'` to the union:

```typescript
export type PanelContentType = 'sessions' | 'plugins' | 'skills' | 'cron' | 'settings' | 'teams';
```

Also update the frontend types file `frontend/src/types/index.ts` line 573 to match:

```typescript
export type RightPanelId = "sessions" | "plugins" | "cron" | "settings" | "teams" | null;
```

- [ ] **Step 2: Add Teams button to Header.tsx**

In `frontend/src/components/layout/Header.tsx`, add a teams entry to the `headerActions` array (around line 27). Add the import for `Users` icon from lucide-react (it's likely already imported). Insert before the existing entries:

```typescript
{ id: 'teams' as PanelContentType, icon: Users, title: '团队管理' },
```

Add the import for `PanelContentType` from the store:

```typescript
import { useUIStore, type PanelContentType } from "../../store/ui";
```

- [ ] **Step 3: Add teams case to RightPanel.tsx**

In `frontend/src/components/layout/RightPanel.tsx`:

1. Add teams to `PANEL_TITLES` (around line 36):
```typescript
teams: "团队管理",
```

2. Add teams to `PANEL_WIDTHS` (around line 43):
```typescript
teams: 560,
```

3. Add the import for TeamManager:
```typescript
import { TeamManager } from "../teams/TeamManager";
```

4. Add teams case to the `PanelContent` switch (around line 56):
```typescript
case "teams":
  return <TeamManager />;
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/store/ui.ts frontend/src/types/index.ts frontend/src/components/layout/Header.tsx frontend/src/components/layout/RightPanel.tsx
git commit -m "feat(ui): add Teams button to Header right panel"
```

---

### Task 2: AgentRunner — Main/Sub Model Split with Failover

**Files:**
- Modify: `src/services/agent/agent-runner.ts`

Currently all agents use the same model role resolved from their definition. The spec requires: main agents (general, report) use the 'main' model role, sub-agents (explore, compile, verify, coordinator) use the 'summarizer' model role. On failure, automatically switch to the other model.

- [ ] **Step 1: Add sub-agent type detection and model failover**

In `src/services/agent/agent-runner.ts`, modify the model selection logic in the `run()` method (around lines 131-142).

Current code resolves model role then gets the model:
```typescript
const modelRole = options.modelRole ?? definition.modelRole ?? "main";
// ...
const modelId = this.modelRouter.getDefaultModel(modelRole);
```

Replace with model split logic:

```typescript
// --- Main/Sub model split ---
// Primary agents (general, report) use 'main' model
// Sub agents (explore, compile, verify, coordinator) use 'summarizer' model
const SUB_AGENT_TYPES = new Set(["explore", "compile", "verify", "coordinator"]);
const isSubAgent = SUB_AGENT_TYPES.has(effectiveAgentType);

// Resolve primary model role
let modelRole = options.modelRole ?? definition.modelRole ?? (isSubAgent ? "summarizer" : "main");
let modelId: string | undefined;

try {
  await this.modelRouter.ensureCurrent();
  modelId = this.modelRouter.getDefaultModel(modelRole);
} catch {
  // Primary model unavailable, will try fallback in the loop
}

// Store fallback role for failover
const fallbackRole = modelRole === "main" ? "summarizer" : "main";
let usingFallback = false;
```

Then in the TAOR loop, where LLM calls are made (around line 238), wrap the call in a try-catch that attempts fallback model on failure:

```typescript
// Attempt call with primary model, fall back to other model on failure
let response: ChatResponse;
try {
  response = await this.modelRouter.chat(modelId!, messages, toolDefs, options);
} catch (primaryError) {
  // Try fallback model
  if (!usingFallback) {
    try {
      const fallbackModelId = this.modelRouter.getDefaultModel(fallbackRole);
      console.warn(`[AgentRunner] Primary model failed, switching to fallback: ${fallbackRole} (${fallbackModelId})`);
      modelId = fallbackModelId;
      modelRole = fallbackRole;
      usingFallback = true;
      response = await this.modelRouter.chat(fallbackModelId, messages, toolDefs, options);
    } catch {
      throw primaryError;
    }
  } else {
    throw primaryError;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/services/agent/agent-runner.ts
git commit -m "feat(agent): implement main/sub model split with automatic failover"
```

---

### Task 3: WorkflowEngine — Cancel, Parallel Round 2, Result Persistence

**Files:**
- Modify: `src/services/agent/workflow-engine.ts`

Three fixes:
1. Add `AbortController` support for workflow cancellation
2. Council mode Round 2 should run agents in parallel via `Promise.allSettled` (it currently does)
3. Persist results to `agent_tasks` table after workflow completes

- [ ] **Step 1: Add AbortController for cancellation**

In `src/services/agent/workflow-engine.ts`, add an `AbortController` property and a `cancel()` method:

After the class properties (around line 190), add:
```typescript
private abortController = new AbortController();
```

Add a public `cancel()` method:
```typescript
/** Cancel the running workflow. */
cancel(): void {
  this.abortController.abort();
}
```

In the `execute()` method, pass `this.abortController.signal` through to agent runs. Modify `runAgent()` to forward the signal:

In `runAgent()` (around line 588), add the signal to the options:
```typescript
signal: this.abortController.signal,
```

Add cancellation checks at the beginning of each mode executor method:
```typescript
if (this.abortController.signal.aborted) {
  return { /* cancelled result */ };
}
```

- [ ] **Step 2: Persist workflow results**

After workflow execution completes in the `execute()` method (around the final return), add result persistence:

```typescript
// Persist workflow result
try {
  const repos = await getRepos();
  await repos.agentTask.update(this.input.workflowId, {
    status: overallStatus === "completed" ? "completed" : "failed",
    output: JSON.stringify(result),
    completedAt: new Date().toISOString(),
  });
} catch (err) {
  console.error("[WorkflowEngine] Failed to persist result:", err);
}
```

Import `getRepos` at the top of the file.

- [ ] **Step 3: Verify Council Round 2 is parallel**

Read the `executeCouncil()` method to verify Round 2 uses `Promise.allSettled`. If it already does (which the exploration report indicates), no change needed. If it uses sequential execution, fix it.

- [ ] **Step 4: Commit**

```bash
git add src/services/agent/workflow-engine.ts
git commit -m "fix(workflow): add cancel support, persist results, verify parallel council R2"
```

---

### Task 4: Orchestrator — Task ID Passthrough

**Files:**
- Modify: `src/services/agent/orchestrator.ts`

The `AgentTaskRepo.create()` method should accept an optional `id` parameter so the orchestrator can create tasks with predictable IDs that match the workflow engine's expectations.

- [ ] **Step 1: Allow task ID passthrough**

In `src/services/agent/orchestrator.ts`, the `runSingle()` method (around line 94) currently generates a task ID:

Find where the task is created (the `repos.agentTask.create()` call) and check if it accepts an optional `id` parameter. If not, modify the repository to accept it.

First, check the `AgentTaskRepo.create()` method signature. The `NewAgentTask` type (in interfaces.ts lines 406-411) likely doesn't include `id`. Add `id?` to `NewAgentTask`:

In `src/store/repos/interfaces.ts`, modify `NewAgentTask` (around line 406):
```typescript
export interface NewAgentTask {
  id?: string;  // Optional - if provided, used as the task ID
  parentTaskId?: string | null;
  sessionId?: string | null;
  agentType: string;
  status: string;
  input: string;
}
```

Then check the actual repo implementation to ensure the `id` field is used when provided. If the implementation uses `randomUUID()` unconditionally, update it to use the provided ID when available.

- [ ] **Step 2: Commit**

```bash
git add src/store/repos/interfaces.ts src/store/repos/agent-task.ts src/services/agent/orchestrator.ts
git commit -m "fix(orchestrator): allow task ID passthrough for workflow coordination"
```

---

### Task 5: web_search — SearXNG and Serper API Implementation

**Files:**
- Modify: `src/services/agent/tool-setup.ts`

Replace the current web_search stub with a real implementation supporting two backends:
1. **SearXNG** (self-hosted): `GET /search?q=...&format=json`
2. **Serper API** (cloud): `POST https://google.serper.dev/search` with API key

Backend selection via environment variable `SEARCH_BACKEND` (values: `searxng` or `serper`). Additional env vars: `SEARXNG_URL` and `SERPER_API_KEY`.

- [ ] **Step 1: Implement web_search tool**

Replace the `web_search` tool definition in `createConfiguredToolRegistry()` (around lines 669-702) with:

```typescript
registry.register({
  name: "web_search",
  description: "Search the web for information. Returns search results with titles, URLs, and snippets.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      maxResults: { type: "number", description: "Maximum number of results (default: 10)" },
    },
    required: ["query"],
  },
  execute: async (args: { query: string; maxResults?: number }) => {
    const backend = process.env.SEARCH_BACKEND ?? "searxng";
    const maxResults = args.maxResults ?? 10;

    try {
      if (backend === "serper") {
        // Serper API (cloud)
        const apiKey = process.env.SERPER_API_KEY;
        if (!apiKey) {
          return "Web search (Serper) is not configured. Set SERPER_API_KEY environment variable.";
        }

        const resp = await fetch("https://google.serper.dev/search", {
          method: "POST",
          headers: {
            "X-API-KEY": apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            q: args.query,
            num: maxResults,
            gl: "cn",
            hl: "zh-cn",
          }),
          signal: AbortSignal.timeout(15000),
        });

        if (!resp.ok) {
          return `Search request failed: HTTP ${resp.status}`;
        }

        const data = await resp.json() as {
          organic?: Array<{ title: string; link: string; snippet: string }>;
        };

        const results = (data.organic ?? []).slice(0, maxResults);
        if (results.length === 0) return `No results found for "${args.query}".`;

        return results
          .map((r, i) => `[${i + 1}] ${r.title}\n    ${r.link}\n    ${r.snippet}`)
          .join("\n\n");
      } else {
        // SearXNG (self-hosted)
        const searxngUrl = process.env.SEARXNG_URL ?? "http://localhost:8888";
        const url = `${searxngUrl}/search?q=${encodeURIComponent(args.query)}&format=json&categories=general&language=zh-CN`;

        const resp = await fetch(url, {
          signal: AbortSignal.timeout(15000),
        });

        if (!resp.ok) {
          return `Search request failed: HTTP ${resp.status}. Check SearXNG at ${searxngUrl}`;
        }

        const data = await resp.json() as {
          results?: Array<{ title: string; url: string; content: string }>;
        };

        const results = (data.results ?? []).slice(0, maxResults);
        if (results.length === 0) return `No results found for "${args.query}".`;

        return results
          .map((r, i) => `[${i + 1}] ${r.title}\n    ${r.url}\n    ${r.content}`)
          .join("\n\n");
      }
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        return `Search request timed out for "${args.query}".`;
      }
      return `Search failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});
```

- [ ] **Step 2: Commit**

```bash
git add src/services/agent/tool-setup.ts
git commit -m "feat(tools): implement web_search with SearXNG and Serper API backends"
```

---

### Task 6: agents.ts — Remove Double Compounding

**Files:**
- Modify: `src/server/routes/agents.ts`

The spec notes that compounding happens in both `agents.ts` route AND `AgentRunner.run()`. This causes agent outputs to be written to the knowledge base twice. Remove the compounding from the route and keep it only in `AgentRunner.run()`.

- [ ] **Step 1: Remove compounder calls from agents.ts route**

In `src/server/routes/agents.ts`, find the auto-compounding sections:

1. In the `/run` route (around lines 105-122): Remove the `compounder.compoundAgentResult()` call. Keep only the message saving and response sending logic.

2. In the `/run-stream` SSE route (around lines 290-302): Remove the `compounder.compoundAgentResult()` call in the fire-and-forget section. Keep only the message saving logic.

The compounding in `AgentRunner.run()` (agent-runner.ts lines 403-467) already handles this correctly.

- [ ] **Step 2: Commit**

```bash
git add src/server/routes/agents.ts
git commit -m "fix(agents): remove double compounding from route layer, keep in AgentRunner"
```

---

### Task 7: agent-teams.ts — Result Persistence

**Files:**
- Modify: `src/server/routes/agent-teams.ts`

The workflow execution endpoint (POST /:id/execute) starts the workflow asynchronously but doesn't persist results. The WorkflowEngine itself will persist results (added in Task 3), but the route should also update the parent task record.

- [ ] **Step 1: Add result persistence callback**

In `src/server/routes/agent-teams.ts`, modify the execute endpoint (around line 100) to create a task record before starting the workflow and update it on completion:

Before the async workflow execution, create a task record:
```typescript
// Create task record for tracking
const repos = await getRepos();
const taskId = workflowId;
await repos.agentTask.create({
  id: taskId,
  parentTaskId: null,
  sessionId: null,
  agentType: `workflow_${input.mode}`,
  status: "running",
  input: JSON.stringify({ goal: body.goal, teamId: team.id, mode: team.mode }),
});
```

After the workflow completes (in the .then() or callback), update the task:
```typescript
.then(async (result) => {
  try {
    await repos.agentTask.update(taskId, {
      status: result.status === "completed" ? "completed" : "failed",
      output: JSON.stringify(result),
      completedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[AgentTeams] Failed to persist workflow result:", err);
  }
})
.catch(async (err) => {
  try {
    await repos.agentTask.update(taskId, {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
      completedAt: new Date().toISOString(),
    });
  } catch {}
});
```

- [ ] **Step 2: Commit**

```bash
git add src/server/routes/agent-teams.ts
git commit -m "feat(teams): persist workflow results to agent_tasks table"
```

---

### Task 8: TeamEditor — Expanded Fields

**Files:**
- Modify: `frontend/src/components/teams/TeamEditor.tsx`

Add UI fields for tools (multi-select), dependsOn (Graph mode), perspective (Council mode), and systemPrompt.

- [ ] **Step 1: Add expanded fields to TeamEditor**

In `frontend/src/components/teams/TeamEditor.tsx`, enhance each member card to include:

1. **systemPrompt** field — a collapsible textarea below the Task input. Label: "系统提示词（可选）". Only shown when expanded.

2. **tools** multi-select — a set of checkbox buttons for common tools: `kb_search`, `wiki_browse`, `expand`, `web_search`, `bash`, `read_file`, `grep`. Show as inline chips. Default: all selected.

3. **dependsOn** — a multi-select of other members' roles (shown only when mode is `graph`). Label: "依赖". Chips for each other member's role.

4. **perspective** — a text input (shown only when mode is `council`). Label: "分析视角". Placeholder: "从...角度分析".

These fields should be added to the member card rendering section. Each member already has a `role` and `task` input. Add the new fields below them, conditionally shown based on the team mode.

Also update `handleSave()` to include these fields in the saved data.

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/teams/TeamEditor.tsx
git commit -m "feat(teams): add tools, dependsOn, perspective, systemPrompt fields to TeamEditor"
```

---

### Task 9: Integration Verification

**Files:**
- Various (fix any import/type errors)

- [ ] **Step 1: TypeScript compile check**

Run the TypeScript compiler on both backend and frontend:

```bash
cd /mnt/d/code/deepanalyze/deepanalyze && npx tsc --noEmit 2>&1 | head -50
cd frontend && npx tsc --noEmit 2>&1 | head -50
```

Fix any errors found. Common issues to expect:
- PanelContentType changes may break type checks
- New agent-runner model selection may have type mismatches
- web_search tool implementation may need type adjustments

- [ ] **Step 2: Commit fixes**

```bash
git add -A
git commit -m "fix: resolve integration errors in agent system components"
```

---

## Summary

| Task | Component | Description |
|------|-----------|-------------|
| 1 | Header + RightPanel + ui store | Add Teams button to Header right panel |
| 2 | AgentRunner | Main/sub model split with automatic failover |
| 3 | WorkflowEngine | Cancel support, result persistence, parallel R2 check |
| 4 | Orchestrator + Repo | Task ID passthrough for workflow coordination |
| 5 | tool-setup.ts | web_search with SearXNG and Serper API |
| 6 | agents.ts | Remove double compounding |
| 7 | agent-teams.ts | Persist workflow results to agent_tasks |
| 8 | TeamEditor | Expanded fields (tools, dependsOn, perspective, systemPrompt) |
| 9 | Integration | TypeScript compile check + fixes |
