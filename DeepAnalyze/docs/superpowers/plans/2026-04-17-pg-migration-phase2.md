# PG Migration - Phase 2: Implement PG Repos

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement all 11 new PG repository classes and expand 3 existing ones, then register them in the factory.

**Architecture:** Each repo class takes `pg.Pool` in constructor, implements its interface with parameterized SQL queries. Row mapping handles snake_case → camelCase and JSONB parsing.

**Tech Stack:** TypeScript, `pg` driver

---

### Task 8: Implement PgSessionRepo

**Files:**
- Create: `src/store/repos/session.ts`

- [ ] **Step 1: Create session.ts**

```typescript
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { SessionRepo, Session } from './interfaces';

export class PgSessionRepo implements SessionRepo {
  constructor(private pool: pg.Pool) {}

  async create(title?: string, kbScope?: Record<string, unknown>): Promise<Session> {
    const id = randomUUID();
    const { rows } = await this.pool.query(
      `INSERT INTO sessions (id, title, kb_scope) VALUES ($1, $2, $3) RETURNING *`,
      [id, title ?? null, kbScope ? JSON.stringify(kbScope) : null],
    );
    return this.mapRow(rows[0]);
  }

  async list(): Promise<Session[]> {
    const { rows } = await this.pool.query('SELECT * FROM sessions ORDER BY updated_at DESC');
    return rows.map(r => this.mapRow(r));
  }

  async get(id: string): Promise<Session | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM sessions WHERE id = $1', [id]);
    return rows[0] ? this.mapRow(rows[0]) : undefined;
  }

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('DELETE FROM sessions WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  }

  async updateTimestamp(id: string): Promise<void> {
    await this.pool.query('UPDATE sessions SET updated_at = now() WHERE id = $1', [id]);
  }

  private mapRow(row: any): Session {
    return {
      id: row.id,
      title: row.title,
      kbScope: typeof row.kb_scope === 'string' ? row.kb_scope : row.kb_scope ? JSON.stringify(row.kb_scope) : null,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    };
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/store/repos/session.ts
git commit -m "feat: implement PgSessionRepo"
```

---

### Task 9: Implement PgMessageRepo

**Files:**
- Create: `src/store/repos/message.ts`

- [ ] **Step 1: Create message.ts**

