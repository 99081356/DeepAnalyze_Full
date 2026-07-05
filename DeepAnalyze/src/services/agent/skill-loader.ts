/**
 * Skill loader supporting SKILL.md format (YAML frontmatter + Markdown body).
 * Also supports loading skills from directories containing SKILL.md files.
 *
 * Compatible with both DA and Claude Code (CC) / OpenClaw skill formats.
 * CC format uses `allowed-tools` (DA uses `tools`), `model` (DA uses `model-role`),
 * `name` in frontmatter (DA derives from directory name), and other CC-specific fields.
 */

export interface SkillRequires {
  /** Required CLI binaries (e.g. ["gh", "git"]) */
  bins?: string[];
  /** Any of these binaries must be available (e.g. ["docker", "podman"]) */
  anyBins?: string[];
  /** Required tools by name (e.g. ["bash", "web_search"]) */
  tools?: string[];
  /** Required capabilities (e.g. ["embedding", "vlm"]) */
  capabilities?: string[];
  /** Required model constraints (e.g. "tool_use", "vision") */
  modelFeatures?: string[];
  /** Required environment variables */
  env?: string[];
  /** OS constraints (e.g. ["linux", "darwin"]) */
  os?: string[];
}

export interface SkillInstallStep {
  /** Installation method */
  kind: "brew" | "npm" | "apt" | "pip" | "download" | "git";
  /** Package name or formula */
  package?: string;
  /** Label for display */
  label?: string;
}

export interface SkillManifest {
  name: string;
  description: string;
  tools: string[];
  modelRole?: string;
  scheduling?: "pipeline" | "graph" | "council" | "parallel" | "single";
  arguments?: Array<{ name: string; description: string; required: boolean }>;
  systemPrompt: string;
  /** Anti-hallucination strictness level (e.g. "strict", "moderate", "none") */
  antiHallucinationLevel?: string;
  /** When to use this skill — detailed usage scenarios (from CC's when_to_use) */
  whenToUse?: string;

  // --- Enhanced metadata ---

  /** Keywords/patterns that trigger automatic skill matching */
  triggers?: string[];
  /** Requirements for skill to function */
  requires?: SkillRequires;
  /** Tags for categorization and discovery */
  tags?: string[];
  /** Installation instructions for required dependencies */
  install?: SkillInstallStep[];
  /** External documentation URL */
  homepage?: string;
  /** Version string */
  version?: string;
  /** Author */
  author?: string;
  /** Emoji icon for UI display */
  emoji?: string;
}

// ---------------------------------------------------------------------------
// CC model name → DA model-role mapping
// ---------------------------------------------------------------------------

function mapCCModel(model: unknown): string | undefined {
  if (!model || typeof model !== "string") return undefined;
  const m = model.toLowerCase().trim();
  if (!m || m === "inherit" || m === "default") return "main";
  // DA doesn't distinguish between model sizes at the skill level;
  // all CC model names map to "main" role
  return "main";
}

// ---------------------------------------------------------------------------
// CC tool list parsing
// ---------------------------------------------------------------------------

/**
 * Parse a tool list value that may be in CC or DA format.
 * CC: space-separated string "bash read_file write_file" or YAML array
 * DA: comma-separated in brackets [a, b, c] or YAML array
 */
function parseToolsValue(
  raw: unknown,
  meta: Record<string, unknown>,
): string[] {
  // Try DA's "tools" field first, then CC's "allowed-tools"
  const value = raw ?? meta["allowed-tools"];
  if (!value) return ["*"];

  if (Array.isArray(value)) return value as string[];

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || trimmed === "*") return ["*"];

    // Bracket-delimited array: [a, b, c]
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      return trimmed
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }

    // CC space-separated format: "bash read_file write_file"
    // Detect: if the string contains spaces and no commas, treat as space-separated
    if (trimmed.includes(" ") && !trimmed.includes(",")) {
      return trimmed.split(/\s+/).filter(Boolean);
    }

    // Single tool name or comma-separated
    return trimmed.split(",").map((s) => s.trim()).filter(Boolean);
  }

  return ["*"];
}

// ---------------------------------------------------------------------------
// Skill name derivation
// ---------------------------------------------------------------------------

function deriveSkillName(fileName: string): string {
  return fileName
    .replace(/\.md$/i, "")
    .replace(/SKILL$/i, "")
    .replace(/\/$/, "");
}

