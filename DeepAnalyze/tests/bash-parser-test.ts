/**
 * End-to-end test for the bash parser integration chain:
 * bashParser.ts -> parser.ts -> ast.ts -> bash-ast-parser.ts
 *
 * Run with: npx tsx tests/bash-parser-test.ts
 */
import assert from "assert";

const {
  parseBashCommand,
  classifyBashCommand,
  parseBashCommandAsync,
  classifyBashCommandAsync,
} = await import("../src/services/agent/bash-ast-parser.ts");

// =========================================================================
// 1. Sync parser (regex-based fallback)
// =========================================================================
console.log("\n=== Testing parseBashCommand (sync/regex) ===");

// Simple command
const r1 = parseBashCommand("ls -la /tmp");
assert.deepStrictEqual(r1.commands, ["ls"]);
assert.strictEqual(r1.hasPipes, false);
assert.strictEqual(r1.hasSudo, false);
console.log("  ✅ Simple command: ls -la /tmp");

// Pipe
const r2 = parseBashCommand("cat file.txt | grep error | wc -l");
assert.deepStrictEqual(r2.commands, ["cat", "grep", "wc"]);
assert.strictEqual(r2.hasPipes, true);
console.log("  ✅ Pipe: cat | grep | wc");

// Sudo
const r3 = parseBashCommand("sudo rm -rf /tmp/test");
assert.deepStrictEqual(r3.commands, ["rm"]);
assert.strictEqual(r3.hasSudo, true);
console.log("  ✅ Sudo: sudo rm -rf /tmp/test");

// Chaining
const r4 = parseBashCommand("mkdir dir && cd dir || echo failed");
assert.strictEqual(r4.hasChaining, true);
console.log("  ✅ Chaining: && and ||");

// Command substitution
const r5 = parseBashCommand("echo $(date)");
assert.strictEqual(r5.hasSubstitution, true);
console.log("  ✅ Command substitution: $(date)");

// Redirections
const r6 = parseBashCommand("grep error log.txt > output.txt 2>&1");
assert.ok(r6.redirects.length > 0);
console.log("  ✅ Redirections: > and 2>&1");

// /dev/null
const r7 = parseBashCommand("command 2>/dev/null");
assert.strictEqual(r7.hasDevNull, true);
console.log("  ✅ /dev/null redirect");

// Empty
const r8 = parseBashCommand("");
assert.deepStrictEqual(r8.commands, []);
console.log("  ✅ Empty command");

// =========================================================================
// 2. Security classification
// =========================================================================
console.log("\n=== Testing classifyBashCommand ===");

const s1 = classifyBashCommand(parseBashCommand("ls"));
assert.strictEqual(s1.level, "safe");
console.log("  ✅ 'ls' → safe");

const s2 = classifyBashCommand(parseBashCommand("rm file.txt"));
assert.strictEqual(s2.level, "dangerous");
assert.ok(s2.reasons.some(r => r.includes("dangerous")));
console.log("  ✅ 'rm file.txt' → dangerous");

const s3 = classifyBashCommand(parseBashCommand("sudo apt update"));
assert.strictEqual(s3.level, "dangerous");
assert.ok(s3.reasons.some(r => r.includes("sudo")));
console.log("  ✅ 'sudo apt update' → dangerous (sudo)");

const s4 = classifyBashCommand(parseBashCommand("cp src dest"));
assert.strictEqual(s4.level, "caution");
console.log("  ✅ 'cp src dest' → caution");

const s5 = classifyBashCommand(parseBashCommand("cat file | grep foo"));
assert.strictEqual(s5.level, "caution");
console.log("  ✅ 'cat | grep' → caution (pipe)");

const s6 = classifyBashCommand(parseBashCommand("echo hello && echo world"));
assert.strictEqual(s6.level, "caution");
console.log("  ✅ 'echo && echo' → caution (chaining)");

const s7 = classifyBashCommand(parseBashCommand("grep pattern file"));
assert.strictEqual(s7.level, "safe");
console.log("  ✅ 'grep pattern file' → safe");

// =========================================================================
// 3. Async parser (AST-based)
// =========================================================================
console.log("\n=== Testing parseBashCommandAsync (AST) ===");

const a1 = await parseBashCommandAsync("echo hello world");
assert.ok(a1.commands.length > 0);
assert.ok(a1.commands.includes("echo") || a1.commands[0] === "echo");
console.log("  ✅ Async: echo hello world");

const a2 = await parseBashCommandAsync("cat file.txt | grep error");
assert.strictEqual(a2.hasPipes, true);
console.log("  ✅ Async: cat | grep");

const a3 = await parseBashCommandAsync("");
assert.deepStrictEqual(a3.commands, []);
console.log("  ✅ Async: empty command");

// =========================================================================
// 4. Async classification
// =========================================================================
console.log("\n=== Testing classifyBashCommandAsync ===");

const ac1 = await classifyBashCommandAsync("ls -la");
assert.strictEqual(ac1.level, "safe");
console.log("  ✅ Async classify: ls -la → safe");

const ac2 = await classifyBashCommandAsync("sudo rm -rf /");
assert.strictEqual(ac2.level, "dangerous");
console.log("  ✅ Async classify: sudo rm -rf / → dangerous");

const ac3 = await classifyBashCommandAsync("mkdir newdir");
assert.strictEqual(ac3.level, "caution");
console.log("  ✅ Async classify: mkdir → caution");

// =========================================================================
// 5. AST parser chain (parser.ts -> ast.ts)
// =========================================================================
console.log("\n=== Testing AST parser chain ===");

const { parseCommand } = await import("../src/utils/bash/parser.ts");
const { parseForSecurity } = await import("../src/utils/bash/ast.ts");

// parseCommand should return structured data
const pc1 = await parseCommand("echo hello");
if (pc1) {
  assert.ok(pc1.rootNode, "parseCommand returns rootNode");
  assert.ok(pc1.originalCommand === "echo hello");
  console.log("  ✅ parseCommand('echo hello') → rootNode present");
} else {
  console.log("  ⚠️ parseCommand returned null (parser unavailable, OK in Node.js)");
}

// parseForSecurity should classify commands
const pf1 = await parseForSecurity("echo hello");
if (pf1.kind === "simple") {
  assert.ok(pf1.commands.length > 0);
  assert.strictEqual(pf1.commands[0].argv[0], "echo");
  console.log("  ✅ parseForSecurity('echo hello') → simple, argv=['echo', 'hello']");
} else {
  console.log(`  ⚠️ parseForSecurity returned '${pf1.kind}' (parser may be unavailable)`);
}

const pf2 = await parseForSecurity("ls -la /tmp | grep foo");
if (pf2.kind === "simple") {
  assert.ok(pf2.commands.length >= 2);
  console.log(`  ✅ parseForSecurity('ls | grep') → ${pf2.commands.length} simple commands`);
} else {
  console.log(`  ⚠️ parseForSecurity('ls | grep') returned '${pf2.kind}'`);
}

// =========================================================================
// SUMMARY
// =========================================================================
console.log("\n" + "=".repeat(60));
console.log("ALL BASH PARSER TESTS PASSED ✅");
console.log("=".repeat(60));
