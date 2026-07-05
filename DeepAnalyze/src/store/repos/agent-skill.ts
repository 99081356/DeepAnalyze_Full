import { randomUUID } from "node:crypto";
import pg from "pg";
import type {
  AgentSkillRepo,
  AgentSkill,
  NewAgentSkill,
  UpdateAgentSkill,
} from "./interfaces.js";

export class PgAgentSkillRepo implements AgentSkillRepo {
  constructor(private pool: pg.Pool) {}

  async create(data: NewAgentSkill): Promise<AgentSkill> {
    const id = data.id ?? randomUUID();
    const tools = data.tools ?? ["*"];
    const { rows } = await this.pool.query(
      `INSERT INTO agent_skills (id, name, description, prompt, tools, model_role, is_active,
         anti_hallucination_level, test_scenarios, source, plugin_id, hub_slug, hub_url,
         triggers, requires, tags, install, homepage, version, author, emoji)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
       RETURNING *`,
      [
        id,
        data.name,
        data.description ?? "",
        data.prompt,
        tools,
        data.modelRole ?? "main",
        data.isActive !== false,
        data.antiHallucinationLevel ?? null,
        data.testScenarios ? JSON.stringify(data.testScenarios) : null,
        data.source ?? "manual",
        data.pluginId ?? null,
        data.hubSlug ?? null,
        data.hubUrl ?? null,
        data.triggers ?? null,
        data.requires ? JSON.stringify(data.requires) : null,
        data.tags ?? null,
        data.install ? JSON.stringify(data.install) : null,
        data.homepage ?? null,
        data.version ?? null,
        data.author ?? null,
        data.emoji ?? null,
      ],
    );
    return this.mapRow(rows[0]);
  }

  async get(id: string): Promise<AgentSkill | undefined> {
    const { rows } = await this.pool.query(
      "SELECT * FROM agent_skills WHERE id = $1",
      [id],
    );
    return rows[0] ? this.mapRow(rows[0]) : undefined;
  }

  async getByName(name: string): Promise<AgentSkill | undefined> {
    const { rows } = await this.pool.query(
      "SELECT * FROM agent_skills WHERE name = $1",
      [name],
    );
    return rows[0] ? this.mapRow(rows[0]) : undefined;
  }

  async getByNameAndSource(name: string, source: string): Promise<AgentSkill | undefined> {
    const { rows } = await this.pool.query(
      "SELECT * FROM agent_skills WHERE name = $1 AND source = $2",
      [name, source],
    );
    return rows[0] ? this.mapRow(rows[0]) : undefined;
  }

  async listBySource(source: string): Promise<AgentSkill[]> {
    const { rows } = await this.pool.query(
      "SELECT * FROM agent_skills WHERE source = $1 ORDER BY created_at DESC",
      [source],
    );
    return rows.map((r) => this.mapRow(r));
  }

  async listByName(name: string): Promise<AgentSkill[]> {
    const { rows } = await this.pool.query(
      "SELECT * FROM agent_skills WHERE name = $1 ORDER BY source ASC, created_at DESC",
      [name],
    );
    return rows.map((r) => this.mapRow(r));
  }

  async list(): Promise<AgentSkill[]> {
    const { rows } = await this.pool.query(
      "SELECT * FROM agent_skills ORDER BY created_at DESC",
    );
    return rows.map((r) => this.mapRow(r));
  }

  async listActive(): Promise<AgentSkill[]> {
    const { rows } = await this.pool.query(
      "SELECT * FROM agent_skills WHERE is_active = true ORDER BY created_at DESC",
    );
    return rows.map((r) => this.mapRow(r));
  }

