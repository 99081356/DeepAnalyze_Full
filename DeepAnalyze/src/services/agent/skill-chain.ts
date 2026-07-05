// =============================================================================
// DeepAnalyze - Skill Chain Executor (S6.4)
// =============================================================================
// Chains multiple skills together, passing the output of one as input to the
// next. Supports configurable failure modes and input transforms.
// =============================================================================

import type { AgentRunner } from "./agent-runner.js";
import type { AgentResult } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single step within a skill chain. */
export interface SkillChainStep {
  /** Name of the skill to invoke. */
  skillName: string;
  /** Transform the previous step's output before passing it as input. */
  inputTransform?: (prevOutput: string) => string;
  /** Whether to pass accumulated chain context alongside the input. */
  passContext?: boolean;
}

/** A named, ordered chain of skills with a failure policy. */
export interface SkillChain {
  name: string;
  description: string;
  steps: SkillChainStep[];
  /** How to handle a step failure:
   *  - "stop": abort the entire chain and throw.
   *  - "skip": skip the failed step, pass previous output to the next step.
   *  - "continue": same as skip but logs a warning.
   */
  failMode: "stop" | "skip" | "continue";
}

// ---------------------------------------------------------------------------
// Execution result
// ---------------------------------------------------------------------------

export interface SkillChainResult {
  chainName: string;
  finalOutput: string;
  stepResults: Array<{
    skillName: string;
    success: boolean;
    output: string;
    error?: string;
  }>;
  completedSteps: number;
  totalSteps: number;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/**
 * Execute a skill chain by running each step sequentially.
 * The output of one step becomes the input of the next (optionally transformed).
 */
export async function executeChain(
  chain: SkillChain,
  initialInput: string,
  runner: AgentRunner,
): Promise<SkillChainResult> {
  const stepResults: SkillChainResult["stepResults"] = [];
  let currentOutput = initialInput;

  for (let i = 0; i < chain.steps.length; i++) {
    const step = chain.steps[i];
    const stepInput = step.inputTransform
      ? step.inputTransform(currentOutput)
      : buildStepInput(currentOutput, step);

    try {
      const result: AgentResult = await runner.run({
        input: stepInput,
        isSkillInvocation: true,
        systemPromptOverride: undefined, // skill resolution handled externally
      });

      stepResults.push({
        skillName: step.skillName,
        success: true,
        output: result.output,
      });

      currentOutput = result.output;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      stepResults.push({
        skillName: step.skillName,
        success: false,
        output: "",
        error: errorMsg,
      });

      if (chain.failMode === "stop") {
        throw new Error(
          `Skill chain "${chain.name}" failed at step ${i + 1} (${step.skillName}): ${errorMsg}`,
        );
      }
      // "skip" or "continue" — keep previous output
      if (chain.failMode === "continue") {
        console.warn(
          `[SkillChain] Step ${i + 1} "${step.skillName}" failed (continuing): ${errorMsg}`,
        );
      }
    }
  }

  return {
    chainName: chain.name,
    finalOutput: currentOutput,
    stepResults,
    completedSteps: stepResults.filter(s => s.success).length,
    totalSteps: chain.steps.length,
  };
}

/** Build the input string for a step, optionally wrapping with context header. */
function buildStepInput(
  prevOutput: string,
  step: SkillChainStep,
): string {
  if (step.passContext) {
    return `## 前置技能输出\n\n${prevOutput}`;
  }
  return prevOutput;
}

// ---------------------------------------------------------------------------
// Built-in chains
// ---------------------------------------------------------------------------

export const BUILTIN_CHAINS: SkillChain[] = [
  {
    name: "research-to-report",
    description:
      "深度研究后生成结构化报告——先进行系统化的信息收集与分析，然后将研究结果整理为完整报告",
    steps: [
      {
        skillName: "deep-research",
        passContext: true,
      },
      {
        skillName: "报告生成",
        inputTransform: (researchOutput: string) =>
          `请基于以下研究结果生成结构化分析报告：\n\n${researchOutput}`,
      },
    ],
    failMode: "stop",
  },
  {
    name: "search-and-verify",
    description: "先深度检索再交叉验证——先用三层递进策略检索信息，然后对关键事实进行深度研究和验证",
    steps: [
      {
        skillName: "深度检索",
        passContext: true,
      },
      {
        skillName: "deep-research",
        inputTransform: (searchOutput: string) =>
          `请对以下检索结果中的关键发现进行深度分析和交叉验证：\n\n${searchOutput}`,
      },
    ],
    failMode: "continue",
  },
  {
    name: "cluster-and-analyze",
    description: "先探索文档结构再分组深度分析——自动获取文档列表和元数据，然后基于分组结果进行深度分析",
    steps: [
      {
        skillName: "深度检索",
        passContext: true,
      },
      {
        skillName: "chunked-analysis",
        inputTransform: (exploreOutput: string) =>
          `基于以下探索结果，对文档进行分组深度分析：\n\n${exploreOutput}`,
      },
    ],
    failMode: "continue",
  },
];
