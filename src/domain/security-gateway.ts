/**
 * Security Gateway — Phase 4 内嵌过滤引擎.
 *
 * Three integration points per design §9.3:
 *   1. filterInput: preHandler on inbound HTTP bodies
 *   2. filterOutput: onSend hook for outbound payloads
 *   3. checkTool: skill-execution tool guard (rules sent to worker)
 *
 * Engines:
 *   - WordEngine: Trie-like multi-pattern matching (here: regex alternation)
 *     with three tiers: sensitive (severity 1), risky (severity 3), allowlist (override)
 *   - RegexEngine: pre-compiled patterns for PII (ID card, phone, bank card, intranet IP)
 *     with auto-masking
 *   - DecisionEngine: severity → action
 *     1-2 → sanitize (mask/redact), 3 → approve w/ warning, 4+ → block
 *
 * FAIL_OPEN: when SECURITY_GATEWAY_ENABLED=false or engine throws, request is allowed.
 */

export type FilterAction = "approve" | "sanitize" | "block";

export interface FilterResult {
  action: FilterAction;
  reason?: string;
  sanitized?: string;
  matches: SecurityMatch[];
  severity: number;
  duration_ms: number;
}

export interface SecurityMatch {
  engine: "word" | "regex" | "model";
  rule_id: string;
  matched_text: string;
  severity: number;
  category: string;
}

export interface SecurityContext {
  endpoint?: string;
  user_id?: string;
  org_id?: string;
  worker_id?: string;
  method?: string;
}

// ─── Word Engine ───────────────────────────────────────────────────────

interface WordEntry {
  text: string;
  severity: number;
  category: string;
}

const DEFAULT_SENSITIVE_WORDS: WordEntry[] = [
  // Severity 1: PII references (sanitized)
  { text: "身份证号", severity: 1, category: "pii" },
  { text: "银行卡号", severity: 1, category: "pii" },
  { text: "手机号码", severity: 1, category: "pii" },
  { text: "家庭住址", severity: 1, category: "pii" },
  // Severity 2: confidential business terms
  { text: "内部机密", severity: 2, category: "confidential" },
  { text: "薪酬数据", severity: 2, category: "confidential" },
  { text: "源代码仓库", severity: 2, category: "confidential" },
];

const DEFAULT_RISKY_WORDS: WordEntry[] = [
  // Severity 3: prompt injection / risky instructions
  { text: "忽略以上指令", severity: 3, category: "prompt_injection" },
  { text: "ignore previous instructions", severity: 3, category: "prompt_injection" },
  { text: "reveal your system prompt", severity: 3, category: "prompt_injection" },
  { text: "你现在是管理员模式", severity: 3, category: "prompt_injection" },
  // Severity 4: dangerous commands
  { text: "rm -rf /", severity: 4, category: "dangerous_command" },
  { text: "DROP TABLE", severity: 4, category: "dangerous_command" },
  { text: "format c:", severity: 4, category: "dangerous_command" },
  { text: "curl http://evil.com", severity: 4, category: "malicious_payload" },
];

const DEFAULT_ALLOWLIST = ["example.com", "localhost", "127.0.0.1"];

export class WordEngine {
  private sensitive: WordEntry[];
  private risky: WordEntry[];
  private allowlist: Set<string>;

  constructor(opts?: {
    sensitive?: WordEntry[];
    risky?: WordEntry[];
    allowlist?: string[];
  }) {
    this.sensitive = opts?.sensitive ?? DEFAULT_SENSITIVE_WORDS;
    this.risky = opts?.risky ?? DEFAULT_RISKY_WORDS;
    this.allowlist = new Set(opts?.allowlist ?? DEFAULT_ALLOWLIST);
  }