```typescript
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { MessageRepo, Message } from './interfaces';

export class PgMessageRepo implements MessageRepo {
  constructor(private pool: pg.Pool) {}

  async create(sessionId: string, role: string, content: string | null, metadata?: Record<string, unknown>): Promise<Message> {
    const id = randomUUID();
    const { rows } = await this.pool.query(
      `INSERT INTO messages (id, session_id, role, content, metadata) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [id, sessionId, role, content ?? '', metadata ? JSON.stringify(metadata) : null],
    );
    // Also bump session updated_at
    await this.pool.query('UPDATE sessions SET updated_at = now() WHERE id = $1', [sessionId]);
    return this.mapRow(rows[0]);
  }

  async list(sessionId: string): Promise<Message[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM messages WHERE session_id = $1 ORDER BY created_at ASC',
      [sessionId],
    );
    return rows.map(r => this.mapRow(r));
  }

  private mapRow(row: any): Message {
    return {
      id: row.id,
      sessionId: row.session_id,
      role: row.role,
      content: row.content,
      metadata: typeof row.metadata === 'string' ? row.metadata : row.metadata ? JSON.stringify(row.metadata) : null,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    };
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/store/repos/message.ts
git commit -m "feat: implement PgMessageRepo"
```

---

### Task 10: Implement PgKnowledgeBaseRepo

**Files:**
- Create: `src/store/repos/knowledge-base.ts`

- [ ] **Step 1: Create knowledge-base.ts**

```typescript
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { KnowledgeBaseRepo, KnowledgeBase } from './interfaces';

export class PgKnowledgeBaseRepo implements KnowledgeBaseRepo {
  constructor(private pool: pg.Pool) {}

  async create(name: string, ownerId: string, description?: string, visibility?: string): Promise<KnowledgeBase> {
    const id = randomUUID();
    const { rows } = await this.pool.query(
      `INSERT INTO knowledge_bases (id, name, description, owner_id, visibility) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [id, name, description ?? null, ownerId, visibility ?? 'private'],
    );
    return this.mapRow(rows[0]);
  }

  async get(id: string): Promise<KnowledgeBase | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM knowledge_bases WHERE id = $1', [id]);
    return rows[0] ? this.mapRow(rows[0]) : undefined;
  }

  async list(): Promise<KnowledgeBase[]> {
    const { rows } = await this.pool.query('SELECT * FROM knowledge_bases ORDER BY created_at DESC');
    return rows.map(r => this.mapRow(r));
  }

  async update(id: string, fields: { name?: string; description?: string; visibility?: string }): Promise<KnowledgeBase | undefined> {
    const sets: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (fields.name !== undefined) { sets.push(`name = $${idx++}`); values.push(fields.name); }
    if (fields.description !== undefined) { sets.push(`description = $${idx++}`); values.push(fields.description); }
    if (fields.visibility !== undefined) { sets.push(`visibility = $${idx++}`); values.push(fields.visibility); }

    if (sets.length === 0) return this.get(id);

    sets.push(`updated_at = now()`);
    values.push(id);

    const { rowCount } = await this.pool.query(
      `UPDATE knowledge_bases SET ${sets.join(', ')} WHERE id = $${idx}`,
      values,
    );
    if ((rowCount ?? 0) === 0) return undefined;
    return this.get(id);
  }

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('DELETE FROM knowledge_bases WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  }

  async getAnyId(): Promise<string | undefined> {
    const { rows } = await this.pool.query('SELECT id FROM knowledge_bases LIMIT 1');
    return rows[0]?.id;
  }

  private mapRow(row: any): KnowledgeBase {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      ownerId: row.owner_id,
      visibility: row.visibility,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    };
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/store/repos/knowledge-base.ts
git commit -m "feat: implement PgKnowledgeBaseRepo"
```

---

### Task 11: Implement PgWikiLinkRepo

**Files:**
- Create: `src/store/repos/wiki-link.ts`

- [ ] **Step 1: Create wiki-link.ts**

```typescript
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { WikiLinkRepo, WikiLink, WikiPageSummary } from './interfaces';

export class PgWikiLinkRepo implements WikiLinkRepo {
  constructor(private pool: pg.Pool) {}

  async create(sourcePageId: string, targetPageId: string, linkType: string, entityName?: string, context?: string): Promise<WikiLink> {
    const id = randomUUID();
    const { rows } = await this.pool.query(
      `INSERT INTO wiki_links (id, source_page_id, target_page_id, link_type, entity_name, context) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [id, sourcePageId, targetPageId, linkType, entityName ?? null, context ?? null],
    );
    return this.mapRow(rows[0]);
  }

  async getOutgoing(pageId: string): Promise<WikiLink[]> {
    const { rows } = await this.pool.query('SELECT * FROM wiki_links WHERE source_page_id = $1', [pageId]);
    return rows.map(r => this.mapRow(r));
  }

  async getIncoming(pageId: string): Promise<WikiLink[]> {
    const { rows } = await this.pool.query('SELECT * FROM wiki_links WHERE target_page_id = $1', [pageId]);
    return rows.map(r => this.mapRow(r));
  }

  async deleteByPageId(pageId: string): Promise<void> {
    await this.pool.query(
      'DELETE FROM wiki_links WHERE source_page_id = $1 OR target_page_id = $1',
      [pageId],
    );
  }

  async findExisting(sourcePageId: string, targetPageId: string, linkType: string, entityName?: string): Promise<WikiLink | undefined> {
    const { rows } = await this.pool.query(
      'SELECT * FROM wiki_links WHERE source_page_id = $1 AND target_page_id = $2 AND link_type = $3',
      [sourcePageId, targetPageId, linkType],
    );
    return rows[0] ? this.mapRow(rows[0]) : undefined;
  }

  async findEntityLinksByKb(kbId: string): Promise<Array<{ sourcePageId: string; entityName: string }>> {
    const { rows } = await this.pool.query(
      `SELECT DISTINCT wl.source_page_id AS "sourcePageId", wl.entity_name AS "entityName"
       FROM wiki_links wl JOIN wiki_pages wp ON wp.id = wl.source_page_id
       WHERE wp.kb_id = $1 AND wl.link_type = 'entity_ref'`,
      [kbId],
    );
    return rows;
  }

  async findRelatedByEntity(kbId: string, entityName: string): Promise<WikiPageSummary[]> {
    const { rows } = await this.pool.query(
      `SELECT DISTINCT wp.id, wp.kb_id AS "kbId", wp.doc_id AS "docId", wp.page_type AS "pageType", wp.title, wp.file_path AS "filePath"
       FROM wiki_pages wp JOIN wiki_links wl ON wl.source_page_id = wp.id
       WHERE wp.kb_id = $1 AND wl.entity_name = $2`,
      [kbId, entityName],
    );
    return rows;
  }

  private mapRow(row: any): WikiLink {
    return {
      id: row.id,
      sourcePageId: row.source_page_id,
      targetPageId: row.target_page_id,
      linkType: row.link_type,
      entityName: row.entity_name,
      context: row.context,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    };
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/store/repos/wiki-link.ts
git commit -m "feat: implement PgWikiLinkRepo"
```

---

### Task 12: Implement PgSettingsRepo

**Files:**
- Create: `src/store/repos/settings.ts`

- [ ] **Step 1: Create settings.ts**

```typescript
import pg from 'pg';
import type { SettingsRepo } from './interfaces';

const EMPTY_PROVIDER_DEFAULTS = {
  main: '', summarizer: '', embedding: '', vlm: '', tts: '', image_gen: '', video_gen: '', music_gen: '',
};

export class PgSettingsRepo implements SettingsRepo {
  constructor(private pool: pg.Pool) {}

  async get(key: string): Promise<string | null> {
    const { rows } = await this.pool.query('SELECT value FROM settings WHERE key = $1', [key]);
    if (!rows[0]) return null;
    const raw = rows[0].value;
    return typeof raw === 'string' ? raw : JSON.stringify(raw);
  }

  async set(key: string, value: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = now()`,
      [key, value],
    );
  }

  async delete(key: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('DELETE FROM settings WHERE key = $1', [key]);
    return (rowCount ?? 0) > 0;
  }

  async getProviderSettings(): Promise<any> {
    const raw = await this.get('providers');
    if (!raw) return { providers: [], defaults: { ...EMPTY_PROVIDER_DEFAULTS } };
    try {
      const settings = JSON.parse(raw);
      settings.defaults = { ...EMPTY_PROVIDER_DEFAULTS, ...settings.defaults };
      return settings;
    } catch {
      return { providers: [], defaults: { ...EMPTY_PROVIDER_DEFAULTS } };
    }
  }

  async saveProviderSettings(settings: any): Promise<void> {
    await this.set('providers', JSON.stringify(settings));
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/store/repos/settings.ts
git commit -m "feat: implement PgSettingsRepo"
```

---

### Task 13: Implement remaining 6 repos in parallel

**Files:**
- Create: `src/store/repos/report.ts`
- Create: `src/store/repos/agent-team.ts`
- Create: `src/store/repos/cron-job.ts`
- Create: `src/store/repos/plugin.ts`
- Create: `src/store/repos/skill.ts`
- Create: `src/store/repos/session-memory.ts`
- Create: `src/store/repos/agent-task.ts`

- [ ] **Step 1: Create report.ts**

```typescript
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { ReportRepo, Report, ReportReference, ReportWithReferences, CreateReportData } from './interfaces';

export class PgReportRepo implements ReportRepo {
  constructor(private pool: pg.Pool) {}

  async create(data: CreateReportData): Promise<ReportWithReferences> {
    const id = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO reports (id, session_id, message_id, title, clean_content, raw_content, entities) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, data.sessionId, data.messageId, data.title, data.cleanContent, data.rawContent, JSON.stringify(data.entities ?? [])],
      );
      const refs: ReportReference[] = [];
      if (data.references) {
        for (const ref of data.references) {
          const { rows } = await client.query(
            `INSERT INTO report_references (report_id, ref_index, doc_id, page_id, title, level, snippet, highlight) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
            [id, ref.refIndex, ref.docId, ref.pageId, ref.title, ref.level, ref.snippet, ref.highlight],
          );
          refs.push({ ...ref, id: rows[0].id, reportId: id });
        }
      }
      await client.query('COMMIT');
      const report = await this.get(id);
      return report!;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async get(id: string): Promise<ReportWithReferences | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM reports WHERE id = $1', [id]);
    if (!rows[0]) return undefined;
    const report = this.mapReport(rows[0]);
    const { rows: refRows } = await this.pool.query(
      'SELECT * FROM report_references WHERE report_id = $1 ORDER BY ref_index', [id],
    );
    return { ...report, references: refRows.map(this.mapRef) };
  }

  async getByMessageId(messageId: string): Promise<ReportWithReferences | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM reports WHERE message_id = $1', [messageId]);
    if (!rows[0]) return undefined;
    return this.get(rows[0].id);
  }

  async list(limit: number = 20, offset: number = 0): Promise<Report[]> {
    const { rows } = await this.pool.query('SELECT * FROM reports ORDER BY created_at DESC LIMIT $1 OFFSET $2', [limit, offset]);
    return rows.map(r => this.mapReport(r));
  }

  async listBySession(sessionId: string): Promise<Report[]> {
    const { rows } = await this.pool.query('SELECT * FROM reports WHERE session_id = $1 ORDER BY created_at DESC', [sessionId]);
    return rows.map(r => this.mapReport(r));
  }

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('DELETE FROM reports WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  }

  private mapReport(row: any): Report {
    let entities: string[] = [];
    try {
      const parsed = typeof row.entities === 'string' ? JSON.parse(row.entities) : row.entities;
      entities = Array.isArray(parsed) ? parsed : [];
    } catch {}
    return {
      id: row.id, sessionId: row.session_id, messageId: row.message_id,
      title: row.title, cleanContent: row.clean_content, rawContent: row.raw_content,
      entities, createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    };
  }

  private mapRef(row: any): ReportReference {
    return {
      id: row.id, reportId: row.report_id, refIndex: row.ref_index,
      docId: row.doc_id, pageId: row.page_id, title: row.title,
      level: row.level, snippet: row.snippet, highlight: row.highlight,
    };
  }
}
```

- [ ] **Step 2: Create agent-team.ts**

```typescript
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { AgentTeamRepo, AgentTeam, AgentTeamMember, AgentTeamWithMembers, CreateTeamData, UpdateTeamData, TeamMode } from './interfaces';

