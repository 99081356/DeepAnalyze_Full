// =============================================================================
// DeepAnalyze - Skill Test Runner (S6.6)
// =============================================================================
// Runs test scenarios against skills to verify expected behavior.
// Validates tool calls, keywords, and forbidden patterns in agent output.
// =============================================================================

import type { AgentRunner } from "./agent-runner.js";
import type { AgentSkill } from "../../store/repos/interfaces.js";
import type { SkillTestScenario, AgentResult } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TestRunResult {
  scenarioName: string;
  passed: boolean;
  details: string;
  actualOutput?: string;
  failures: string[];
}

// ---------------------------------------------------------------------------
// SkillTestRunner
// ---------------------------------------------------------------------------

export class SkillTestRunner {
  constructor(private runner: AgentRunner) {}

  /**
   * Run a single test scenario against a skill.
   */
  async runScenario(
    skill: AgentSkill,
    scenario: SkillTestScenario,
  ): Promise<TestRunResult> {
    const failures: string[] = [];

    try {
      const result: AgentResult = await this.runner.run({
        input: scenario.input,
        isSkillInvocation: true,
        systemPromptOverride: skill.prompt,
      });

      const output = result.output ?? "";

      // Check expected tool calls
      if (scenario.expectedToolCalls && scenario.expectedToolCalls.length > 0) {
        // Check tool calls from result metadata if available
        const actualToolCalls = (result as any).toolCalls ?? [];
        const actualToolNames = new Set(
          actualToolCalls.map((tc: any) => tc.function?.name).filter(Boolean),
        );

        for (const expectedTool of scenario.expectedToolCalls) {
          if (!actualToolNames.has(expectedTool)) {
            // Also check if tool name appears in output text as a fallback
            if (!output.includes(expectedTool)) {
              failures.push(
                `Missing expected tool call: ${expectedTool}`,
              );
            }
          }
        }
      }

      // Check expected keywords
      if (scenario.expectedKeywords && scenario.expectedKeywords.length > 0) {
        const lowerOutput = output.toLowerCase();
        for (const keyword of scenario.expectedKeywords) {
          if (!lowerOutput.includes(keyword.toLowerCase())) {
            failures.push(
              `Missing expected keyword: "${keyword}"`,
            );
          }
        }
      }

      // Check forbidden patterns
      if (scenario.forbiddenPatterns && scenario.forbiddenPatterns.length > 0) {
        for (const pattern of scenario.forbiddenPatterns) {
          try {
            const regex = new RegExp(pattern, "i");
            if (regex.test(output)) {
              failures.push(
                `Output contains forbidden pattern: "${pattern}"`,
              );
            }
          } catch {
            // Invalid regex — treat as literal string match
            if (output.toLowerCase().includes(pattern.toLowerCase())) {
              failures.push(
                `Output contains forbidden pattern: "${pattern}"`,
              );
            }
          }
        }
      }

      return {
        scenarioName: scenario.name,
        passed: failures.length === 0,
        details: failures.length === 0
          ? "All checks passed"
          : `${failures.length} check(s) failed`,
        actualOutput: output.slice(0, 500),
        failures,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        scenarioName: scenario.name,
        passed: false,
        details: `Execution error: ${errorMsg}`,
        failures: [`Execution error: ${errorMsg}`],
      };
    }
  }

  /**
   * Run all test scenarios defined on a skill.
   */
  async runAll(skill: AgentSkill): Promise<TestRunResult[]> {
    const scenarios = skill.testScenarios as unknown as SkillTestScenario[] | undefined;
    if (!scenarios || scenarios.length === 0) {
      return [
        {
          scenarioName: "(no scenarios)",
          passed: true,
          details: "No test scenarios defined for this skill",
          failures: [],
        },
      ];
    }

    const results: TestRunResult[] = [];
    for (const scenario of scenarios) {
      results.push(await this.runScenario(skill, scenario));
    }
    return results;
  }
}