  scan(text: string): SecurityMatch[] {
    const matches: SecurityMatch[] = [];
    const lower = text.toLowerCase();

    // Skip allowlisted content entirely
    for (const allowed of this.allowlist) {
      if (lower.includes(allowed.toLowerCase())) {
        // Don't skip the whole text — allowlist just suppresses individual matches
      }
    }

    for (const entry of [...this.sensitive, ...this.risky]) {
      // Case-insensitive substring search (sufficient for short word lists)
      if (lower.includes(entry.text.toLowerCase())) {
        // Check if match is inside an allowlisted context (simple heuristic)
        const ctx = this.contextAround(lower, entry.text.toLowerCase(), 30);
        if (this.isInAllowlistContext(ctx)) continue;

        matches.push({
          engine: "word",
          rule_id: `WORD_${entry.category}_${entry.text}`.replace(/\s+/g, "_"),
          matched_text: entry.text,
          severity: entry.severity,
          category: entry.category,
        });
      }
    }

    return matches;
  }

  private contextAround(text: string, target: string, radius: number): string {
    const idx = text.indexOf(target);
    if (idx < 0) return "";
    const start = Math.max(0, idx - radius);
    const end = Math.min(text.length, idx + target.length + radius);
    return text.slice(start, end);
  }

  private isInAllowlistContext(ctx: string): boolean {
    for (const allowed of this.allowlist) {
      if (ctx.includes(allowed.toLowerCase())) return true;
    }
    return false;
  }
}

// ─── Regex Engine ──────────────────────────────────────────────────────

interface CompiledPattern {
  rule_id: string;
  pattern: RegExp;
  severity: number;
  category: string;
  mask: string; // replacement template, e.g. "***-****-****"
}

const DEFAULT_PATTERNS: CompiledPattern[] = [
  // China ID card (18 digits, last may be X)
  {
    rule_id: "REGEX_PII_ID_CARD_CN",
    pattern: /\b\d{17}[\dXx]\b/g,
    severity: 2,
    category: "pii",
    mask: "********************XX",
  },
  // China mobile phone
  {
    rule_id: "REGEX_PII_PHONE_CN",
    pattern: /\b1[3-9]\d{9}\b/g,
    severity: 2,
    category: "pii",
    mask: "***********",
  },
  // Bank card (16-19 digits)
  {
    rule_id: "REGEX_PII_BANK_CARD",
    pattern: /\b\d{16,19}\b/g,
    severity: 2,
    category: "pii",
    mask: "****************",
  },
  // Intranet IPv4 (10.x / 172.16-31.x / 192.168.x)
  {
    rule_id: "REGEX_INTRANET_IP",
    pattern: /\b(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)\d{1,3}\.\d{1,3}\b/g,
    severity: 2,
    category: "intranet_leak",
    mask: "x.x.x.x",
  },
  // Generic email
  {
    rule_id: "REGEX_PII_EMAIL",
    pattern: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g,
    severity: 1,
    category: "pii",
    mask: "***@***.***",
  },
];

export class RegexEngine {
  private patterns: CompiledPattern[];

  constructor(patterns?: CompiledPattern[]) {
    this.patterns = patterns ?? DEFAULT_PATTERNS;
  }

  scan(text: string): SecurityMatch[] {
    const matches: SecurityMatch[] = [];
    for (const p of this.patterns) {
      const found = text.match(p.pattern);
      if (found) {
        for (const m of found.slice(0, 5)) { // cap matches per rule
          matches.push({
            engine: "regex",
            rule_id: p.rule_id,
            matched_text: m.length > 20 ? m.slice(0, 20) + "..." : m,
            severity: p.severity,
            category: p.category,
          });
        }
      }
    }
    return matches;
  }

  /**
   * Return text with all sensitive patterns masked.
   */
  mask(text: string): string {
    let out = text;
    for (const p of this.patterns) {
      out = out.replace(p.pattern, p.mask);
    }
    return out;
  }
}

// ─── Decision Engine ───────────────────────────────────────────────────

export class DecisionEngine {
  decide(matches: SecurityMatch[]): {
    action: FilterAction;
    severity: number;
    reason?: string;
  } {
    if (matches.length === 0) {
      return { action: "approve", severity: 0 };
    }
    const maxSev = Math.max(...matches.map((m) => m.severity));
    if (maxSev >= 4) {
      const blockers = matches.filter((m) => m.severity >= 4);
      return {
        action: "block",
        severity: maxSev,
        reason: `Blocked by ${blockers.length} rule(s): ${blockers.map((m) => m.rule_id).slice(0, 3).join(", ")}`,
      };
    }
    if (maxSev >= 3) {
      return {
        action: "sanitize",
        severity: maxSev,
        reason: `Sanitized: ${matches.length} match(es) at severity ${maxSev}`,
      };
    }
    return {
      action: "sanitize",
      severity: maxSev,
      reason: `Auto-masked ${matches.length} PII match(es)`,
    };
  }
}

