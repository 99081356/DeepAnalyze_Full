// =============================================================================
// DeepAnalyze - Skill Version History Repository
// Tracks every change to skills for rollback/rollforward support.
// =============================================================================

import type { Pool } from 'pg';
import { getPool } from '../pg.js';

export interface SkillVersion {
  id: string;
  skill_id: string;
  version: number;
  prompt: string;
  description: string | null;
  change_type: 'create' | 'update' | 'patch' | 'curator_merge' | 'restore';
  change_source: 'user' | 'foreground' | 'background_review' | 'curator';
  change_summary: string | null;
  diff_patch: string | null;
  created_at: string;
}

export class PgSkillVersionRepo {
  private pool(): Promise<Pool> {
    return getPool();
  }

  /** Create a new version entry. Automatically assigns next version number. */
  async create(entry: {
    skillId: string;
    prompt: string;
    description?: string;
    changeType: SkillVersion['change_type'];
    changeSource: SkillVersion['change_source'];
    changeSummary?: string;
    diffPatch?: string;
  }): Promise<SkillVersion> {
    const p = await this.pool();
    // Get next version number
    const { rows: vRows } = await p.query(
      `SELECT COALESCE(MAX(version), 0) + 1 as next_ver FROM skill_versions WHERE skill_id = $1`,
      [entry.skillId],
    );
    const nextVer = vRows[0].next_ver;

    const { rows } = await p.query(
      `INSERT INTO skill_versions (skill_id, version, prompt, description, change_type, change_source, change_summary, diff_patch)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [entry.skillId, nextVer, entry.prompt, entry.description ?? null,
       entry.changeType, entry.changeSource, entry.changeSummary ?? null, entry.diffPatch ?? null],
    );
    return rows[0];
  }

  /** List all versions for a skill, newest first. */
  async list(skillId: string, opts?: { limit?: number }): Promise<SkillVersion[]> {
    const p = await this.pool();
    const limit = opts?.limit ?? 50;
    const { rows } = await p.query(
      `SELECT * FROM skill_versions WHERE skill_id = $1 ORDER BY version DESC LIMIT $2`,
      [skillId, limit],
    );
    return rows;
  }

  /** Get a specific version. */
  async get(skillId: string, version: number): Promise<SkillVersion | undefined> {
    const p = await this.pool();
    const { rows } = await p.query(
      `SELECT * FROM skill_versions WHERE skill_id = $1 AND version = $2`,
      [skillId, version],
    );
    return rows[0];
  }

  /** Get the latest version. */
  async getLatest(skillId: string): Promise<SkillVersion | undefined> {
    const p = await this.pool();
    const { rows } = await p.query(
      `SELECT * FROM skill_versions WHERE skill_id = $1 ORDER BY version DESC LIMIT 1`,
      [skillId],
    );
    return rows[0];
  }

  /** Get the previous version (before the given one). */
  async getPrevious(skillId: string, version: number): Promise<SkillVersion | undefined> {
    const p = await this.pool();
    const { rows } = await p.query(
      `SELECT * FROM skill_versions WHERE skill_id = $1 AND version < $2 ORDER BY version DESC LIMIT 1`,
      [skillId, version],
    );
    return rows[0];
  }

  /** Compute a simple unified diff between two strings. */
  static simpleDiff(oldText: string, newText: string): string {
    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');
    const maxLen = Math.max(oldLines.length, newLines.length);
    const diffLines: string[] = [];

    // Simple line-level diff
    const oldSet = new Set(oldLines);
    const newSet = new Set(newLines);

    for (const line of newLines) {
      if (!oldSet.has(line)) {
        diffLines.push(`+${line}`);
      }
    }
    for (const line of oldLines) {
      if (!newSet.has(line)) {
        diffLines.push(`-${line}`);
      }
    }

    return diffLines.join('\n');
  }

  /** Count versions for a skill. */
  async count(skillId: string): Promise<number> {
    const p = await this.pool();
    const { rows } = await p.query(
      `SELECT COUNT(*) as cnt FROM skill_versions WHERE skill_id = $1`,
      [skillId],
    );
    return Number(rows[0].cnt);
  }
}
