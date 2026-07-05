// =============================================================================
// DeepAnalyze - Plugin and Skill API Routes
// =============================================================================
// Hono routes for plugin lifecycle management and skill CRUD. The plugin
// manager is obtained lazily via getPluginManager() inside each handler so
// that importing this module never triggers the agent pipeline on its own.
// =============================================================================

import { Hono } from "hono";
import { getPluginManager } from "../../services/agent/agent-system.js";
import type {
  PluginAgentDefinition,
  PluginManifest,
  PluginState,
  SkillDefinition,
} from "../../services/plugins/types.js";
import { AgentPluginManager } from "../../services/agent/plugin-manager.js";
import { errorMessage } from "../../utils/errors.ts";

// ---------------------------------------------------------------------------
// Request types
// ---------------------------------------------------------------------------

/** Body for POST /plugins/register. */
interface RegisterPluginRequest {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  agents?: PluginAgentDefinition[];
  defaultConfig?: Record<string, unknown>;
}

/** Body for PUT /plugins/:pluginId/config. */
interface UpdateConfigRequest {
  config: Record<string, unknown>;
}

/** Body for POST /skills. */
interface CreateSkillRequest {
  name: string;
  description: string;
  pluginId?: string;
  systemPrompt: string;
  tools: string[];
  variables?: SkillDefinition["variables"];
  modelRole?: string;
  maxTurns?: number;
}