// ─── SecurityGateway facade ────────────────────────────────────────────

export class SecurityGateway {
  private wordEngine: WordEngine;
  private regexEngine: RegexEngine;
  private decisionEngine: DecisionEngine;
  private enabled: boolean;
  private failOpen: boolean;

  constructor(opts?: {
    enabled?: boolean;
    failOpen?: boolean;
    wordEngine?: WordEngine;
    regexEngine?: RegexEngine;
    decisionEngine?: DecisionEngine;
  }) {
    this.enabled = opts?.enabled ?? (process.env.SECURITY_GATEWAY_ENABLED !== "false");
    this.failOpen = opts?.failOpen ?? (process.env.SECURITY_GATEWAY_FAIL_OPEN !== "false");
    this.wordEngine = opts?.wordEngine ?? new WordEngine();
    this.regexEngine = opts?.regexEngine ?? new RegexEngine();
    this.decisionEngine = opts?.decisionEngine ?? new DecisionEngine();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async filterInput(text: string, ctx?: SecurityContext): Promise<FilterResult> {
    const t0 = Date.now();
    if (!this.enabled) {
      return { action: "approve", matches: [], severity: 0, duration_ms: 0 };
    }
    try {
      return this.runFilters(text, ctx);
    } catch (err) {
      console.error("[SecurityGateway] filterInput error:", err);
      if (this.failOpen) {
        return {
          action: "approve",
          matches: [],
          severity: 0,
          duration_ms: Date.now() - t0,
          reason: "fail_open: engine error",
        };
      }
      return {
        action: "block",
        matches: [],
        severity: 5,
        duration_ms: Date.now() - t0,
        reason: "fail_closed: engine error",
      };
    }
  }

  async filterOutput(text: string, ctx?: SecurityContext): Promise<FilterResult> {
    return this.filterInput(text, ctx);
  }

  async checkTool(
    toolName: string,
    args: unknown,
    ctx?: SecurityContext,
  ): Promise<FilterResult> {
    const t0 = Date.now();
    if (!this.enabled) {
      return { action: "approve", matches: [], severity: 0, duration_ms: 0 };
    }
    try {
      const argsText = typeof args === "string" ? args : JSON.stringify(args ?? {});
      const result = this.runFilters(`${toolName} ${argsText}`, ctx);
      return result;
    } catch (err) {
      console.error("[SecurityGateway] checkTool error:", err);
      if (this.failOpen) {
        return {
          action: "approve",
          matches: [],
          severity: 0,
          duration_ms: Date.now() - t0,
          reason: "fail_open",
        };
      }
      return {
        action: "block",
        matches: [],
        severity: 5,
        duration_ms: Date.now() - t0,
        reason: "fail_closed",
      };
    }
  }

  private runFilters(text: string, _ctx?: SecurityContext): FilterResult {
    const t0 = Date.now();
    const wordMatches = this.wordEngine.scan(text);
    const regexMatches = this.regexEngine.scan(text);
    const all = [...wordMatches, ...regexMatches];

    const decision = this.decisionEngine.decide(all);

    let sanitized: string | undefined;
    if (decision.action === "sanitize") {
      sanitized = this.regexEngine.mask(text);
    }

    return {
      action: decision.action,
      reason: decision.reason,
      sanitized,
      matches: all,
      severity: decision.severity,
      duration_ms: Date.now() - t0,
    };
  }
}

// ─── Singleton accessor ────────────────────────────────────────────────

let gatewayInstance: SecurityGateway | null = null;

export function getSecurityGateway(): SecurityGateway {
  if (!gatewayInstance) {
    gatewayInstance = new SecurityGateway();
  }
  return gatewayInstance;
}

export function resetSecurityGateway(opts?: ConstructorParameters<typeof SecurityGateway>[0]): void {
  gatewayInstance = opts ? new SecurityGateway(opts) : null;
}
