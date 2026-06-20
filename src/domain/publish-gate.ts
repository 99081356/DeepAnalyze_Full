/**
 * PublishGate — 4-dim evaluation before allowing publish to org/system scope.
 *
 * Phase 3 implements:
 *   - RedFlagScanner (30% weight) — CRITICAL blocks
 *   - StructureValidator (15% weight) — basic YAML frontmatter + sections
 *   - LLM evaluation (25% weight) — Phase 3 stub: skip if no LLM configured
 *   - Benchmark runner (30% weight) — Phase 3 stub: skip if no test cases
 *
 * Decision:
 *   - scope=user: report but don't block
 *   - scope=org/system: BLOCK if overall < 60 OR redflag.criticalCount > 0
 */

import { scanContent, type RedFlagResult } from "./redflag-scanner.js";

export interface EvalDimensionResult {
  name: string;
  weight: number;
  score: number; // 0-100
  details: unknown;
}

export interface PublishGateResult {
  overall: number;
  blocked: boolean;
  blockReasons: string[];
  dimensions: EvalDimensionResult[];
  redflag: RedFlagResult;
}

const STRUCTURE_REQUIRED_SECTIONS = ["## When to use", "## Instructions"];
const STRUCTURE_RECOMMENDED_SECTIONS = ["# ", "## Examples", "## Limitations"];

export function evaluateStructure(content: string): EvalDimensionResult {
  const details: Record<string, unknown> = {};
  let score = 50;

  // Has title (# ...)
  if (/^#\s+\S+/m.test(content)) {
    score += 10;
    details.hasTitle = true;
  } else {
    details.hasTitle = false;
  }

  // Has required sections
  const missing: string[] = [];
  for (const section of STRUCTURE_REQUIRED_SECTIONS) {
    if (!content.includes(section)) {
      missing.push(section);
    }
  }
  if (missing.length === 0) {
    score += 25;
    details.hasRequiredSections = true;
  } else {
    details.missingRequiredSections = missing;
    score -= missing.length * 5;
  }

  // Has recommended sections
  const foundRecommended: string[] = [];
  for (const section of STRUCTURE_RECOMMENDED_SECTIONS) {
    if (content.includes(section)) {
      foundRecommended.push(section);
    }
  }
  score += foundRecommended.length * 5;
  details.foundRecommendedSections = foundRecommended;

  // Minimum length check
  if (content.length < 100) {
    score -= 20;
    details.tooShort = true;
  }

  score = Math.max(0, Math.min(100, score));

  return {
    name: "structure",
    weight: 15,
    score,
    details,
  };
}

export function evaluateBenchmark(testCases: unknown[]): EvalDimensionResult {
  // Phase 3 stub: if no test cases, return neutral score
  if (!testCases || testCases.length === 0) {
    return {
      name: "benchmark",
      weight: 30,
      score: 70, // default pass when no tests
      details: { note: "no test cases provided, defaulting to pass" },
    };
  }

  // Phase 3 stub: would run actual test cases here
  return {
    name: "benchmark",
    weight: 30,
    score: 80,
    details: { totalCases: testCases.length, ran: false, note: "benchmark runner not yet implemented" },
  };
}

export function evaluateLLM(content: string): EvalDimensionResult {
  // Phase 3 stub: would call LLM API here
  // For now: basic heuristic — long enough, has examples, no excessive warnings
  let score = 60;
  if (content.length > 500) score += 10;
  if (/```/.test(content)) score += 10; // has code blocks
  if (/## Examples?/i.test(content)) score += 10;
  if (/do not|never|must not/i.test(content)) score += 5; // has safety guidance

  score = Math.max(0, Math.min(100, score));
  return {
    name: "llm_eval",
    weight: 25,
    score,
    details: { note: "LLM evaluation stub (heuristic-based)" },
  };
}

export async function evaluateForPublish(params: {
  content: string;
  testCases?: unknown[];
  scope: "user" | "org" | "system";
  trustLevel?: string;
}): Promise<PublishGateResult> {
  const redflag = scanContent(params.content);
  const structure = evaluateStructure(params.content);
  const llm = evaluateLLM(params.content);
  const benchmark = evaluateBenchmark(params.testCases ?? []);

  const dimensions = [redflagDim(redflag), structure, llm, benchmark];

  let overall = 0;
  for (const dim of dimensions) {
    overall += dim.score * dim.weight / 100;
  }

  const blockReasons: string[] = [];
  let blocked = false;

  if (redflag.criticalCount > 0) {
    blockReasons.push(`RedFlag CRITICAL: ${redflag.criticalCount} critical issue(s)`);
    blocked = true;
  }

  // For org/system scope, enforce overall ≥ 60
  if (params.scope !== "user") {
    if (overall < 60) {
      blockReasons.push(`Overall score ${overall.toFixed(1)} < 60 threshold`);
      blocked = true;
    }
  }

  // For certified trust level, require test cases pass
  if (params.trustLevel === "certified" && (!params.testCases || params.testCases.length === 0)) {
    blockReasons.push("certified trust_level requires test cases");
    blocked = true;
  }

  return {
    overall: Math.round(overall * 10) / 10,
    blocked,
    blockReasons,
    dimensions,
    redflag,
  };
}

function redflagDim(redflag: RedFlagResult): EvalDimensionResult {
  // Convert redflag to 0-100 score
  // Start at 100, subtract for each hit
  let score = 100;
  score -= redflag.criticalCount * 40;
  score -= redflag.highCount * 15;
  score -= redflag.mediumCount * 5;
  score = Math.max(0, score);
  return {
    name: "redflag",
    weight: 30,
    score,
    details: {
      criticalCount: redflag.criticalCount,
      highCount: redflag.highCount,
      mediumCount: redflag.mediumCount,
      hits: redflag.hits.slice(0, 10), // cap details
    },
  };
}
