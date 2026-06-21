/**
 * RedFlag Scanner — 15 条安全红线扫描（Phase 3 PublishGate 第 1 维）
 *
 * 参考 DAclaw redflag_scanner.py:60-249
 *
 * 每条规则有：id, severity (CRITICAL/HIGH/MEDIUM), pattern, description
 * CRITICAL 命中即阻断发布。
 */

export interface RedFlagHit {
  rule_id: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM";
  line: number;
  snippet: string;
  description: string;
}

export interface RedFlagResult {
  hits: RedFlagHit[];
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  passed: boolean; // true if no CRITICAL
}

interface Rule {
  id: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM";
  pattern: RegExp;
  description: string;
}

const RULES: Rule[] = [
  // RF01: curl/wget pipe to shell
  {
    id: "RF01",
    severity: "CRITICAL",
    pattern: /(curl|wget)\b[^|;\n]*\|\s*(sh|bash|zsh|python|perl|ruby|tee)/i,
    description: "curl/wget output piped to shell interpreter (RCE risk)",
  },
  // RF02: send data to external server
  {
    id: "RF02",
    severity: "HIGH",
    pattern: /(curl|wget|fetch|http\.request|requests\.(post|put|get))\b[^;\n]*(?:POST|PUT|upload|send|payload)/i,
    description: "Possible data exfiltration to external server",
  },
  // RF03: hardcoded credentials
  {
    id: "RF03",
    severity: "CRITICAL",
    pattern: /(api[_-]?key|secret|password|passwd|token|bearer)\s*[=:]\s*['"][A-Za-z0-9_\-]{16,}['"]/i,
    description: "Hardcoded credential/token in content",
  },
  // RF04: read sensitive system paths
  {
    id: "RF04",
    severity: "CRITICAL",
    pattern: /(?:~\/\.ssh\/|~\/\.aws\/|~\/\.gnupg\/|\/etc\/shadow|\/etc\/passwd|\/root\/\.)/i,
    description: "Reads sensitive system paths (SSH keys, AWS creds, etc.)",
  },
  // RF05: read agent identity/memory files
  {
    id: "RF05",
    severity: "CRITICAL",
    pattern: /(?:\.claude\/|CLAUDE\.md|AGENT\.md|\.cursor\/|agent[_-]?memory|agent[_-]?identity)/i,
    description: "Attempts to read Agent identity or memory files",
  },
  // RF06: base64 decode/encode
  {
    id: "RF06",
    severity: "CRITICAL",
    pattern: /(?:base64\s+(--decode|-d)|atob\(|frombase64|base64\.decode)/i,
    description: "Base64 decoding (obfuscation risk)",
  },
  // RF07: dynamic code execution
  {
    id: "RF07",
    severity: "CRITICAL",
    pattern: /(?:\beval\s*\(|\bexec\s*\(|os\.system\(|subprocess\.(call|run|Popen)|child_process\.exec)/i,
    description: "Dynamic code execution (eval/exec/system)",
  },
  // RF08: privilege escalation
  {
    id: "RF08",
    severity: "CRITICAL",
    pattern: /(?:sudo\s+|su\s+|chmod\s+[0-7]{3,4}|chown\s+|--privileged|setuid)/i,
    description: "Privilege escalation attempt",
  },
  // RF09: install undeclared packages
  {
    id: "RF09",
    severity: "HIGH",
    pattern: /(?:npm\s+install|pip\s+install|apt(?:-get)?\s+install|yum\s+install|brew\s+install)\s+(?![-\w]+\s*$)/i,
    description: "Installs undeclared third-party packages",
  },
  // RF10: network calls to raw IP addresses
  {
    id: "RF10",
    severity: "HIGH",
    pattern: /(?:https?:\/\/|@)(?:\d{1,3}\.){3}\d{1,3}/,
    description: "Network call to raw IP address (no DNS)",
  },
  // RF11: obfuscation
  {
    id: "RF11",
    severity: "CRITICAL",
    pattern: /(?:\\x[0-9a-f]{2}\\x[0-9a-f]{2}\\x[0-9a-f]{2}|String\.fromCharCode|chr\(\d+\)\s*\+\s*chr\(\d+\))/i,
    description: "Obfuscated/encoded payload",
  },
  // RF12: extract browser cookies/sessions
  {
    id: "RF12",
    severity: "CRITICAL",
    pattern: /(?:cookies\.sqlite|Chrome\/User Data|Firefox\/Profiles|extract.*cookie|steal.*session)/i,
    description: "Extracts browser cookies/sessions",
  },
  // RF13: reference credential filenames
  {
    id: "RF13",
    severity: "CRITICAL",
    pattern: /(?:id_rsa|id_ecdsa|\.pem|\.p12|\.key|credentials\.json|service[_-]?account)/i,
    description: "Directly references credential filenames",
  },
  // RF14: recursive/forced delete
  {
    id: "RF14",
    severity: "HIGH",
    pattern: /(?:rm\s+-rf\s|del\s+\/[sS]|Remove-Item\s+-Recurse\s+-Force|rmtree\()/i,
    description: "Recursive/forced delete operation",
  },
  // RF15: SQL destructive operations (DROP/TRUNCATE/mass DELETE/UNION injection)
  {
    id: "RF15",
    severity: "CRITICAL",
    pattern: /(?:DROP\s+(?:TABLE|DATABASE|SCHEMA|INDEX)\b|TRUNCATE\s+(?:TABLE\s+)?[\w.]+|DELETE\s+FROM\s+[\w.]+\s*;|\bUNION\s+SELECT\s+[\w*,\s]+\s+FROM\b)/i,
    description: "SQL destructive operation (DROP TABLE / TRUNCATE / mass DELETE / UNION injection)",
  },
];

export function scanContent(content: string): RedFlagResult {
  const hits: RedFlagHit[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const rule of RULES) {
      // Avoid double-matching the same rule+line
      if (rule.pattern.test(line)) {
        const snippet = line.trim().slice(0, 100);
        hits.push({
          rule_id: rule.id,
          severity: rule.severity,
          line: i + 1,
          snippet,
          description: rule.description,
        });
      }
    }
  }

  const criticalCount = hits.filter((h) => h.severity === "CRITICAL").length;
  const highCount = hits.filter((h) => h.severity === "HIGH").length;
  const mediumCount = hits.filter((h) => h.severity === "MEDIUM").length;

  return {
    hits,
    criticalCount,
    highCount,
    mediumCount,
    passed: criticalCount === 0,
  };
}