// ---------------------------------------------------------------------------
// parseSkillMd — parse a SKILL.md file into a SkillManifest
// ---------------------------------------------------------------------------

/**
 * Parse a SKILL.md file into a SkillManifest.
 *
 * Supports both DA and CC/OpenClaw frontmatter formats:
 *
 * DA format:
 * ---
 * description: Skill description
 * tools: [kb_search, expand]
 * model-role: main
 * ---
 *
 * CC format:
 * ---
 * name: my-skill
 * description: What this skill does
 * when_to_use: Use when you need to...
 * allowed-tools: bash read_file write_file
 * model: sonnet
 * argument-hint: [issue-number]
 * ---
 */
export function parseSkillMd(content: string, fileName: string): SkillManifest {
  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!frontmatterMatch) {
    throw new Error(`Invalid SKILL.md format: ${fileName}. Missing frontmatter.`);
  }

  const yaml = frontmatterMatch[1]!;
  const body = frontmatterMatch[2]!.trim();
  const meta = parseSimpleYaml(yaml);

  // Name: CC allows `name` in frontmatter; DA derives from file/dir name
  const name = typeof meta.name === "string" && meta.name.trim()
    ? meta.name.trim()
    : deriveSkillName(fileName);

  // Description: CC supports `when_to_use` as a separate field
  const rawDescription = typeof meta.description === "string" && meta.description.trim()
    ? meta.description.trim()
    : "";
  const whenToUse = typeof meta.when_to_use === "string" && meta.when_to_use.trim()
    ? meta.when_to_use.trim()
    : undefined;
  // For DB storage, merge whenToUse into description (backward compat)
  // For in-memory use, keep whenToUse as a separate field
  const description = whenToUse
    ? `${rawDescription} — ${whenToUse}`
    : rawDescription;

  // Tools: DA uses `tools`, CC uses `allowed-tools`
  const tools = parseToolsValue(meta.tools, meta);

  // Model: DA uses `model-role`, CC uses `model`
  const modelRole =
    (typeof meta["model-role"] === "string" ? meta["model-role"] : undefined) ??
    mapCCModel(meta.model) ??
    "main";

  // Scheduling: DA-specific
  const scheduling = meta.scheduling as SkillManifest["scheduling"];

  // Arguments: DA has structured format; CC has `argument-hint` and simple `arguments`
  const arguments_ = meta.arguments as SkillManifest["arguments"];

  // Anti-hallucination: DA-specific
  const antiHallucinationLevel = meta["anti-hallucination-level"] as string | undefined;

  // Enhanced metadata fields
  const triggers = typeof meta.triggers === "string"
    ? (meta.triggers as string).split(",").map(s => s.trim()).filter(Boolean)
    : Array.isArray(meta.triggers) ? meta.triggers as string[] : undefined;

  const metaRequires = meta.requires as Record<string, unknown> | undefined;
  const requires: SkillManifest["requires"] = metaRequires ? {
    bins: metaRequires.bins as string[] | undefined,
    anyBins: metaRequires["any-bins"] as string[] | undefined ?? metaRequires.anyBins as string[] | undefined,
    tools: metaRequires.tools as string[] | undefined,
    capabilities: metaRequires.capabilities as string[] | undefined,
    modelFeatures: metaRequires["model-features"] as string[] | undefined ?? metaRequires.modelFeatures as string[] | undefined,
    env: metaRequires.env as string[] | undefined,
    os: metaRequires.os as string[] | undefined,
  } : undefined;

  const tags = typeof meta.tags === "string"
    ? (meta.tags as string).split(",").map(s => s.trim()).filter(Boolean)
    : Array.isArray(meta.tags) ? meta.tags as string[] : undefined;

  const metaInstall = meta.install as Array<Record<string, unknown>> | undefined;
  const install: SkillManifest["install"] = metaInstall?.map(step => ({
    kind: ((step.kind as string) ?? "npm") as SkillInstallStep["kind"],
    package: step.package as string | undefined,
    label: step.label as string | undefined,
  }));

  // OpenClaw compatibility: metadata.openclaw.emoji → emoji
  const openclawMeta = (meta.metadata as Record<string, unknown>)?.openclaw as Record<string, unknown> | undefined;
  const emoji = (meta.emoji as string | undefined)
    ?? (openclawMeta?.emoji as string | undefined);

  return {
    name,
    description,
    tools,
    modelRole,
    scheduling,
    arguments: arguments_,
    antiHallucinationLevel,
    whenToUse,
    systemPrompt: body,
    triggers,
    requires,
    tags,
    install,
    homepage: meta.homepage as string | undefined,
    version: meta.version as string | undefined,
    author: meta.author as string | undefined,
    emoji,
  };
}

