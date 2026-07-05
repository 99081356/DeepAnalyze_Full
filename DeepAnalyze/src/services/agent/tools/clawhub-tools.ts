// =============================================================================
// DeepAnalyze - ClawHub Skill Hub Tools
// =============================================================================
// Tools for searching and installing skills from the ClawHub remote registry.
// =============================================================================

import { join, resolve } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { ClawHubClient } from "../clawhub-client.js";
import type { AgentTool } from "../types.js";

// ---------------------------------------------------------------------------
// Shared client singleton
// ---------------------------------------------------------------------------

let client: ClawHubClient | null = null;
function getClient(): ClawHubClient {
  if (!client) {
    client = new ClawHubClient();
  }
  return client;
}

// ---------------------------------------------------------------------------
// skill_hub_search tool
// ---------------------------------------------------------------------------

export const skillHubSearchTool: AgentTool = {
  name: "skill_hub_search",
  description:
    "Search the ClawHub remote skill registry for community and published skills. " +
    "Returns skill names, descriptions, authors, and security status. " +
    "Use skill_hub_install to download and install found skills. " +
    "ClawHub is at https://clawhub.ai/ and hosts skills compatible with this platform.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query to find skills (keywords, skill name, capability)",
      },
      limit: {
        type: "number",
        description: "Maximum number of results to return (default: 10)",
      },
    },
    required: ["query"],
  },
  async execute(input: Record<string, unknown>) {
    const query = input.query as string;
    const limit = (input.limit as number) ?? 10;

    try {
      const hubClient = getClient();
      const results = await hubClient.search(query, { limit });

      if (results.skills.length === 0) {
        return {
          total: 0,
          skills: [],
          message: `No skills found on ClawHub matching "${query}". Try different keywords.`,
        };
      }

      return {
        total: results.total,
        skills: results.skills.map((s) => ({
          slug: s.slug,
          name: s.name,
          description: s.description,
          author: s.author,
          securityStatus: s.securityStatus,
          url: s.url,
        })),
        hint: "Use skill_hub_install with the slug to install a skill.",
      };
    } catch (err) {
      return {
        error: `ClawHub search failed: ${err instanceof Error ? err.message : String(err)}`,
        hint: "Check network connectivity. ClawHub may be temporarily unavailable.",
      };
    }
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  shouldDefer: true,
};

// ---------------------------------------------------------------------------
// skill_hub_install tool
// ---------------------------------------------------------------------------

export function createSkillHubInstallTool(dataDir: string): AgentTool {
  return {
    name: "skill_hub_install",
    description:
      "Download and install a skill from the ClawHub remote registry. " +
      "The skill is saved to the local plugins directory and registered in the database. " +
      "Use skill_hub_search first to find available skills.",
    inputSchema: {
      type: "object",
      properties: {
        slug: {
          type: "string",
          description:
            "The skill slug from ClawHub search results (e.g., 'openpod', 'deep-research-openclaw-agent')",
        },
        install_dir: {
          type: "string",
          description:
            "Directory to install the skill into. Default: 'plugins/installed/<slug>'. " +
            "Relative to the application data directory.",
        },
      },
      required: ["slug"],
    },
    async execute(input: Record<string, unknown>) {
      const slug = input.slug as string;
      const installDir = (input.install_dir as string) ?? `plugins/installed/${slug}`;

      try {
        const hubClient = getClient();
        const result = await hubClient.downloadSkill(slug);

        // Determine the installation path
        const fullInstallDir = resolve(dataDir, installDir);

        // Create directory if needed
        await mkdir(fullInstallDir, { recursive: true });

        // Save the SKILL.md file
        const skillMdPath = join(fullInstallDir, "SKILL.md");
        await writeFile(skillMdPath, result.content, "utf-8");

        // Create a minimal plugin.json so the plugin manager can load it
        const pluginJson = {
          name: `hub-${slug}`,
          version: "1.0.0",
          description: `Installed from ClawHub: ${slug}`,
          capabilities: ["skills"],
          skills: ["."],
        };
        await writeFile(
          join(fullInstallDir, "plugin.json"),
          JSON.stringify(pluginJson, null, 2),
          "utf-8",
        );

        // Register in the database with source='hub'
        const { getRepos } = await import("../../../store/repos/index.js");
        const repos = await getRepos();
        const existing = await repos.agentSkill.getByNameAndSource(
          result.manifest.name,
          "hub",
        );

        if (!existing) {
          await repos.agentSkill.create({
            name: result.manifest.name,
            description: result.manifest.description,
            prompt: result.manifest.systemPrompt,
            tools: result.manifest.tools,
            modelRole: result.manifest.modelRole ?? "main",
            source: "hub",
            hubSlug: slug,
            hubUrl: `https://clawhub.ai/skills/${slug}`,
          });
        } else {
          // Update existing hub skill
          await repos.agentSkill.update(existing.id, {
            description: result.manifest.description,
            prompt: result.manifest.systemPrompt,
            tools: result.manifest.tools,
            hubSlug: slug,
            hubUrl: `https://clawhub.ai/skills/${slug}`,
          });
        }

        return {
          success: true,
          slug,
          name: result.manifest.name,
          description: result.manifest.description,
          installedTo: fullInstallDir,
          message: `Skill "${result.manifest.name}" installed successfully from ClawHub. Use skill_invoke to use it.`,
        };
      } catch (err) {
        return {
          error: `Failed to install skill "${slug}": ${err instanceof Error ? err.message : String(err)}`,
          hint: "Ensure the slug is correct (use skill_hub_search to verify). Check network connectivity.",
        };
      }
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    shouldDefer: true,
  };
}
