/**
 * Skill version state machine — 6 states with strict transitions.
 *
 * States: draft → internal_test → canary → published → deprecated/rolled_back
 *
 * Rules:
 *   - Only draft is mutable (content can change)
 *   - Publish to org/system requires approval workflow
 *   - All transitions recorded in skill_audit_logs
 */

export type VersionStatus =
  | "draft"
  | "internal_test"
  | "canary"
  | "published"
  | "deprecated"
  | "rolled_back";

interface TransitionRule {
  from: VersionStatus;
  to: VersionStatus;
  requiresApproval?: boolean;
  adminOnly?: boolean;
}

const TRANSITIONS: TransitionRule[] = [
  { from: "draft", to: "internal_test" },
  { from: "internal_test", to: "draft" },
  { from: "draft", to: "canary", adminOnly: true },
  { from: "internal_test", to: "canary", adminOnly: true },
  { from: "canary", to: "internal_test" },
  { from: "draft", to: "published" }, // user scope: direct publish
  { from: "internal_test", to: "published" },
  { from: "canary", to: "published", requiresApproval: true },
  { from: "published", to: "deprecated", adminOnly: true },
  { from: "published", to: "rolled_back", adminOnly: true },
  { from: "canary", to: "rolled_back", adminOnly: true },
  { from: "deprecated", to: "rolled_back", adminOnly: true },
];

export function canTransition(from: VersionStatus, to: VersionStatus): TransitionRule | null {
  return TRANSITIONS.find((t) => t.from === from && t.to === to) ?? null;
}

export function requiresApproval(
  from: VersionStatus,
  to: VersionStatus,
  scope: "user" | "org" | "system",
): boolean {
  const rule = canTransition(from, to);
  if (!rule) return false;
  // org/system scope publish requires approval
  if (to === "published" && scope !== "user") return true;
  return rule.requiresApproval === true;
}

export function isAdminOnly(from: VersionStatus, to: VersionStatus): boolean {
  const rule = canTransition(from, to);
  return rule?.adminOnly === true;
}