// ---------------------------------------------------------------------------
// loadSkillsFromDir
// ---------------------------------------------------------------------------

/**
 * Resolve `<!-- @include relative/path.md -->` directives in skill content.
 * Path is resolved relative to the file that contains the directive, so skills
 * can reference shared specs via `<!-- @include ../_shared/foo.md -->`.
 *
 * Recursion is limited to 5 levels. Missing files are replaced with an error
 * comment so the issue is visible when the skill is invoked.
 */
async function resolveIncludes(
  content: string,
  baseDir: string,
  depth = 0,
): Promise<string> {
  if (depth > 5) return content;

  const includeRegex = /<!--\s*@include\s+([^\s>]+)\s*-->/g;
  const matches = Array.from(content.matchAll(includeRegex));
  if (matches.length === 0) return content;

  const { readFile } = await import("fs/promises");
  const path = await import("path");

  const uniquePaths = Array.from(new Set(matches.map((m) => m[1] as string)));
  const resolutions = new Map<string, string>();

  for (const relPath of uniquePaths) {
    const fullPath = path.resolve(baseDir, relPath);
    try {
      const included = await readFile(fullPath, "utf-8");
      const resolved = await resolveIncludes(included, path.dirname(fullPath), depth + 1);
      resolutions.set(relPath, resolved);
    } catch {
      resolutions.set(relPath, `<!-- @include ERROR: ${relPath} not found at ${fullPath} -->`);
    }
  }

  return content.replace(includeRegex, (_match, relPath: string) =>
    resolutions.get(relPath) ?? `<!-- @include ERROR: ${relPath} unresolved -->`,
  );
}

/**
 * Load all SKILL.md files from a directory.
 *
 * Scanning strategy:
 * 1. Direct subdirectories containing SKILL.md (case-insensitive)
 * 2. Direct .md files (treated as skill files)
 * 3. If nothing found and recursive=true, recurse one level into subdirectories
 *
 * This matches both DA's flat structure and CC's potentially nested structure.
 */
export async function loadSkillsFromDir(dirPath: string, recursive = true): Promise<SkillManifest[]> {
  const { readdir, readFile, stat } = await import("fs/promises");
  const path = await import("path");

  const skills: SkillManifest[] = [];
  let entries;

  try {
    entries = await readdir(dirPath);
  } catch {
    return skills;
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry);
    try {
      const s = await stat(fullPath);
      if (s.isDirectory()) {
        // Check for SKILL.md (case-insensitive) in subdirectory
        const skillFile = await findSkillFile(fullPath);
        if (skillFile) {
          const raw = await readFile(skillFile, "utf-8");
          const content = await resolveIncludes(raw, path.dirname(skillFile));
          skills.push(parseSkillMd(content, entry));
        }
      } else if (isSkillMdFile(entry)) {
        // Direct .md file (SKILL.md or any .md in the skills directory)
        const raw = await readFile(fullPath, "utf-8");
        const content = await resolveIncludes(raw, dirPath);
        const name = /^skill\.md$/i.test(entry) ? path.basename(dirPath) : entry;
        skills.push(parseSkillMd(content, name));
      }
    } catch { /* skip */ }
  }

  // Recursive fallback: if no skills found at this level, try one level deeper
  if (skills.length === 0 && recursive) {
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry);
      try {
        const s = await stat(fullPath);
        if (s.isDirectory()) {
          const subSkills = await loadSkillsFromDir(fullPath, false);
          skills.push(...subSkills);
        }
      } catch { /* skip */ }
    }
  }

  return skills;
}

/**
 * Find a SKILL.md file in a directory (case-insensitive).
 */
async function findSkillFile(dirPath: string): Promise<string | null> {
  const { readdir } = await import("fs/promises");
  const path = await import("path");
  try {
    const files = await readdir(dirPath);
    for (const file of files) {
      if (/^skill\.md$/i.test(file)) {
        return path.join(dirPath, file);
      }
    }
  } catch { /* not a dir */ }
  return null;
}

/**
 * Check if a filename looks like a skill markdown file.
 * Matches SKILL.md (any case) or any .md file.
 */
function isSkillMdFile(fileName: string): boolean {
  return /\.md$/i.test(fileName);
}

