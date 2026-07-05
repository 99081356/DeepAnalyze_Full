// =============================================================================
// DeepAnalyze - Skill Management Tools (Create / Update / Delete)
// =============================================================================
// Tools for the agent to create, update, and delete skills at runtime.
// Skills can be saved to the database (for immediate use) or to SKILL.md files
// (for file-based persistence and sharing).
// =============================================================================

import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

// ---------------------------------------------------------------------------
// skill_create tool
// ---------------------------------------------------------------------------

export function createSkillCreateTool(dataDir: string): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<unknown>;
} {
  return {
    name: "skill_create",
    description:
      "Create a new reusable skill from a system prompt. " +
      "Skills capture proven workflows for reuse in similar tasks. " +
      "Use 'db' save_path for immediate use, or 'file' to generate a SKILL.md file for sharing.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Skill name (unique identifier, use snake_case).",
        },
        description: {
          type: "string",
          description: "Brief description of what this skill does and when to use it.",
        },
        prompt: {
          type: "string",
          description: "The full system prompt for this skill. Include instructions, constraints, and output format guidance.",
        },
        tools: {
          type: "array",
          items: { type: "string" },
          description: "List of tool names the skill can use. Use [\"*\"] for all tools.",
        },
        save_path: {
          type: "string",
          enum: ["db", "file"],
          description: "Where to save: 'db' (database, immediate use) or 'file' (SKILL.md file). Default: db.",
        },
        model_role: {
          type: "string",
          description: "Model role: main, summarizer, embedding, or vlm. Default: main.",
        },
      },
      required: ["name", "description", "prompt"],
    },
    async execute(input: Record<string, unknown>) {
      const name = input.name as string;
      const description = input.description as string;
      const prompt = input.prompt as string;
      const tools = (input.tools as string[]) ?? ["*"];
      const savePath = (input.save_path as string) ?? "db";
      const modelRole = (input.model_role as string) ?? "main";

      if (!name || !description || !prompt) {
        return { error: "name, description, and prompt are required." };
      }

      // Validate name format
      if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)) {
        return { error: "Skill name must start with a letter and contain only letters, numbers, hyphens, and underscores." };
      }

      if (savePath === "file") {
        // Generate SKILL.md file
        const skillDir = join(dataDir, "skills", name);
        await mkdir(skillDir, { recursive: true });
        const skillFilePath = join(skillDir, "SKILL.md");
        const content = generateSkillMd(name, description, tools, modelRole, prompt);
        await writeFile(skillFilePath, content, "utf-8");

        return {
          success: true,
          message: `Skill "${name}" saved as SKILL.md file at ${skillFilePath}`,
          path: skillFilePath,
        };
      }

      // Save to database
      try {
        const { getRepos } = await import("../../../store/repos/index.js");
        const repos = await getRepos();

        // Check for duplicate name
        const existing = await repos.agentSkill.getByName(name);
        if (existing) {
          return { error: `A skill named "${name}" already exists. Use skill_update to modify it, or choose a different name.` };
        }

        const skill = await repos.agentSkill.create({
          name,
          description,
          prompt,
          tools,
          modelRole,
          isActive: true,
        });

        return {
          success: true,
          message: `Skill "${name}" created and saved to database.`,
          skill: {
            id: skill.id,
            name: skill.name,
            description: skill.description,
          },
        };
      } catch (err) {
        return { error: `Failed to save skill to database: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// skill_update tool
// ---------------------------------------------------------------------------

export function createSkillUpdateTool(): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<unknown>;
} {
  return {
    name: "skill_update",
    description:
      "Update an existing skill's prompt, description, or tool list. " +
      "Only the fields you provide will be changed.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Name of the skill to update.",
        },
        description: {
          type: "string",
          description: "New description (optional).",
        },
        prompt: {
          type: "string",
          description: "New system prompt (optional).",
        },
        tools: {
          type: "array",
          items: { type: "string" },
          description: "New tool list (optional).",
        },
        is_active: {
          type: "boolean",
          description: "Enable or disable the skill (optional).",
        },
      },
      required: ["name"],
    },
    async execute(input: Record<string, unknown>) {
      const name = input.name as string;

      try {
        const { getRepos } = await import("../../../store/repos/index.js");
        const repos = await getRepos();

        const existing = await repos.agentSkill.getByName(name);
        if (!existing) {
          return { error: `Skill "${name}" not found. Use list_skills to see available skills.` };
        }

        const updateData: Record<string, unknown> = {};
        if (input.description !== undefined) updateData.description = input.description;
        if (input.prompt !== undefined) updateData.prompt = input.prompt;
        if (input.tools !== undefined) updateData.tools = input.tools;
        if (input.is_active !== undefined) updateData.isActive = input.is_active;

        if (Object.keys(updateData).length === 0) {
          return { error: "No fields to update. Provide at least one of: description, prompt, tools, is_active." };
        }

        const updated = await repos.agentSkill.update(existing.id, updateData);

        return {
          success: true,
          message: `Skill "${name}" updated.`,
          skill: updated ? {
            id: updated.id,
            name: updated.name,
            description: updated.description,
          } : undefined,
        };
      } catch (err) {
        return { error: `Failed to update skill: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// skill_delete tool
// ---------------------------------------------------------------------------

export function createSkillDeleteTool(): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<unknown>;
} {
  return {
    name: "skill_delete",
    description:
      "Delete a skill permanently. This cannot be undone.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Name of the skill to delete.",
        },
      },
      required: ["name"],
    },
    async execute(input: Record<string, unknown>) {
      const name = input.name as string;

      try {
        const { getRepos } = await import("../../../store/repos/index.js");
        const repos = await getRepos();

        const existing = await repos.agentSkill.getByName(name);
        if (!existing) {
          return { error: `Skill "${name}" not found.` };
        }

        await repos.agentSkill.delete(existing.id);

        return {
          success: true,
          message: `Skill "${name}" deleted.`,
        };
      } catch (err) {
        return { error: `Failed to delete skill: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: Generate SKILL.md content
// ---------------------------------------------------------------------------

function generateSkillMd(
  name: string,
  description: string,
  tools: string[],
  modelRole: string,
  prompt: string,
): string {
  const toolsYaml = tools.length === 1 && tools[0] === "*"
    ? "[*]"
    : `[${tools.join(", ")}]`;

  return `---
description: ${description}
tools: ${toolsYaml}
model-role: ${modelRole}
---

# ${name}

${prompt}
`;
}
