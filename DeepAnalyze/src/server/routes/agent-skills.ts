// =============================================================================
// DeepAnalyze - Agent Skills API Routes
// =============================================================================

import { Hono } from "hono";
import { getRepos } from "../../store/repos/index.js";

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
