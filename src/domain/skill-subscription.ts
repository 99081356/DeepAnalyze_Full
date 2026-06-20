/**
 * Skill subscription domain logic.
 *
 * Subscribers can be:
 *   - user: personal subscription, only affects worker with user_id
 *   - worker: directly bound to a worker
 *   - org: org-level forced subscription, affects all workers in the org
 */

import { randomUUID } from "crypto";
import { query } from "../store/pg.js";

export interface SkillSubscription {
  id: string;
  package_id: string;
  subscriber_type: "user" | "worker" | "org";
  subscriber_id: string;
  is_forced: boolean;
  pinned: boolean;
  auto_update: boolean;
  source: string;
  created_at: string;
}

export async function subscribe(params: {
  package_id: string;
  subscriber_type: "user" | "worker" | "org";
  subscriber_id: string;
  is_forced?: boolean;
  source?: string;
}): Promise<SkillSubscription> {
  const id = `sub_${randomUUID().replace(/-/g, "")}`;
  const source = params.source ?? (params.subscriber_type === "org" ? "org_share" : "market");

  const { rows } = await query(
    `INSERT INTO skill_subscriptions (id, package_id, subscriber_type, subscriber_id, is_forced, source)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (package_id, subscriber_type, subscriber_id)
     DO UPDATE SET is_forced = EXCLUDED.is_forced, source = EXCLUDED.source
     RETURNING *`,
    [id, params.package_id, params.subscriber_type, params.subscriber_id,
     params.is_forced ?? false, source],
  );

  // Update stats
  await query(
    `UPDATE skill_packages
     SET stats = jsonb_set(stats, '{subscriptions}',
       to_jsonb((SELECT COUNT(*)::int FROM skill_subscriptions WHERE package_id = $1)))
     WHERE id = $1`,
    [params.package_id],
  );

  return rows[0] as SkillSubscription;
}

export async function unsubscribe(
  packageId: string,
  subscriberType: "user" | "worker" | "org",
  subscriberId: string,
): Promise<boolean> {
  const result = await query(
    `DELETE FROM skill_subscriptions
     WHERE package_id = $1 AND subscriber_type = $2 AND subscriber_id = $3`,
    [packageId, subscriberType, subscriberId],
  );

  // Update stats
  await query(
    `UPDATE skill_packages
     SET stats = jsonb_set(stats, '{subscriptions}',
       to_jsonb((SELECT COUNT(*)::int FROM skill_subscriptions WHERE package_id = $1)))
     WHERE id = $1`,
    [packageId],
  );

  return (result.rowCount ?? 0) > 0;
}

export async function listSubscriptions(
  subscriberType: "user" | "worker" | "org",
  subscriberId: string,
): Promise<Array<{ package_id: string; package_name: string; is_forced: boolean; source: string; created_at: string }>> {
  const { rows } = await query<{
    package_id: string;
    package_name: string;
    is_forced: boolean;
    source: string;
    created_at: string;
  }>(
    `SELECT s.package_id, p.name as package_name, s.is_forced, s.source, s.created_at
     FROM skill_subscriptions s
     JOIN skill_packages p ON p.id = s.package_id
     WHERE s.subscriber_type = $1 AND s.subscriber_id = $2
     ORDER BY s.created_at DESC`,
    [subscriberType, subscriberId],
  );
  return rows;
}