  async update(id: string, data: UpdateAgentSkill): Promise<AgentSkill | undefined> {
    const sets: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (data.name !== undefined) { sets.push(`name = $${idx++}`); params.push(data.name); }
    if (data.description !== undefined) { sets.push(`description = $${idx++}`); params.push(data.description); }
    if (data.prompt !== undefined) { sets.push(`prompt = $${idx++}`); params.push(data.prompt); }
    if (data.tools !== undefined) { sets.push(`tools = $${idx++}`); params.push(data.tools); }
    if (data.modelRole !== undefined) { sets.push(`model_role = $${idx++}`); params.push(data.modelRole); }
    if (data.isActive !== undefined) { sets.push(`is_active = $${idx++}`); params.push(data.isActive); }
    if (data.antiHallucinationLevel !== undefined) { sets.push(`anti_hallucination_level = $${idx++}`); params.push(data.antiHallucinationLevel); }
    if (data.testScenarios !== undefined) { sets.push(`test_scenarios = $${idx++}`); params.push(JSON.stringify(data.testScenarios)); }
    if (data.source !== undefined) { sets.push(`source = $${idx++}`); params.push(data.source); }
    if (data.pluginId !== undefined) { sets.push(`plugin_id = $${idx++}`); params.push(data.pluginId); }
    if (data.hubSlug !== undefined) { sets.push(`hub_slug = $${idx++}`); params.push(data.hubSlug); }
    if (data.hubUrl !== undefined) { sets.push(`hub_url = $${idx++}`); params.push(data.hubUrl); }
    if (data.triggers !== undefined) { sets.push(`triggers = $${idx++}`); params.push(data.triggers); }
    if (data.requires !== undefined) { sets.push(`requires = $${idx++}`); params.push(JSON.stringify(data.requires)); }
    if (data.tags !== undefined) { sets.push(`tags = $${idx++}`); params.push(data.tags); }
    if (data.install !== undefined) { sets.push(`install = $${idx++}`); params.push(JSON.stringify(data.install)); }
    if (data.homepage !== undefined) { sets.push(`homepage = $${idx++}`); params.push(data.homepage); }
    if (data.version !== undefined) { sets.push(`version = $${idx++}`); params.push(data.version); }
    if (data.author !== undefined) { sets.push(`author = $${idx++}`); params.push(data.author); }
    if (data.emoji !== undefined) { sets.push(`emoji = $${idx++}`); params.push(data.emoji); }

    if (sets.length === 0) return this.get(id);

    sets.push(`updated_at = now()`);
    params.push(id);

    const { rows } = await this.pool.query(
      `UPDATE agent_skills SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
      params,
    );
    return rows[0] ? this.mapRow(rows[0]) : undefined;
  }

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      "DELETE FROM agent_skills WHERE id = $1",
      [id],
    );
    return (rowCount ?? 0) > 0;
  }

  private mapRow(row: Record<string, unknown>): AgentSkill {
    return {
      id: row.id as string,
      name: row.name as string,
      description: (row.description as string) ?? "",
      prompt: row.prompt as string,
      tools: Array.isArray(row.tools) ? row.tools as string[] : ["*"],
      modelRole: (row.model_role as string) ?? "main",
      isActive: row.is_active as boolean,
      antiHallucinationLevel: (row.anti_hallucination_level as string) ?? undefined,
      testScenarios: row.test_scenarios != null ? (row.test_scenarios as Record<string, unknown>[]) : undefined,
      source: (row.source as string) ?? "manual",
      pluginId: (row.plugin_id as string | null) ?? null,
      hubSlug: (row.hub_slug as string | null) ?? null,
      hubUrl: (row.hub_url as string | null) ?? null,
      triggers: Array.isArray(row.triggers) ? row.triggers as string[] : undefined,
      requires: row.requires != null ? (row.requires as Record<string, unknown>) : undefined,
      tags: Array.isArray(row.tags) ? row.tags as string[] : undefined,
      install: Array.isArray(row.install) ? (row.install as Record<string, unknown>[]) : undefined,
      homepage: (row.homepage as string | null) ?? null,
      version: (row.version as string | null) ?? null,
      author: (row.author as string | null) ?? null,
      emoji: (row.emoji as string | null) ?? null,
      createdAt: row.created_at instanceof Date ? (row.created_at as Date).toISOString() : String(row.created_at),
      updatedAt: row.updated_at instanceof Date ? (row.updated_at as Date).toISOString() : String(row.updated_at),
    };
  }
}
