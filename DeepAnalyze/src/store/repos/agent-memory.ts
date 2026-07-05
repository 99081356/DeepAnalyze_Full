// =============================================================================
// DeepAnalyze - Agent Memory Repository
// Stores universal experience notes (tool techniques, workflow improvements, etc.)
// No user profiling — only generic methodology knowledge.
// =============================================================================

import type { Pool, QueryResult } from 'pg';
import { getPool } from '../pg.js';

export interface AgentMemoryEntry {
  id: string;
  category: 'tool_technique' | 'workflow' | 'convention' | 'lesson_learned';
  content: string;
  source: 'foreground' | 'background_review' | 'curator';
  relevance: number;
  use_count: number;
  created_at: string;
  updated_at: string;
}

export class PgAgentMemoryRepo {
  private pool(): Promise<Pool> {
    return getPool();
  }

  async add(entry: Omit<AgentMemoryEntry, 'id' | 'use_count' | 'created_at' | 'updated_at'>): Promise<AgentMemoryEntry> {
    const p = await this.pool();
    const { rows } = await p.query(
      `INSERT INTO agent_memory (category, content, source, relevance)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [entry.category, entry.content, entry.source, entry.relevance ?? 5],
    );
    return rows[0] ?? this.findByContent(entry.content);
  }

  private async findByContent(content: string): Promise<AgentMemoryEntry | undefined> {
    const p = await this.pool();
    const { rows } = await p.query(
      `SELECT * FROM agent_memory WHERE content = $1 LIMIT 1`,
      [content],
    );
    return rows[0];
  }

  async list(opts?: { category?: string; limit?: number }): Promise<AgentMemoryEntry[]> {
    const p = await this.pool();
    const limit = opts?.limit ?? 50;
    if (opts?.category) {
      const { rows } = await p.query(
        `SELECT * FROM agent_memory WHERE category = $1 ORDER BY relevance DESC, updated_at DESC LIMIT $2`,
        [opts.category, limit],
      );
      return rows;
    }
    const { rows } = await p.query(
      `SELECT * FROM agent_memory ORDER BY relevance DESC, updated_at DESC LIMIT $1`,
      [limit],
    );
    return rows;
  }

  async get(id: string): Promise<AgentMemoryEntry | undefined> {
    const p = await this.pool();
    const { rows } = await p.query(`SELECT * FROM agent_memory WHERE id = $1`, [id]);
    return rows[0];
  }

  async replace(id: string, content: string, category?: string): Promise<AgentMemoryEntry | undefined> {
    const p = await this.pool();
    const fields = category
      ? 'content = $2, category = $3, updated_at = now()'
      : 'content = $2, updated_at = now()';
    const params = category ? [id, content, category] : [id, content];
    const { rows } = await p.query(
      `UPDATE agent_memory SET ${fields} WHERE id = $1 RETURNING *`,
      params,
    );
    return rows[0];
  }

  async remove(id: string): Promise<boolean> {
    const p = await this.pool();
    try {
      const { rowCount } = await p.query(`DELETE FROM agent_memory WHERE id = $1`, [id]);
      return (rowCount ?? 0) > 0;
    } catch {
      // Invalid UUID format or other DB error
      return false;
    }
  }

  async removeAll(): Promise<number> {
    const p = await this.pool();
    const { rowCount } = await p.query(`DELETE FROM agent_memory`);
    return rowCount ?? 0;
  }

  /** Get total character count of all memory entries (for limit checking). */
  async totalChars(): Promise<number> {
    const p = await this.pool();
    const { rows } = await p.query(`SELECT COALESCE(SUM(LENGTH(content)), 0) as total FROM agent_memory`);
    return Number(rows[0].total);
  }

  /** Bump use_count (called when memory is injected into system prompt). */
  async bumpUse(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const p = await this.pool();
    await p.query(
      `UPDATE agent_memory SET use_count = use_count + 1 WHERE id = ANY($1)`,
      [ids],
    );
  }

  /** Count total entries. */
  async count(): Promise<number> {
    const p = await this.pool();
    const { rows } = await p.query(`SELECT COUNT(*) as cnt FROM agent_memory`);
    return Number(rows[0].cnt);
  }
}
