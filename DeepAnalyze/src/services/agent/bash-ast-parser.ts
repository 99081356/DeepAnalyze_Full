// =============================================================================
// DeepAnalyze - Bash Command Semantic Parser
// =============================================================================
// Uses CC's pure TypeScript bash parser (bashParser.ts) for proper AST-level
// parsing when available, with regex-based fallback for when parsing fails.
//
// The parser extracts semantic information from bash commands:
// command names, arguments, pipes, redirections, and subshells.
// Used for security classification of bash commands.
// =============================================================================

import { parseCommand } from "../../utils/bash/parser.ts";
import { extractCommandArguments } from "../../utils/bash/parser.ts";
import { parseForSecurity } from "../../utils/bash/ast.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedBashCommand {
  /** Extracted command names (e.g., ["git", "rm"]) */
  commands: string[];
  /** Redirection targets (e.g., [">", ">>", "2>"]) */
  redirects: string[];
  /** Whether the command uses pipes */
  hasPipes: boolean;
  /** Whether command substitution $(...) or backticks are present */
  hasSubstitution: boolean;
  /** Whether sudo is used */
  hasSudo: boolean;
  /** Whether output is redirected to /dev/null */
  hasDevNull: boolean;
  /** Whether the command uses && or || operators */
  hasChaining: boolean;
  /** Raw arguments for each command */
  rawArgs: string[];
}

export type SecurityLevel = "safe" | "caution" | "dangerous";

export interface SecurityClassification {
  level: SecurityLevel;
  reasons: string[];
}

// ---------------------------------------------------------------------------
// AST-based parser (primary)
// ---------------------------------------------------------------------------

/**
 * Parse using CC's full bash parser with AST analysis.
 * Returns null if parser is unavailable or fails.
 */
