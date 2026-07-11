// =============================================================================
// DeepAnalyze - Agent Skills API Routes
// =============================================================================

import { Hono } from "hono";
import { getRepos } from "../../store/repos/index.js";
import type { AgentSkill } from "../../store/repos/interfaces.js";
import {
  parseSkillFile,
  parseSkillBundle,
  manifestToNewAgentSkill,
  type ConflictExisting,
} from "../../services/agent/skill-import.js";

export const agentSkillRoutes = new Hono();

// GET / - List all agent skills
agentSkillRoutes.get("/", async (c) => {
  const repos = await getRepos();
  const skills = await repos.agentSkill.list();
  return c.json(skills);
});

// GET /active - List only active skills
agentSkillRoutes.get("/active", async (c) => {
  const repos = await getRepos();
  const skills = await repos.agentSkill.listActive();
  return c.json(skills);
});

// GET /:id - Get skill by ID
agentSkillRoutes.get("/:id", async (c) => {
  const id = c.req.param("id");
  const repos = await getRepos();
  const skill = await repos.agentSkill.get(id);
  if (!skill) {
    return c.json({ error: "Skill not found" }, 404);
  }
  return c.json(skill);
});

// POST / - Create a new skill
agentSkillRoutes.post("/", async (c) => {
  const body = await c.req.json<{
    name: string;
    description?: string;
    prompt: string;
    tools?: string[];
    modelRole?: string;
    isActive?: boolean;
  }>();

  if (!body.name || !body.prompt) {
    return c.json({ error: "name and prompt are required" }, 400);
  }

  const repos = await getRepos();

  // Check for duplicate name
  const existing = await repos.agentSkill.getByName(body.name);
  if (existing) {
    return c.json({ error: `Skill with name "${body.name}" already exists` }, 409);
  }

  const skill = await repos.agentSkill.create({
    name: body.name,
    description: body.description,
    prompt: body.prompt,
    tools: body.tools,
    modelRole: body.modelRole,
    isActive: body.isActive,
  });

  return c.json(skill, 201);
});