// ---------------------------------------------------------------------------
// Simple YAML parser for frontmatter
// ---------------------------------------------------------------------------

/**
 * Simple YAML parser for frontmatter.
 * Uses recursive descent with indent-based scoping.
 * Handles: key: value, key: [a, b], - list items, nested objects, and arrays of objects.
 * Supports hyphenated keys (e.g. `allowed-tools`, `model-role`).
 */
function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const lines = yaml.split("\n");
  let pos = 0;

  function getIndent(lineIdx: number): number {
    return lines[lineIdx]!.search(/\S/);
  }

  function stripQuotes(s: string): string {
    if (
      ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) &&
      s.length >= 2
    ) {
      return s.slice(1, -1);
    }
    return s;
  }

  function parseInlineArray(value: string): string[] {
    return value
      .slice(1, -1)
      .split(",")
      .map((s) => stripQuotes(s.trim()))
      .filter(Boolean);
  }

  function parseValue(raw: string): unknown {
    const v = raw.trim();
    if (v.startsWith("[") && v.endsWith("]")) return parseInlineArray(v);
    return stripQuotes(v);
  }

  /**
   * Parse an object block: consecutive key-value lines at indent >= minIndent.
   * Stops when encountering a line at lower indent or end of input.
   */
  function parseObject(minIndent: number): Record<string, unknown> {
    const obj: Record<string, unknown> = {};

    while (pos < lines.length) {
      const line = lines[pos]!;
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        pos++;
        continue;
      }

      const indent = getIndent(pos);
      if (indent < minIndent) break;

      // Array items are not part of an object — caller handles them
      if (trimmed.startsWith("- ")) break;

      // Key: value
      const kvMatch = trimmed.match(/^([\w-]+):\s*(.*)$/);
      if (!kvMatch) {
        pos++;
        continue;
      }

      const key = kvMatch[1]!;
      const value = kvMatch[2]!.trim();
      pos++;

      if (value) {
        obj[key] = parseValue(value);
      } else {
        // No inline value — look at next non-empty line
        const childIndent = peekNextIndent();
        if (childIndent < 0) {
          // No more content
          obj[key] = null;
        } else if (childIndent <= indent) {
          // Next line is at same/lower level — empty value
          obj[key] = null;
        } else {
          // Next line is indented deeper
          const nextTrimmed = lines[pos]!.trim();
          if (nextTrimmed.startsWith("- ")) {
            obj[key] = parseArray(childIndent);
          } else {
            obj[key] = parseObject(childIndent);
          }
        }
      }
    }

    return obj;
  }

  /**
   * Parse an array block: consecutive "- " items at exactly itemIndent.
   */
  function parseArray(itemIndent: number): unknown[] {
    const arr: unknown[] = [];

    while (pos < lines.length) {
      const line = lines[pos]!;
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        pos++;
        continue;
      }

      const indent = getIndent(pos);
      if (indent !== itemIndent) break;
      if (!trimmed.startsWith("- ")) break;

      const itemText = trimmed.slice(2).trim();
      pos++;

      // Check for "- key: value" (object item with sub-keys)
      const kvMatch = itemText.match(/^([\w-]+):\s*(.*)$/);
      if (kvMatch) {
        const obj: Record<string, unknown> = {};
        const subKey = kvMatch[1]!;
        const subVal = kvMatch[2]!.trim();
        if (subVal) {
          obj[subKey] = parseValue(subVal);
        }

        // Read additional sub-properties at higher indent
        while (pos < lines.length) {
          const subLine = lines[pos]!;
          const subTrimmed = subLine.trim();
          if (!subTrimmed || subTrimmed.startsWith("#")) {
            pos++;
            continue;
          }
          const subIndent = getIndent(pos);
          if (subIndent <= itemIndent) break;

          const subKv = subTrimmed.match(/^([\w-]+):\s*(.*)$/);
          if (subKv) {
            const k = subKv[1]!;
            const v = subKv[2]!.trim();
            obj[k] = v ? parseValue(v) : null;
            pos++;
          } else {
            break;
          }
        }

        arr.push(obj);
      } else {
        arr.push(stripQuotes(itemText));
      }
    }

    return arr;
  }

  /** Peek at the indent of the next non-empty, non-comment line. Returns -1 if none. */
  function peekNextIndent(): number {
    for (let i = pos; i < lines.length; i++) {
      const t = lines[i]!.trim();
      if (t && !t.startsWith("#")) return getIndent(i);
    }
    return -1;
  }

  return parseObject(0);
}
