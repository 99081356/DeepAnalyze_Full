// =============================================================================
// DeepAnalyze - Skill Usage Telemetry Repository
// Tracks skill usage for Curator lifecycle decisions.
// =============================================================================

import type { Pool } from 'pg';
import { getPool } from '../pg.js';

export interface SkillUsageRecord {
  skill_id: string;
  created_by: 'user' | 'agent';
  use_count: number;
  patch_count: number;
  last_used_at: string | null;
  last_patched_at: string | null;
  created_at: string;
  state: 'active' | 'stale' | 'archived';
  pinned: boolean;
}

export class PgSkillUsageRepo {
  private pool(): Promise<Pool> {
    return getPool();
  }

  private async ensureRecord(skillId: string): Promise<SkillUsageRecord> {
    const p = await this.pool();
    const { rows } = await p.query(
      `INSERT INTO skill_usage (skill_id) VALUES ($1)
       ON CONFLICT (skill_id) DO NOTHING
       RETURNING *`,
      [skillId],
    );
    if (rows[0]) return rows[0];
    return this.get(skillId) as Promise<SkillUsageRecord>;
  }

  async get(skillId: string): Promise<SkillUsageRecord | undefined> {
    const p = await this.pool();
    const { rows } = await p.query(`SELECT * FROM skill_usage WHERE skill_id = $1`, [skillId]);
    return rows[0];
  }

  async bumpUse(skillId: string): Promise<void> {
    await this.ensureRecord(skillId);
    const p = await this.pool();
    await p.query(
      `UPDATE skill_usage SET use_count = use_count + 1, last_used_at = now() WHERE skill_id = $1`,
      [skillId],
    );
  }

  async bumpPatch(skillId: string): Promise<void> {
    await this.ensureRecord(skillId);
    const p = await this.pool();
    await p.query(
      `UPDATE skill_usage SET patch_count = patch_count + 1, last_patched_at = now() WHERE skill_id = $1`,
      [skillId],
    );
  }

  async markAgentCreated(skillId: string): Promise<void> {
    await this.ensureRecord(skillId);
    const p = await this.pool();
    await p.query(
      `UPDATE skill_usage SET created_by = 'agent' WHERE skill_id = $1`,
      [skillId],
    );
  }

  async setState(skillId: string, state: string): Promise<void> {
    const p = await this.pool();
    await p.query(
      `UPDATE skill_usage SET state = $2 WHERE skill_id = $1`,
      [skillId, state],
    );
  }

  async setPinned(skillId: string, pinned: boolean): Promise<void> {
    const p = await this.pool();
    await p.query(
      `UPDATE skill_usage SET pinned = $2 WHERE skill_id = $1`,
      [skillId, pinned],
    );
  }

  /** List all agent-created active skills (for Curator). */
  async listAgentCreated(opts?: { state?: string }): Promise<SkillUsageRecord[]> {
    const p = await this.pool();
    if (opts?.state) {
      const { rows } = await p.query(
        `SELECT * FROM skill_usage WHERE created_by = 'agent' AND state = $1 ORDER BY last_used_at DESC NULLS LAST`,
        [opts.state],
      );
      return rows;
    }
    const { rows } = await p.query(
      `SELECT * FROM skill_usage WHERE created_by = 'agent' AND state != 'archived' ORDER BY last_used_at DESC NULLS LAST`,
    );
    return rows;
  }

  /** Find skills that haven't been used in N days (for auto-transition). */
  async findStale(staleAfterDays: number): Promise<SkillUsageRecord[]> {
    const p = await this.pool();
    const { rows } = await p.query(
      `SELECT * FROM skill_usage
       WHERE created_by = 'agent'
         AND state = 'active'
         AND pinned = false
         AND (last_used_at IS NULL OR last_used_at < now() - ($1 || ' days')::interval)
         AND created_at < now() - ($1 || ' days')::interval`,
      [String(staleAfterDays)],
    );
    return rows;
  }

  async findArchivable(archiveAfterDays: number): Promise<SkillUsageRecord[]> {
    const p = await this.pool();
    const { rows } = await p.query(
      `SELECT * FROM skill_usage
       WHERE created_by = 'agent'
         AND state = 'stale'
         AND pinned = false
         AND (last_used_at IS NULL OR last_used_at < now() - ($1 || ' days')::interval)
         AND created_at < now() - ($1 || ' days')::interval`,
      [String(archiveAfterDays)],
    );
    return rows;
  }

  /** Delete record when skill is removed. */
  async forget(skillId: string): Promise<void> {
    const p = await this.pool();
    await p.query(`DELETE FROM skill_usage WHERE skill_id = $1`, [skillId]);
  }

  async count(): Promise<{ active: number; stale: number; archived: number; agentCreated: number }> {
    const p = await this.pool();
    const { rows } = await p.query(
      `SELECT
        COUNT(*) FILTER (WHERE state = 'active') as active,
        COUNT(*) FILTER (WHERE state = 'stale') as stale,
        COUNT(*) FILTER (WHERE state = 'archived') as archived,
        COUNT(*) FILTER (WHERE created_by = 'agent') as agent_created
       FROM skill_usage`,
    );
    return {
      active: Number(rows[0].active),
      stale: Number(rows[0].stale),
      archived: Number(rows[0].archived),
      agentCreated: Number(rows[0].agent_created),
    };
  }
}