export class PgAgentTeamRepo implements AgentTeamRepo {
  constructor(private pool: pg.Pool) {}

  async create(data: CreateTeamData): Promise<AgentTeamWithMembers> {
    const teamId = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO agent_teams (id, name, description, mode, is_active, cross_review, enable_skills, model_config) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [teamId, data.name, data.description, data.mode, data.isActive !== false, data.crossReview ?? false, data.enableSkills ?? false, data.modelConfig ? JSON.stringify(data.modelConfig) : null],
      );
      const members: AgentTeamMember[] = [];
      for (const m of (data.members ?? [])) {
        const mId = randomUUID();
        await client.query(
          `INSERT INTO agent_team_members (id, team_id, role, system_prompt, task, perspective, depends_on, condition_config, tools, sort_order) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [mId, teamId, m.role, m.systemPrompt ?? null, m.task, m.perspective ?? null, JSON.stringify(m.dependsOn ?? []), m.condition ? JSON.stringify(m.condition) : null, JSON.stringify(m.tools ?? []), m.sortOrder ?? 0],
        );
        members.push({ id: mId, teamId, role: m.role, systemPrompt: m.systemPrompt, task: m.task, perspective: m.perspective, dependsOn: m.dependsOn ?? [], condition: m.condition, tools: m.tools ?? [], sortOrder: m.sortOrder ?? 0 });
      }
      await client.query('COMMIT');
      return { ...(await this.mapTeam((await this.pool.query('SELECT * FROM agent_teams WHERE id = $1', [teamId])).rows[0]))!, members };
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  }

  async get(id: string): Promise<AgentTeamWithMembers | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM agent_teams WHERE id = $1', [id]);
    if (!rows[0]) return undefined;
    const team = this.mapTeam(rows[0])!;
    const { rows: mRows } = await this.pool.query('SELECT * FROM agent_team_members WHERE team_id = $1 ORDER BY sort_order', [id]);
    return { ...team, members: mRows.map(r => this.mapMember(r)) };
  }

  async getByName(name: string): Promise<AgentTeamWithMembers | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM agent_teams WHERE name = $1', [name]);
    if (!rows[0]) return undefined;
    return this.get(rows[0].id);
  }

  async list(): Promise<AgentTeam[]> {
    const { rows } = await this.pool.query('SELECT * FROM agent_teams ORDER BY updated_at DESC');
    return rows.map(r => this.mapTeam(r)!);
  }

  async update(id: string, data: UpdateTeamData): Promise<AgentTeamWithMembers | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const sets: string[] = [];
      const vals: any[] = [];
      let i = 1;
      if (data.name !== undefined) { sets.push(`name = $${i++}`); vals.push(data.name); }
      if (data.description !== undefined) { sets.push(`description = $${i++}`); vals.push(data.description); }
      if (data.mode !== undefined) { sets.push(`mode = $${i++}`); vals.push(data.mode); }
      if (data.isActive !== undefined) { sets.push(`is_active = $${i++}`); vals.push(data.isActive); }
      if (data.crossReview !== undefined) { sets.push(`cross_review = $${i++}`); vals.push(data.crossReview); }
      if (data.enableSkills !== undefined) { sets.push(`enable_skills = $${i++}`); vals.push(data.enableSkills); }
      if (data.modelConfig !== undefined) { sets.push(`model_config = $${i++}`); vals.push(data.modelConfig ? JSON.stringify(data.modelConfig) : null); }
      sets.push(`updated_at = now()`);
      vals.push(id);
      await client.query(`UPDATE agent_teams SET ${sets.join(', ')} WHERE id = $${i}`, vals);
      if (data.members !== undefined) {
        await client.query('DELETE FROM agent_team_members WHERE team_id = $1', [id]);
        for (const m of data.members) {
          const mId = randomUUID();
          await client.query(
            `INSERT INTO agent_team_members (id, team_id, role, system_prompt, task, perspective, depends_on, condition_config, tools, sort_order) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [mId, id, m.role, m.systemPrompt ?? null, m.task, m.perspective ?? null, JSON.stringify(m.dependsOn ?? []), m.condition ? JSON.stringify(m.condition) : null, JSON.stringify(m.tools ?? []), m.sortOrder ?? 0],
          );
        }
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
    return this.get(id);
  }

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('DELETE FROM agent_teams WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  }

  private mapTeam(row: any): AgentTeam | undefined {
    if (!row) return undefined;
    let modelConfig: Record<string, unknown> | undefined;
    try { modelConfig = row.model_config ? (typeof row.model_config === 'string' ? JSON.parse(row.model_config) : row.model_config) : undefined; } catch {}
    return {
      id: row.id, name: row.name, description: row.description, mode: row.mode as TeamMode,
      isActive: row.is_active, crossReview: row.cross_review, enableSkills: row.enable_skills,
      modelConfig, createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    };
  }

  private mapMember(row: any): AgentTeamMember {
    let dependsOn: string[] = [];
    try { const p = typeof row.depends_on === 'string' ? JSON.parse(row.depends_on) : row.depends_on; dependsOn = Array.isArray(p) ? p : []; } catch {}
    let condition: Record<string, unknown> | undefined;
    try { condition = row.condition_config ? (typeof row.condition_config === 'string' ? JSON.parse(row.condition_config) : row.condition_config) : undefined; } catch {}
    let tools: string[] = [];
    try { const p = typeof row.tools === 'string' ? JSON.parse(row.tools) : row.tools; tools = Array.isArray(p) ? p : []; } catch {}
    return {
      id: row.id, teamId: row.team_id, role: row.role, systemPrompt: row.system_prompt ?? undefined,
      task: row.task, perspective: row.perspective ?? undefined, dependsOn, condition, tools, sortOrder: row.sort_order,
    };
  }
}
```

- [ ] **Step 3: Create cron-job.ts**

```typescript
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { CronJobRepo, CronJob, NewCronJob } from './interfaces';