async function parseWithAst(command: string): Promise<ParsedBashCommand | null> {
  try {
    const securityResult = await parseForSecurity(command);

    if (securityResult.kind !== "simple") {
      // too-complex or parse-unavailable — fall back to regex
      return null;
    }

    const result: ParsedBashCommand = {
      commands: [],
      redirects: [],
      hasPipes: false,
      hasSubstitution: false,
      hasSudo: false,
      hasDevNull: false,
      hasChaining: false,
      rawArgs: [],
    };

    const trimmed = command.trim();

    // Detect structural features from the raw command
    result.hasSubstitution = /\$\([^)]*\)/.test(trimmed) || /`[^`]*`/.test(trimmed);
    result.hasChaining = /&&|\|\|/.test(trimmed);
    result.hasPipes = /\|(?!\|)/.test(trimmed);
    result.hasSudo = /\bsudo\b/.test(trimmed);
    result.hasDevNull = /\/dev\/null/.test(trimmed);

    const redirectMatches = trimmed.match(/>>|>|2>|&>|1>/g);
    if (redirectMatches) {
      result.redirects.push(...redirectMatches);
    }

    // Extract command names from the AST simple commands
    for (const cmd of securityResult.commands) {
      if (cmd.argv.length > 0) {
        result.commands.push(cmd.argv[0]);
        result.rawArgs.push(cmd.argv.slice(1).join(" "));
      }

      // Extract redirects from AST
      for (const redir of cmd.redirects) {
        if (!result.redirects.includes(redir.op)) {
          result.redirects.push(redir.op);
        }
        if (redir.target === "/dev/null") {
          result.hasDevNull = true;
        }
      }
    }

    return result;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Regex-based parser (fallback)
// ---------------------------------------------------------------------------

/**
 * Parse a bash command string using regex-based parsing.
 * This is the fallback when the AST parser is unavailable.
 */
function parseWithRegex(command: string): ParsedBashCommand {
  const result: ParsedBashCommand = {
    commands: [],
    redirects: [],
    hasPipes: false,
    hasSubstitution: false,
    hasSudo: false,
    hasDevNull: false,
    hasChaining: false,
    rawArgs: [],
  };

  if (!command || !command.trim()) return result;

  const trimmed = command.trim();

  // Check for command substitution
  result.hasSubstitution = /\$\([^)]*\)/.test(trimmed) || /`[^`]*`/.test(trimmed);

  // Check for chaining operators
  result.hasChaining = /&&|\|\|/.test(trimmed);

  // Check for pipes (but not ||)
  const pipeSegments = trimmed.split(/\|(?!\|)/);
  result.hasPipes = pipeSegments.length > 1;

  // Check for sudo
  result.hasSudo = /\bsudo\b/.test(trimmed);

  // Check for /dev/null redirect
  result.hasDevNull = /\/dev\/null/.test(trimmed);

  // Extract redirect operators
  const redirectMatches = trimmed.match(/>>|>|2>|&>|1>/g);
  if (redirectMatches) {
    result.redirects.push(...redirectMatches);
  }

  // Extract command names from each pipe segment
  for (const segment of pipeSegments) {
    const cleanSegment = segment
      .replace(/&&|\|\|/g, " ")
      .replace(/\$\([^)]*\)/g, " ")
      .replace(/`[^`]*`/g, " ")
      .trim();

    // Split by whitespace and extract command name
    const tokens = cleanSegment.split(/\s+/).filter(Boolean);
    if (tokens.length > 0) {
      // Skip sudo prefix
      let cmdIdx = 0;
      if (tokens[0] === "sudo") cmdIdx = 1;
      if (cmdIdx < tokens.length) {
        const cmdName = tokens[cmdIdx];
        // Skip flags like -e, -c that precede the actual command
        if (cmdName === "env" || cmdName === "bash" || cmdName === "sh" || cmdName === "python3" || cmdName === "python") {
          // Look for -c flag
          const cFlagIdx = tokens.indexOf("-c", cmdIdx + 1);
          if (cFlagIdx !== -1 && cFlagIdx + 1 < tokens.length) {
            // The next token after -c is the command string
            result.commands.push(cmdName);
            result.rawArgs.push(tokens.slice(cmdIdx + 1).join(" "));
          } else {
            result.commands.push(cmdName);
            result.rawArgs.push(tokens.slice(cmdIdx + 1).join(" "));
          }
        } else {
          result.commands.push(cmdName);
          result.rawArgs.push(tokens.slice(cmdIdx + 1).join(" "));
        }
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Unified parser
// ---------------------------------------------------------------------------

/**
 * Parse a bash command string to extract semantic information.
 * Tries the AST parser first, falls back to regex-based parsing.
 */
export function parseBashCommand(command: string): ParsedBashCommand {
  // Synchronous path: use regex parser as primary.
  // The AST parser is async and used by classifyBashCommandAsync.
  return parseWithRegex(command);
}

/**
 * Async version that uses the full AST parser when available.
 * Falls back to the regex parser on failure.
 */
export async function parseBashCommandAsync(command: string): Promise<ParsedBashCommand> {
  const astResult = await parseWithAst(command);
  return astResult ?? parseWithRegex(command);
}

// ---------------------------------------------------------------------------
// Security classification
// ---------------------------------------------------------------------------

/** Commands that are generally safe */
const SAFE_COMMANDS = new Set([
  "ls", "cat", "head", "tail", "grep", "find", "wc", "sort", "uniq",
  "echo", "pwd", "whoami", "date", "which", "type", "file", "stat",
  "df", "du", "free", "top", "ps", "uname", "hostname", "id",
  "git", "gitk", "tig", "diff", "tree", "curl", "wget",
  "python3", "python", "node", "npm", "npx", "bun", "deno",
  "jq", "yq", "xq", "rg", "fd", "bat", "hexdump", "xxd",
]);

/** Commands that require caution */
const CAUTION_COMMANDS = new Set([
  "cp", "mv", "chmod", "chown", "mkdir", "touch", "ln",
  "tar", "zip", "unzip", "gzip", "gunzip",
  "docker", "docker-compose", "kubectl", "helm",
  "pip", "pip3", "apt", "yum", "brew",
  "npm", "yarn", "pnpm",
  "sed", "awk", "perl",
]);

/** Commands that are inherently dangerous */
const DANGEROUS_COMMANDS = new Set([
  "rm", "rmdir", "dd", "mkfs", "fdisk", "parted",
  "kill", "killall", "pkill",
  "reboot", "shutdown", "halt", "poweroff",
  "terraform", "ansible-playbook",
]);

/**
 * Classify the security level of a parsed bash command.
 * Combines command-level classification with context checks.
 */
export function classifyBashCommand(parsed: ParsedBashCommand): SecurityClassification {
  const reasons: string[] = [];

  // Check if any command is dangerous
  const hasDangerous = parsed.commands.some((cmd) => DANGEROUS_COMMANDS.has(cmd));
  const hasCaution = parsed.commands.some((cmd) => CAUTION_COMMANDS.has(cmd));
  const allSafe = parsed.commands.every(
    (cmd) => SAFE_COMMANDS.has(cmd) || CAUTION_COMMANDS.has(cmd) || DANGEROUS_COMMANDS.has(cmd),
  );

  if (hasDangerous) {
    reasons.push(`contains dangerous command: ${parsed.commands.filter((c) => DANGEROUS_COMMANDS.has(c)).join(", ")}`);
  }

  if (parsed.hasSudo) {
    reasons.push("uses sudo (elevated privileges)");
  }

  if (parsed.hasSubstitution) {
    reasons.push("contains command substitution");
  }

  // Determine level
  let level: SecurityLevel;
  if (hasDangerous || parsed.hasSudo) {
    level = "dangerous";
  } else if (hasCaution || parsed.hasPipes || parsed.hasChaining) {
    level = "caution";
  } else {
    level = "safe";
  }

  return { level, reasons };
}

/**
 * Async version that uses the AST parser for better accuracy.
 * Falls back to the regex-based classifier on failure.
 */
export async function classifyBashCommandAsync(command: string): Promise<SecurityClassification> {
  const parsed = await parseBashCommandAsync(command);
  return classifyBashCommand(parsed);
}