// POST /import - Import one or more skills from an uploaded file
//   (.md / .json / .zip). Multipart form fields:
//     file  — the uploaded skill file (required)
//     mode  — conflict resolution: "auto" (default) | "overwrite" | "rename"
//     newName — required when mode="rename"; applies to the single imported skill
//
// Conflict flow: with mode="auto", a name collision returns 409
// { conflict: true, existing, parsed } WITHOUT writing anything. The client
// then re-POSTs with mode="overwrite" or mode="rename" (+newName) to resolve.
agentSkillRoutes.post("/import", async (c) => {
  const contentType = c.req.header("content-type") || "";

  // Two upload modes:
  // 1. JSON folder bundle: { type: "folder", files: [{path, content}], mode, newName }
  //    — used for folder uploads (avoids FormData multipart quirks).
  // 2. Multipart FormData: single .md/.json/.zip file.
  let mode = "auto";
  let newName: string | null = null;
  let parsed: Awaited<ReturnType<typeof parseSkillFile>>;

  try {
    if (contentType.includes("application/json")) {
      // Folder bundle mode.
      const body = await c.req.json<{
        type?: string;
        files?: Array<{ path: string; content: string }>;
        mode?: string;
        newName?: string;
      }>();
      mode = body.mode || "auto";
      newName = body.newName ?? null;
      if (!body.files || body.files.length === 0) {
        return c.json({ error: "缺少文件内容" }, 400);
      }
      parsed = await parseSkillBundle(body.files);
    } else {
      // Single-file FormData mode.
      const formData = await c.req.formData();
      mode = (formData.get("mode") as string | null) || "auto";
      newName = formData.get("newName") as string | null;
      const file = formData.getAll("file").find((v): v is File => v instanceof File);
      if (!file) {
        return c.json({ error: "缺少上传文件 (file)" }, 400);
      }
      parsed = await parseSkillFile(file);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 400);
  }

  if (mode !== "auto" && mode !== "overwrite" && mode !== "rename") {
    return c.json({ error: `非法的 mode: ${mode}` }, 400);
  }
  if (parsed.length === 0) {
    return c.json({ error: "文件中未找到可导入的技能" }, 400);
  }

  const repos = await getRepos();
  const results: unknown[] = [];
  const conflicts: Array<{
    name: string;
    existing: ConflictExisting;
    parsed: { name: string; description: string; prompt: string };
  }> = [];

  for (const { name: originalName, manifest } of parsed) {
    // Determine the final name according to mode.
    let finalName = originalName;
    if (mode === "rename") {
      // For multi-skill imports (ZIP), allow per-skill rename only when a
      // single skill is imported; otherwise rename is applied as-is and
      // conflicts are surfaced.
      finalName = (newName?.trim() && parsed.length === 1 ? newName.trim() : originalName);
    }

    const existing = await repos.agentSkill.getByName(finalName);

    if (existing && mode === "auto") {
      // Surface conflict, do not write.
      conflicts.push({
        name: finalName,
        existing: toConflictExisting(existing),
        parsed: {
          name: finalName,
          description: manifest.description,
          prompt: manifest.systemPrompt.slice(0, 500),
        },
      });
      continue;
    }

    if (existing && mode === "overwrite") {
      // Update the existing skill in place.
      const updated = await repos.agentSkill.update(existing.id, {
        name: finalName,
        description: manifest.description,
        prompt: manifest.systemPrompt,
        tools: manifest.tools,
        modelRole: manifest.modelRole ?? "main",
        antiHallucinationLevel: manifest.antiHallucinationLevel,
        triggers: manifest.triggers,
        tags: manifest.tags,
        homepage: manifest.homepage ?? null,
        version: manifest.version ?? null,
        author: manifest.author ?? null,
        emoji: manifest.emoji ?? null,
      });
      results.push({ action: "updated", skill: updated });
      continue;
    }

    // mode === "rename" (no existing or renamed away) or no existing.
    // If still colliding on rename, fall back to a numeric suffix.
    let safeName = finalName;
    if (mode === "rename") {
      let probe = await repos.agentSkill.getByName(safeName);
      let n = 2;
      while (probe) {
        safeName = `${finalName}-${n++}`;
        probe = await repos.agentSkill.getByName(safeName);
      }
    }

    const created = await repos.agentSkill.create(
      manifestToNewAgentSkill(manifest, { name: safeName, source: "manual" }),
    );
    results.push({ action: "created", skill: created });
  }

  // If any conflicts were surfaced in auto mode, report them without claiming success.
  if (conflicts.length > 0) {
    return c.json(
      { conflict: true, conflicts, created: results.length ? results : undefined },
      409,
    );
  }

  return c.json({ conflict: false, results });
});

// PUT /:id - Update a skill
agentSkillRoutes.put("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{
    name?: string;
    description?: string;
    prompt?: string;
    tools?: string[];
    modelRole?: string;
    isActive?: boolean;
  }>();

  const repos = await getRepos();

  // If renaming, check for duplicate
  if (body.name) {
    const existing = await repos.agentSkill.getByName(body.name);
    if (existing && existing.id !== id) {
      return c.json({ error: `Skill with name "${body.name}" already exists` }, 409);
    }
  }

  const skill = await repos.agentSkill.update(id, body);
  if (!skill) {
    return c.json({ error: "Skill not found" }, 404);
  }

  return c.json(skill);
});

// DELETE /:id - Delete a skill
agentSkillRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const repos = await getRepos();
  const deleted = await repos.agentSkill.delete(id);
  if (!deleted) {
    return c.json({ error: "Skill not found" }, 404);
  }
  return c.json({ success: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toConflictExisting(skill: AgentSkill): ConflictExisting {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    prompt: skill.prompt.slice(0, 500),
    source: skill.source,
  };
}