export class PgCronJobRepo implements CronJobRepo {
  constructor(private pool: pg.Pool) {}

  async create(job: NewCronJob): Promise<CronJob> {
    const id = randomUUID();
    const { rows } = await this.pool.query(
      `INSERT INTO cron_jobs (id, name, schedule, message, enabled, channel, chat_id, deliver_response, next_run) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [id, job.name, job.schedule, job.message, job.enabled ?? true, job.channel ?? null, job.chatId ?? null, job.deliverResponse ?? false, job.nextRun ?? null],
    );
    return this.mapRow(rows[0]);
  }

  async get(id: string): Promise<CronJob | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM cron_jobs WHERE id = $1', [id]);
    return rows[0] ? this.mapRow(rows[0]) : undefined;
  }

  async list(): Promise<CronJob[]> {
    const { rows } = await this.pool.query('SELECT * FROM cron_jobs ORDER BY created_at DESC');
    return rows.map(r => this.mapRow(r));
  }

  async update(id: string, fields: Partial<CronJob>): Promise<void> {
    const sets: string[] = [];
    const vals: any[] = [];
    let i = 1;
    const allowedKeys: Record<string, string> = { name: 'name', schedule: 'schedule', message: 'message', enabled: 'enabled', channel: 'channel', chatId: 'chat_id', deliverResponse: 'deliver_response' };
    for (const [camelKey, pgCol] of Object.entries(allowedKeys)) {
      if ((fields as any)[camelKey] !== undefined) { sets.push(`${pgCol} = $${i++}`); vals.push((fields as any)[camelKey]); }
    }
    if (fields.nextRun !== undefined) { sets.push(`next_run = $${i++}`); vals.push(fields.nextRun); }
    sets.push(`updated_at = now()`);
    vals.push(id);
    if (sets.length > 1) await this.pool.query(`UPDATE cron_jobs SET ${sets.join(', ')} WHERE id = $${i}`, vals);
  }

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('DELETE FROM cron_jobs WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  }

  async getDueJobs(now: Date): Promise<CronJob[]> {
    const { rows } = await this.pool.query('SELECT * FROM cron_jobs WHERE enabled = true AND next_run <= $1', [now.toISOString()]);
    return rows.map(r => this.mapRow(r));
  }

  async markCompleted(id: string, nextRun: Date): Promise<void> {
    await this.pool.query(
      `UPDATE cron_jobs SET last_run = now(), last_status = 'success', last_error = NULL, run_count = run_count + 1, next_run = $2, updated_at = now() WHERE id = $1`,
      [id, nextRun.toISOString()],
    );
  }

  async markFailed(id: string, error: string, nextRun: Date): Promise<void> {
    await this.pool.query(
      `UPDATE cron_jobs SET last_run = now(), last_status = 'failed', last_error = $2, run_count = run_count + 1, error_count = error_count + 1, next_run = $3, updated_at = now() WHERE id = $1`,
      [id, error, nextRun.toISOString()],
    );
  }

  private mapRow(row: any): CronJob {
    return {
      id: row.id, name: row.name, schedule: row.schedule, message: row.message,
      enabled: row.enabled, channel: row.channel, chatId: row.chat_id,
      deliverResponse: row.deliver_response, lastRun: row.last_run?.toISOString?.() ?? row.last_run ?? undefined,
      nextRun: row.next_run?.toISOString?.() ?? row.next_run ?? undefined,
      lastStatus: row.last_status, lastError: row.last_error,
      runCount: row.run_count ?? 0, errorCount: row.error_count ?? 0,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    };
  }
}
```

- [ ] **Step 4: Create plugin.ts**

```typescript
import pg from 'pg';
import type { PluginRepo, Plugin, NewPlugin } from './interfaces';

export class PgPluginRepo implements PluginRepo {
  constructor(private pool: pg.Pool) {}

  async upsert(plugin: NewPlugin): Promise<void> {
    await this.pool.query(
      `INSERT INTO plugins (id, name, version, enabled, config) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, version = EXCLUDED.version, enabled = EXCLUDED.enabled, config = EXCLUDED.config`,
      [plugin.id, plugin.name, plugin.version ?? '0.0.1', plugin.enabled ?? true, plugin.config ? JSON.stringify(plugin.config) : null],
    );
  }

  async get(id: string): Promise<Plugin | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM plugins WHERE id = $1', [id]);
    return rows[0] ? this.mapRow(rows[0]) : undefined;
  }

  async list(): Promise<Plugin[]> {
    const { rows } = await this.pool.query('SELECT * FROM plugins ORDER BY created_at');
    return rows.map(r => this.mapRow(r));
  }

  async updateEnabled(id: string, enabled: boolean): Promise<void> {
    await this.pool.query('UPDATE plugins SET enabled = $1 WHERE id = $2', [enabled, id]);
  }

  async updateConfig(id: string, config: Record<string, unknown>): Promise<void> {
    await this.pool.query('UPDATE plugins SET config = $1 WHERE id = $2', [JSON.stringify(config), id]);
  }

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('DELETE FROM plugins WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  }

  private mapRow(row: any): Plugin {
    return {
      id: row.id, name: row.name, version: row.version ?? '0.0.1', enabled: row.enabled,
      config: typeof row.config === 'string' ? JSON.parse(row.config) : row.config,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    };
  }
}
```

- [ ] **Step 5: Create skill.ts**

```typescript
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { SkillRepo, Skill, NewSkill } from './interfaces';

export class PgSkillRepo implements SkillRepo {
  constructor(private pool: pg.Pool) {}

  async create(skill: NewSkill): Promise<Skill> {
    const { rows } = await this.pool.query(
      `INSERT INTO skills (id, name, plugin_id, description, config) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [skill.id, skill.name, skill.pluginId, skill.description ?? null, skill.config ? JSON.stringify(skill.config) : null],
    );
    return this.mapRow(rows[0]);
  }

