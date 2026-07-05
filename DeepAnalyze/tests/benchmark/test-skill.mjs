#!/usr/bin/env node
// Quick test script to run a DABstep test case with a specific skill

const BASE_URL = "http://localhost:21000";
const KB_ID = "0f329774-cc0f-48fe-b5c1-393e3a80bc0a";

// DABstep test cases
const TESTS = {
  "DAB-1273": {
    question: "What is the average fee for GlobalCard credit cards? Give the answer rounded to 6 decimal places.",
    expectedAnswer: "0.120132",
    matchMode: "contains",
  },
  "DAB-1305": {
    question: "What is the average fee for account_type H, merchant_category_code 5812? Give the answer rounded to 6 decimal places.",
    expectedAnswer: "0.123217",
    matchMode: "contains",
  },
  "DAB-2697": {
    question: "Which merchant has the highest total fee, and what is the total fee amount?",
    expectedAnswer: "E:13.57",
    matchMode: "contains",
  },
};

async function createSession(title) {
  const resp = await fetch(`${BASE_URL}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!resp.ok) throw new Error(`Failed to create session: ${resp.status}`);
  const body = await resp.json();
  return body.id;
}

async function deleteSession(sessionId) {
  await fetch(`${BASE_URL}/api/sessions/${sessionId}`, { method: "DELETE" });
}

async function runSkillTest(skillId, testId, testCase) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Test: ${testId}`);
  console.log(`${"=".repeat(60)}`);
  console.log(`  Question: ${testCase.question}`);
  console.log(`  Expected: ${testCase.expectedAnswer}`);

  const sessionId = await createSession(`skill-test-${testId}`);
  console.log(`  Session: ${sessionId}`);

  const startTime = Date.now();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 600000); // 10 min timeout

    const resp = await fetch(`${BASE_URL}/api/agents/run-skill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        skillId,
        useAgentSkills: true,
        input: testCase.question,
        kbId: KB_ID,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!resp.ok) {
      const errText = await resp.text();
      console.log(`  ERROR: HTTP ${resp.status} - ${errText}`);
      await deleteSession(sessionId);
      return { passed: false, error: `HTTP ${resp.status}` };
    }

    const result = await resp.json();
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    const output = result.output || "";
    const turnsUsed = result.turnsUsed || 0;
    const taskId = result.taskId || "";

    console.log(`  Duration: ${duration}s`);
    console.log(`  Turns: ${turnsUsed}`);
    console.log(`  Output length: ${output.length} chars`);
    console.log(`  Task ID: ${taskId}`);
    if (result.error) console.log(`  Error: ${result.error}`);
    console.log(`  Full output:\n${output}`);

    // Check answer
    let passed = false;
    const expected = testCase.expectedAnswer.toLowerCase();
    const outputLower = output.toLowerCase();

    if (testCase.matchMode === "contains") {
      passed = outputLower.includes(expected);
    }

    const status = passed ? "PASS" : "FAIL";
    console.log(`\n  Result: ${status}`);
    console.log(`  Expected: "${testCase.expectedAnswer}"`);
    if (passed) {
      // Show the matching part
      const idx = outputLower.indexOf(expected);
      const context = output.substring(Math.max(0, idx - 30), Math.min(output.length, idx + expected.length + 30));
      console.log(`  Found: "...${context}..."`);
    } else {
      console.log(`  Output (last 500 chars): ${output.slice(-500)}`);
    }

    // Don't delete session for debugging
    // await deleteSession(sessionId);
    return { passed, duration: parseFloat(duration), turnsUsed, taskId, output: output.slice(-1000) };
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
    // await deleteSession(sessionId);
    return { passed: false, error: e.message };
  }
}

// Main
const skillName = process.argv[2] || "cross-table-analysis";
const testFilter = process.argv[3] || ""; // e.g. "DAB-1273"

async function resolveSkillId(nameOrId) {
  const resp = await fetch(`${BASE_URL}/api/agent-skills`);
  if (resp.ok) {
    const skills = await resp.json();
    const match = skills.find(s => s.name === nameOrId || s.id === nameOrId);
    if (match) return { id: match.id, name: match.name };
  }
  return null;
}

async function main() {
  const tests = Object.entries(TESTS).filter(([id]) => !testFilter || id === testFilter);

  if (tests.length === 0) {
    console.log("No tests matched filter:", testFilter);
    console.log("Available tests:", Object.keys(TESTS).join(", "));
    process.exit(1);
  }

  // Resolve skill name to ID
  const skillInfo = await resolveSkillId(skillName);
  if (!skillInfo) {
    console.log(`ERROR: Skill "${skillName}" not found`);
    process.exit(1);
  }
  console.log(`Resolved skill: ${skillInfo.name} (ID: ${skillInfo.id})`);
  console.log(`Testing with ${tests.length} test(s)`);

  let passCount = 0;
  const results = [];

  for (const [testId, testCase] of tests) {
    const result = await runSkillTest(skillInfo.id, testId, testCase);
    if (result.passed) passCount++;
    results.push({ testId, ...result });
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Summary: ${passCount}/${tests.length} PASS`);
  console.log(`${"=".repeat(60)}`);

  for (const r of results) {
    console.log(`  ${r.testId}: ${r.passed ? "PASS" : "FAIL"} (${r.duration}s)`);
  }
}

main().catch(console.error);
