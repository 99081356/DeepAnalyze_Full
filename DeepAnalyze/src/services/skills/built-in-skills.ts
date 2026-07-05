// =============================================================================
// DeepAnalyze - Built-in Skills (Plugin Skills table)
// =============================================================================
// All generic skills have been migrated to the agent_skills table via
// ensureBuiltinSkills() in src/services/agent/builtin-skills.ts.
// This file is kept for backward compatibility but the array is empty.
//
// Domain-specific skills remain in their respective Plugin directories
// (e.g. plugins/judicial-analysis/).
// =============================================================================

import type { SkillDefinition } from "../plugins/types.js";

/** Built-in skills that are pre-registered on first startup. Now empty — all migrated to agent_skills. */
export const BUILT_IN_SKILLS: Array<Omit<SkillDefinition, "id">> = [];