/** Body for POST /skills/:skillId/resolve. */
interface ResolvePromptRequest {
  variables: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

/**
 * Create plugin and skill API routes.
 *
 * Plugin routes:
 *   GET    /plugins                    - List all loaded plugins
 *   GET    /plugins/:pluginId          - Get a single plugin's state
 *   POST   /plugins/register           - Register a new plugin
 *   POST   /plugins/:pluginId/enable   - Enable a plugin
 *   POST   /plugins/:pluginId/disable  - Disable a plugin
 *   DELETE /plugins/:pluginId          - Unregister a plugin
 *   PUT    /plugins/:pluginId/config   - Update plugin configuration
 *
 * Skill routes:
 *   GET    /skills                     - List all skills
 *   GET    /skills/:skillId            - Get a single skill
 *   POST   /skills                     - Create a new skill
 *   DELETE /skills/:skillId            - Delete a skill
 *   POST   /skills/:skillId/resolve    - Resolve a skill prompt with variables
 */
export function createPluginRoutes(): Hono {
  const router = new Hono();

  // =====================================================================
  // GET /plugins - List all loaded plugins
  // =====================================================================

  router.get("/plugins", async (c) => {
    try {
      const pm = await getPluginManager();
      const plugins: PluginState[] = pm.listPlugins();
      return c.json({ plugins });
    } catch (err) {
      const errorMsg = errorMessage(err);
      return c.json({ error: errorMsg }, 500);
    }
  });

  // =====================================================================
  // GET /plugins/:pluginId - Get a single plugin's state
  // =====================================================================

  router.get("/plugins/:pluginId", async (c) => {
    try {
      const pluginId = c.req.param("pluginId");
      const pm = await getPluginManager();
      const state = pm.getPluginState(pluginId);

      if (!state) {
        return c.json({ error: `Plugin "${pluginId}" not found.` }, 404);
      }

      return c.json(state);
    } catch (err) {
      const errorMsg = errorMessage(err);
      return c.json({ error: errorMsg }, 500);
    }
  });

  // =====================================================================
  // POST /plugins/register - Register a new plugin
  // =====================================================================

  router.post("/plugins/register", async (c) => {
    try {
      const body = await c.req.json<RegisterPluginRequest>();

      if (!body.id || !body.name || !body.version || !body.description) {
        return c.json(
          { error: "id, name, version, and description are required" },
          400,
        );
      }

      const pm = await getPluginManager();

      // Build a manifest from the request body. Tools cannot be registered
      // over HTTP (they need executable functions), so only agent definitions
      // are accepted via the API.
      const manifest: PluginManifest = {
        id: body.id,
        name: body.name,
        version: body.version,
        description: body.description,
        author: body.author,
        agents: body.agents,
        defaultConfig: body.defaultConfig,
      };

      const state: PluginState = await pm.registerPlugin(manifest);
      return c.json(state, 201);
    } catch (err) {
      const errorMsg = errorMessage(err);
      return c.json({ error: errorMsg }, 500);
    }
  });

  // =====================================================================
  // POST /plugins/:pluginId/enable - Enable a plugin
  // =====================================================================

  router.post("/plugins/:pluginId/enable", async (c) => {
    try {
      const pluginId = c.req.param("pluginId");
      const pm = await getPluginManager();

      await pm.enablePlugin(pluginId);

      return c.json({ pluginId, enabled: true });
    } catch (err) {
      const errorMsg = errorMessage(err);
      return c.json({ error: errorMsg }, 500);
    }
  });

  // =====================================================================
  // POST /plugins/:pluginId/disable - Disable a plugin
  // =====================================================================

  router.post("/plugins/:pluginId/disable", async (c) => {
    try {
      const pluginId = c.req.param("pluginId");
      const pm = await getPluginManager();

      await pm.disablePlugin(pluginId);

      return c.json({ pluginId, enabled: false });
    } catch (err) {
      const errorMsg = errorMessage(err);
      return c.json({ error: errorMsg }, 500);
    }
  });

  // =====================================================================
  // DELETE /plugins/:pluginId - Unregister a plugin
  // =====================================================================

  router.delete("/plugins/:pluginId", async (c) => {
    try {
      const pluginId = c.req.param("pluginId");
      const pm = await getPluginManager();

      await pm.unregisterPlugin(pluginId);

      return c.json({ pluginId, deleted: true });
    } catch (err) {
      const errorMsg = errorMessage(err);
      return c.json({ error: errorMsg }, 500);
    }
  });

  // =====================================================================
  // PUT /plugins/:pluginId/config - Update plugin configuration
  // =====================================================================

  router.put("/plugins/:pluginId/config", async (c) => {
    try {
      const pluginId = c.req.param("pluginId");
      const body = await c.req.json<UpdateConfigRequest>();

      if (!body.config || typeof body.config !== "object") {
        return c.json(
          { error: "config object is required" },
          400,
        );
      }

      const pm = await getPluginManager();

      await pm.updatePluginConfig(pluginId, body.config);

      return c.json({ pluginId, config: body.config });
    } catch (err) {
      const errorMsg = errorMessage(err);
      return c.json({ error: errorMsg }, 500);
    }
  });

  // =====================================================================
  // GET /skills - List all skills
  // =====================================================================

  router.get("/skills", async (c) => {
    try {
      const pm = await getPluginManager();
      const pluginId = c.req.query("pluginId");

      const skills: SkillDefinition[] = await pm.listSkills(pluginId || undefined);
      return c.json({ skills });
    } catch (err) {
      const errorMsg = errorMessage(err);
      return c.json({ error: errorMsg }, 500);
    }
  });

  // =====================================================================
  // GET /skills/:skillId - Get a single skill
  // =====================================================================

  router.get("/skills/:skillId", async (c) => {
    try {
      const skillId = c.req.param("skillId");
      const pm = await getPluginManager();
      const skill = await pm.getSkill(skillId);

      if (!skill) {
        return c.json({ error: `Skill "${skillId}" not found.` }, 404);
      }

      return c.json(skill);
    } catch (err) {
      const errorMsg = errorMessage(err);
      return c.json({ error: errorMsg }, 500);
    }
  });

  // =====================================================================
  // POST /skills - Create a new skill
  // =====================================================================

  router.post("/skills", async (c) => {
    try {
      const body = await c.req.json<CreateSkillRequest>();

      if (!body.name || !body.description || !body.systemPrompt || !body.tools) {
        return c.json(
          { error: "name, description, systemPrompt, and tools are required" },
          400,
        );
      }

      const pm = await getPluginManager();

      const skill: SkillDefinition = await pm.createSkill({
        name: body.name,
        pluginId: body.pluginId ?? null,
        description: body.description,
        systemPrompt: body.systemPrompt,
        tools: body.tools,
        variables: body.variables,
        modelRole: body.modelRole,
        maxTurns: body.maxTurns,
        config: {},
      });

      return c.json(skill, 201);
    } catch (err) {
      const errorMsg = errorMessage(err);
      return c.json({ error: errorMsg }, 500);
    }
  });

  // =====================================================================
  // DELETE /skills/:skillId - Delete a skill
  // =====================================================================

  router.delete("/skills/:skillId", async (c) => {
    try {
      const skillId = c.req.param("skillId");
      const pm = await getPluginManager();

      await pm.deleteSkill(skillId);

      return c.json({ skillId, deleted: true });
    } catch (err) {
      const errorMsg = errorMessage(err);
      return c.json({ error: errorMsg }, 500);
    }
  });

  // =====================================================================
  // POST /skills/:skillId/resolve - Resolve a skill prompt with variables
  // =====================================================================

  router.post("/skills/:skillId/resolve", async (c) => {
    try {
      const skillId = c.req.param("skillId");
      const body = await c.req.json<ResolvePromptRequest>();

      if (!body.variables || typeof body.variables !== "object") {
        return c.json(
          { error: "variables object is required" },
          400,
        );
      }

      const pm = await getPluginManager();
      const prompt = await pm.resolveSkillPrompt(skillId, body.variables);

      return c.json({ prompt });
    } catch (err) {
      const errorMsg = errorMessage(err);
      return c.json({ error: errorMsg }, 500);
    }
  });

  // =====================================================================
  // POST /plugins/install - Install a plugin from a directory
  // =====================================================================

  router.post("/plugins/install", async (c) => {
    try {
      const body = await c.req.json<{ dirPath: string }>();

      if (!body.dirPath) {
        return c.json({ error: "dirPath is required" }, 400);
      }

      // Use the file-based AgentPluginManager to load from directory
      const agentPm = new AgentPluginManager();
      const plugin = await agentPm.loadPlugin(body.dirPath);

      return c.json({
        name: plugin.manifest.name,
        version: plugin.manifest.version,
        description: plugin.manifest.description,
        capabilities: plugin.manifest.capabilities,
        skillsLoaded: plugin.skills.length,
        agentsLoaded: plugin.agents.length,
        hookIds: plugin.loadedHookIds,
        toolNames: plugin.loadedToolNames,
        enabled: plugin.enabled,
      }, 201);
    } catch (err) {
      const errorMsg = errorMessage(err);
      return c.json({ error: errorMsg }, 500);
    }
  });

  // =====================================================================
  // POST /plugins/discover - Discover plugins in search directories
  // =====================================================================

  router.post("/plugins/discover", async (c) => {
    try {
      const body = await c.req.json<{ searchPaths: string[] }>();

      if (!body.searchPaths || !Array.isArray(body.searchPaths)) {
        return c.json({ error: "searchPaths (string[]) is required" }, 400);
      }

      const agentPm = new AgentPluginManager();
      const plugins = await agentPm.discoverPlugins(body.searchPaths);

      return c.json({
        discovered: plugins.map(p => ({
          name: p.manifest.name,
          version: p.manifest.version,
          description: p.manifest.description,
          capabilities: p.manifest.capabilities,
          skillsLoaded: p.skills.length,
          agentsLoaded: p.agents.length,
          enabled: p.enabled,
        })),
      });
    } catch (err) {
      const errorMsg = errorMessage(err);
      return c.json({ error: errorMsg }, 500);
    }
  });

  return router;
}