  async get(id: string): Promise<Skill | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM skills WHERE id = $1', [id]);
    return rows[0] ? this.mapRow(rows[0]) : undefined;
  }

  async list(pluginId?: string): Promise<Skill[]> {
    if (pluginId) {
      const { rows } = await this.pool.query('SELECT * FROM skills WHERE plugin_id = $1 ORDER BY created_at DESC', [pluginId]);
      return rows.map(r => this.mapRow(r));
    }
    const { rows } = await this.pool.query('SELECT * FROM skills ORDER BY created_at DESC');
    return rows.map(r => this.mapRow(r));
  }

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('DELETE FROM skills WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  }

  private mapRow(row: any): Skill {
    return {
      id: row.id, name: row.name, pluginId: row.plugin_id, description: row.description ?? undefined,
      config: typeof row.config === 'string' ? JSON.parse(row.config) : row.config,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    };
  }
}
```

- [ ] **Step 6: Create session-memory.ts**

```typescript
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { SessionMemoryRepo, SessionMemory } from './interfaces';

export class PgSessionMemoryRepo implements SessionMemoryRepo {
  constructor(private pool: pg.Pool) {}

  async load(sessionId: string): Promise<SessionMemory | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM session_memory WHERE session_id = $1', [sessionId]);
    return rows[0] ? this.mapRow(rows[0]) : undefined;
  }

  async save(sessionId: string, content: string, tokenCount: number, lastTokenPosition: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO session_memory (id, session_id, content, token_count, last_token_position) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (session_id) DO UPDATE SET content = $3, token_count = $4, last_token_position = $5, updated_at = now()`,
      [randomUUID(), sessionId, content, tokenCount, lastTokenPosition],
    );
  }

  async listRecent(limit: number): Promise<Array<{ sessionId: string; content: string }>> {
    const { rows } = await this.pool.query(
      'SELECT session_id, content FROM session_memory ORDER BY updated_at DESC LIMIT $1', [limit],
    );
    return rows.map(r => ({ sessionId: r.session_id, content: r.content }));
  }

  private mapRow(row: any): SessionMemory {
    return {
      id: row.id, sessionId: row.session_id, content: row.content,
      tokenCount: row.token_count, lastTokenPosition: row.last_token_position,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    };
  }
}
```

- [ ] **Step 7: Create agent-task.ts**

```typescript
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { AgentTaskRepo, AgentTask, NewAgentTask } from './interfaces';

export class PgAgentTaskRepo implements AgentTaskRepo {
  constructor(private pool: pg.Pool) {}

  async create(data: NewAgentTask): Promise<AgentTask> {
    const id = randomUUID();
    const { rows } = await this.pool.query(
      `INSERT INTO agent_tasks (id, parent_task_id, session_id, agent_type, status, input) VALUES ($1, $2, $3, $4, 'pending', $5) RETURNING *`,
      [id, data.parentTaskId ?? null, data.sessionId ?? null, data.agentType, data.input ? JSON.stringify(data.input) : null],
    );
    return this.mapRow(rows[0]);
  }

  async updateStatus(id: string, status: string, output?: unknown, error?: string): Promise<void> {
    if (status === 'completed' || status === 'failed') {
      await this.pool.query(
        'UPDATE agent_tasks SET status = $1, output = $2, error = $3, completed_at = now() WHERE id = $4',
        [status, output ? JSON.stringify(output) : null, error ?? null, id],
      );
    } else {
      await this.pool.query('UPDATE agent_tasks SET status = $1 WHERE id = $2', [status, id]);
    }
  }

  async get(id: string): Promise<AgentTask | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM agent_tasks WHERE id = $1', [id]);
    return rows[0] ? this.mapRow(rows[0]) : undefined;
  }

  async listBySession(sessionId: string): Promise<AgentTask[]> {
    const { rows } = await this.pool.query('SELECT * FROM agent_tasks WHERE session_id = $1 ORDER BY created_at DESC', [sessionId]);
    return rows.map(r => this.mapRow(r));
  }

  private mapRow(row: any): AgentTask {
    return {
      id: row.id, parentTaskId: row.parent_task_id, sessionId: row.session_id,
      agentType: row.agent_type, status: row.status,
      input: typeof row.input === 'string' ? JSON.parse(row.input) : row.input,
      output: typeof row.output === 'string' ? JSON.parse(row.output) : row.output,
      error: row.error,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      completedAt: row.completed_at?.toISOString?.() ?? row.completed_at ?? null,
    };
  }
}
```

- [ ] **Step 8: Commit all repos**

```bash
git add src/store/repos/report.ts src/store/repos/agent-team.ts src/store/repos/cron-job.ts src/store/repos/plugin.ts src/store/repos/skill.ts src/store/repos/session-memory.ts src/store/repos/agent-task.ts
git commit -m "feat: implement remaining 7 PG repo classes"
```

---

### Task 14: Expand existing repos (WikiPageRepo, EmbeddingRepo, DocumentRepo)

**Files:**
- Modify: `src/store/repos/wiki-page.ts`
- Modify: `src/store/repos/embedding.ts`
- Modify: `src/store/repos/document.ts`

- [ ] **Step 1: Add findByTitle to PgWikiPageRepo**

Add method to `wiki-page.ts` before the `private mapRow`:

```typescript
  async findByTitle(kbId: string, title: string, pageType: string): Promise<WikiPage | undefined> {
    const { rows } = await this.pool.query(
      'SELECT * FROM wiki_pages WHERE kb_id = $1 AND title = $2 AND page_type = $3 LIMIT 1',
      [kbId, title, pageType],
    );
    return rows[0] ? this.mapRow(rows[0]) : undefined;
  }
```

- [ ] **Step 2: Add stale methods to PgEmbeddingRepo**

Add methods to `embedding.ts` before `private mapRow`:

```typescript
  async markAllStale(): Promise<void> {
    await this.pool.query('UPDATE embeddings SET stale = true');
  }

  async getStaleCount(): Promise<number> {
    const { rows } = await this.pool.query('SELECT COUNT(*)::int as cnt FROM embeddings WHERE stale = true');
    return rows[0].cnt;
  }
```

- [ ] **Step 3: Add updateStatusWithProcessing to PgDocumentRepo**

Add method to `document.ts` before `private mapRow`:

```typescript
  async updateStatusWithProcessing(id: string, status: string, step: string, progress: number, error?: string): Promise<void> {
    await this.pool.query(
      'UPDATE documents SET status = $1, processing_step = $2, processing_progress = $3, processing_error = $4 WHERE id = $5',
      [status, step, progress, error ?? null, id],
    );
  }
```

- [ ] **Step 4: Commit**

```bash
git add src/store/repos/wiki-page.ts src/store/repos/embedding.ts src/store/repos/document.ts
git commit -m "feat: expand WikiPageRepo, EmbeddingRepo, DocumentRepo with new methods"
```

---

### Task 15: Register all repos in factory

**Files:**
- Modify: `src/store/repos/index.ts`

- [ ] **Step 1: Add imports for all new repo classes and update factory**

Add imports at top of `index.ts`:

```typescript
import { PgSessionRepo } from './session';
import { PgMessageRepo } from './message';
import { PgKnowledgeBaseRepo } from './knowledge-base';
import { PgWikiLinkRepo } from './wiki-link';
import { PgSettingsRepo } from './settings';
import { PgReportRepo } from './report';
import { PgAgentTeamRepo } from './agent-team';
import { PgCronJobRepo } from './cron-job';
import { PgPluginRepo } from './plugin';
import { PgSkillRepo } from './skill';
import { PgSessionMemoryRepo } from './session-memory';
import { PgAgentTaskRepo } from './agent-task';
```

Replace the placeholder `null as any` entries in `cachedRepos`:

```typescript
      cachedRepos = {
        vectorSearch: new PgVectorSearchRepo(pool),
        ftsSearch: new PgFTSSearchRepo(pool),
        anchor: new PgAnchorRepo(pool),
        wikiPage: new PgWikiPageRepo(pool),
        document: new PgDocumentRepo(pool),
        embedding: new PgEmbeddingRepo(pool),
        session: new PgSessionRepo(pool),
        message: new PgMessageRepo(pool),
        knowledgeBase: new PgKnowledgeBaseRepo(pool),
        wikiLink: new PgWikiLinkRepo(pool),
        settings: new PgSettingsRepo(pool),
        report: new PgReportRepo(pool),
        agentTeam: new PgAgentTeamRepo(pool),
        cronJob: new PgCronJobRepo(pool),
        plugin: new PgPluginRepo(pool),
        skill: new PgSkillRepo(pool),
        sessionMemory: new PgSessionMemoryRepo(pool),
        agentTask: new PgAgentTaskRepo(pool),
      };
```

- [ ] **Step 2: Commit**

```bash
git add src/store/repos/index.ts
git commit -m "feat: register all 17 repos in factory"
```

---

## Phase 2 Summary

After Phase 2:
- All 17 PG repo implementations exist
- Factory `getRepos()` returns a fully populated RepoSet
- All repos are async, use parameterized queries, handle snake_case mapping

**Next:** Phase 3 migrates consumer files to use the new repos instead of direct SQLite calls.
