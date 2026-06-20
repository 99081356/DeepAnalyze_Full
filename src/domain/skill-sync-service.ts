/**
 * SkillSyncService — generates SkillSyncInstructions for a worker's heartbeat.
 *
 * Logic (Phase 2 baseline):
 *   1. Resolve worker → user_id + org_id
 *   2. Compute expected_skills = user_subscriptions + org_forced_subscriptions + system_published
 *      - Exclude any package with is_kill_switched=TRUE
 *   3. Diff expected_skills against worker's cached_skills
 *      - Missing → sync instruction
 *      - Hash mismatch → sync instruction (refresh)
 *      - Extra cached but not in expected → kill instruction
 *   4. Return instructions[] sorted by priority (kill > sync)
 *
 * Phase 3 will add: force_update queue, policy_refresh, canary rollout.
 */

import { randomUUID } from "crypto";
import { query } from "../store/pg.js";
import type { CachedSkill, SkillSyncInstruction } from "../types/index.js";

interface WorkerInfo {
  id: string;
  user_id: string | null;
  org_id: string | null;
}

interface ExpectedSkill {
  package_id: string;
  version: string;
  version_id: string;
  content_hash: string;
  content: string | null;
  content_url: string | null;
  is_kill_switched: boolean;
}

export async function getWorkerInfo(workerId: string): Promise<WorkerInfo | null> {
  const { rows } = await query<{ id: string; user_id: string | null; organization_id: string | null }>(
    `SELECT id, user_id, organization_id FROM workers WHERE id = $1`,
    [workerId],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return { id: r.id, user_id: r.user_id, org_id: r.organization_id };
}

/**
 * Compute the set of skills this worker should have installed.
 *
 * Sources (in priority order):
 *   1. system-published (scope='system', status='published', not kill_switched)
 *   2. org-forced subscriptions (subscriber_type='org', subscriber_id=worker.org_id, is_forced=true)
 *   3. user subscriptions (subscriber_type='user', subscriber_id=worker.user_id)
 */
export async function computeExpectedSkills(worker: WorkerInfo): Promise<ExpectedSkill[]> {
  const params: unknown[] = [];
  const clauses: string[] = [];

  // System published skills (no params needed)
  clauses.push(`(p.scope = 'system' AND p.is_kill_switched = FALSE AND v.status = 'published')`);

  // Org-forced subscriptions (only if worker has org)
  if (worker.org_id) {
    params.push(worker.org_id);
    clauses.push(`(
      EXISTS(
        SELECT 1 FROM skill_subscriptions s
        WHERE s.package_id = p.id
          AND s.subscriber_type = 'org'
          AND s.subscriber_id = $${params.length}
          AND s.is_forced = TRUE
      )
      AND p.is_kill_switched = FALSE AND v.status = 'published'
    )`);
  }

  // User subscriptions (only if worker has user_id)
  if (worker.user_id) {
    params.push(worker.user_id);
    clauses.push(`(
      EXISTS(
        SELECT 1 FROM skill_subscriptions s
        WHERE s.package_id = p.id
          AND s.subscriber_type = 'user'
          AND s.subscriber_id = $${params.length}
      )
      AND p.is_kill_switched = FALSE AND v.status = 'published'
    )`);
  }

  const sql = `
    SELECT p.id as package_id, v.id as version_id, v.version, v.content_hash, v.content, v.status
    FROM skill_packages p
    JOIN skill_versions v ON v.id = p.active_version_id
    WHERE (${clauses.join(" OR ")})
  `;

  const { rows } = await query<ExpectedSkill & { status: string }>(sql, params);
  return rows;
}

/**
 * Generate SkillSyncInstructions by diffing expected vs cached.
 */
export async function generateInstructions(
  workerId: string,
  cachedSkills: CachedSkill[],
): Promise<SkillSyncInstruction[]> {
  const worker = await getWorkerInfo(workerId);
  if (!worker) return [];

  const expected = await computeExpectedSkills(worker);
  const expectedMap = new Map(expected.map((e) => [e.package_id, e]));
  const cachedMap = new Map(cachedSkills.map((c) => [c.package_id, c]));

  const instructions: SkillSyncInstruction[] = [];

  // 1. Missing or out-of-date → sync
  for (const exp of expected) {
    const cached = cachedMap.get(exp.package_id);
    if (!cached) {
      instructions.push(buildSyncInstruction(exp, "missing"));
    } else if (cached.content_hash !== exp.content_hash) {
      instructions.push(buildSyncInstruction(exp, "hash-mismatch"));
    } else if (cached.version !== exp.version) {
      instructions.push(buildSyncInstruction(exp, "version-mismatch"));
    }
  }

  // 2. Cached but not expected → kill
  for (const cached of cachedSkills) {
    if (!expectedMap.has(cached.package_id)) {
      instructions.push({
        action: "kill",
        package_id: cached.package_id,
        version: cached.version,
        reason: "not_in_expected_set",
        instruction_id: `inst_${randomUUID().replace(/-/g, "")}`,
      });
    }
  }

  return instructions;
}

function buildSyncInstruction(exp: ExpectedSkill, reason: string): SkillSyncInstruction {
  const inst: SkillSyncInstruction = {
    action: "sync",
    package_id: exp.package_id,
    version_id: exp.version_id,
    version: exp.version,
    hash: exp.content_hash,
    reason,
    instruction_id: `inst_${randomUUID().replace(/-/g, "")}`,
  };

  // If content is small enough (< 64KB), inline it; otherwise worker downloads via URL
  const MAX_INLINE = 64 * 1024;
  if (exp.content && exp.content.length < MAX_INLINE) {
    inst.content = exp.content;
  } else {
    inst.content_url = `/api/v1/skills/${exp.package_id}/versions/${exp.version_id}/download`;
  }

  return inst;
}

/**
 * Persist worker skill cache after a successful sync/kill ack.
 * Called from the ack endpoint.
 */
export async function recordSyncAck(
  workerId: string,
  instruction: SkillSyncInstruction,
): Promise<void> {
  if (instruction.action === "kill") {
    await query(
      `DELETE FROM worker_skill_cache WHERE worker_id = $1 AND package_id = $2`,
      [workerId, instruction.package_id],
    );
    return;
  }

  // sync / force_update
  const id = `wsc_${randomUUID().replace(/-/g, "")}`;
  await query(
    `INSERT INTO worker_skill_cache (id, worker_id, package_id, version_id, version, content_hash, synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (worker_id, package_id)
     DO UPDATE SET version_id = $4, version = $5, content_hash = $6, synced_at = NOW()`,
    [id, workerId, instruction.package_id, instruction.version_id ?? null,
     instruction.version ?? null, instruction.hash ?? null],
  );
}
