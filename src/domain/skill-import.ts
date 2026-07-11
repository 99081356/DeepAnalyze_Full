// =============================================================================
// DeepAnalyze Hub - Skill Import Parser
// =============================================================================
//
// Parses uploaded skill files (SKILL.md / JSON / ZIP) into marketplace_skill
// payloads for the admin import endpoint (POST /api/v1/marketplace/skills/import).
//
// This is a self-contained port of DeepAnalyze's parseSkillMd() so the Hub
// (which runs on Bun and has no yaml dependency) can parse SKILL.md files
// without calling into the DA worker. The bundled parseSimpleYaml handles
// the frontmatter subset used by DA / Claude Code / OpenClaw skill formats.
//
// ZIP support is lazy: adm-zip is only required when a .zip is uploaded.
// =============================================================================

import path from "node:path";

/** A skill parsed from an uploaded file, ready to insert into marketplace_skills. */
export interface ParsedMarketplaceSkill {
  name: string;
  description: string;
  prompt: string;
  tools: string[];
  modelRole: string;
  tags: string[];
  version: string;
  antiHallucinationLevel?: string;
  triggers?: string[];
  homepage?: string;
  author?: string;
}

/** Normalized shape returned to the route handler. */
export async function parseSkillFile(
  file: File,
): Promise<ParsedMarketplaceSkill[]> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".md")) {
    const content = await file.text();
    return [manifestToMarketplace(parseSkillMd(content, file.name))];
  }
  if (lower.endsWith(".json")) {
    const text = await file.text();
    return [parseJsonSkill(text, file.name)];
  }
  if (lower.endsWith(".zip")) {
    return parseZipSkill(file);
  }
  throw new Error(`不支持的文件格式: ${file.name}。仅支持 .md / .json / .zip。`);
}

/**
 * Parse a JSON folder bundle — {path, content}[] serialized by the client.
 * Scans for SKILL.md, parses each. (Hub stores only skill content.)
 */
export async function parseSkillBundle(
  files: Array<{ path: string; content: string }>,
): Promise<ParsedMarketplaceSkill[]> {
  if (files.length === 0) {
    throw new Error("未收到任何文件。");
  }

  const skillFiles = files.filter((f) => /(^|\/)skill\.md$/i.test(f.path));
  if (skillFiles.length === 0) {
    throw new Error("文件夹中未找到 SKILL.md 文件。");
  }

  const parsed: ParsedMarketplaceSkill[] = [];
  for (const { path: relPath, content } of skillFiles) {
    const folderName = relPath.includes("/")
      ? relPath.split("/").slice(-2, -1)[0] || relPath
      : relPath;
    parsed.push(manifestToMarketplace(parseSkillMd(content, folderName)));
  }
  return parsed;
}

/**
 * Parse a folder upload — multiple File objects whose names encode the
 * relative path (e.g. "my-skill/SKILL.md"). Scans for SKILL.md entries,
 * parses each. (Hub marketplace stores only skill content, not resource
 * files, so no disk extraction is needed here.)
 */
export async function parseSkillFiles(
  files: File[],
): Promise<ParsedMarketplaceSkill[]> {
  if (files.length === 0) {
    throw new Error("未收到任何文件。");
  }

  // The client bakes the folder structure into File.name (e.g.
  // "my-skill/SKILL.md") since FormData doesn't transmit webkitRelativePath.
  const skillFiles = files.filter((f) => /(^|\/)skill\.md$/i.test(f.name));
  if (skillFiles.length === 0) {
    throw new Error("文件夹中未找到 SKILL.md 文件。");
  }

  const parsed: ParsedMarketplaceSkill[] = [];
  for (const file of skillFiles) {
    // Derive skill folder name from the path: "my-skill/SKILL.md" → "my-skill"
    const folderName = file.name.includes("/")
      ? file.name.split("/").slice(-2, -1)[0] || file.name
      : file.name;
    const content = await file.text();
    parsed.push(manifestToMarketplace(parseSkillMd(content, folderName)));
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Manifest type (mirrors DA's SkillManifest subset)
// ---------------------------------------------------------------------------

interface SkillManifest {
  name: string;
  description: string;
  tools: string[];
  modelRole?: string;
  systemPrompt: string;
  antiHallucinationLevel?: string;
  whenToUse?: string;
  triggers?: string[];
  tags?: string[];
  homepage?: string;
  version?: string;
  author?: string;
  emoji?: string;
}

function manifestToMarketplace(m: SkillManifest): ParsedMarketplaceSkill {
  return {
    name: m.name,
    description: m.description,
    prompt: m.systemPrompt,
    tools: m.tools,
    modelRole: m.modelRole ?? "main",
    tags: m.tags ?? [],
    version: m.version ?? "1.0.0",
    antiHallucinationLevel: m.antiHallucinationLevel,
    triggers: m.triggers,
    homepage: m.homepage,
    author: m.author,
  };
}

// ---------------------------------------------------------------------------
// JSON parsing
// ---------------------------------------------------------------------------

function parseJsonSkill(text: string, fileName: string): ParsedMarketplaceSkill {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error(`JSON 解析失败: ${fileName}`);
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    throw new Error(`JSON 技能文件必须是对象: ${fileName}`);
  }

  const name = pickString(obj.name) ?? pickString(obj.slug);
  const prompt = pickString(obj.prompt) ?? pickString(obj.systemPrompt);
  if (!name || !prompt) {
    throw new Error(`JSON 技能缺少必填字段 name/prompt: ${fileName}`);
  }

  return {
    name,
    description: pickString(obj.description) ?? "",
    prompt,
    tools: pickStringArray(obj.tools) ?? ["*"],
    modelRole: pickString(obj.modelRole) ?? pickString(obj.model_role) ?? "main",
    tags: pickStringArray(obj.tags) ?? [],
    version: pickString(obj.version) ?? "1.0.0",
    antiHallucinationLevel:
      pickString(obj.antiHallucinationLevel) ??
      pickString(obj.anti_hallucination_level),
    triggers: pickStringArray(obj.triggers),
    homepage: pickString(obj.homepage),
    author: pickString(obj.author),
  };
}

// ---------------------------------------------------------------------------
// ZIP parsing (lazy adm-zip import)
// ---------------------------------------------------------------------------

async function parseZipSkill(file: File): Promise<ParsedMarketplaceSkill[]> {
  const mod = (await import("adm-zip").catch(() => null)) as
    typeof import("adm-zip") | null;
  if (!mod) {
    throw new Error(
      "ZIP 导入需要 adm-zip 依赖，请先安装（或改用 .md / .json 导入）。",
    );
  }
  // adm-zip is a CommonJS module; under ESM/Bun the namespace object wraps the
  // constructor in `.default`. Fall back to the namespace itself for CJS.
  const AdmZip = (mod as unknown as { default?: typeof import("adm-zip") })
    .default ?? mod;

  const buf = Buffer.from(await file.arrayBuffer());
  const zip = new AdmZip(buf);
  const entries = zip.getEntries();
  const skillEntries = entries.filter(
    (e) => /(^|\/)skill\.md$/i.test(e.entryName) && !e.isDirectory,
  );
  if (skillEntries.length === 0) {
    throw new Error("ZIP 包内未找到 SKILL.md 文件。");
  }

  const parsed: ParsedMarketplaceSkill[] = [];
  for (const entry of skillEntries) {
    const entryDir = path.posix.dirname(entry.entryName);
    const folderName = path.posix.basename(entryDir) || "skill";
    const content = entry.getData().toString("utf-8");
    const manifest = parseSkillMd(content, folderName);
    parsed.push(manifestToMarketplace(manifest));
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// parseSkillMd + parseSimpleYaml — ported from
// DeepAnalyze/src/services/agent/skill-loader.ts (self-contained, no yaml dep)
// ---------------------------------------------------------------------------

export function parseSkillMd(content: string, fileName: string): SkillManifest {
  const frontmatterMatch = content.match(
    /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n([\s\S]*)$/,
  );
  if (!frontmatterMatch) {
    throw new Error(`Invalid SKILL.md format: ${fileName}. Missing frontmatter.`);
  }

  const yaml = frontmatterMatch[1]!;
  const body = frontmatterMatch[2]!.trim();
  const meta = parseSimpleYaml(yaml);

  const name =
    typeof meta.name === "string" && meta.name.trim()
      ? meta.name.trim()
      : deriveSkillName(fileName);

  const rawDescription =
    typeof meta.description === "string" && meta.description.trim()
      ? meta.description.trim()
      : "";
  const whenToUse =
    typeof meta.when_to_use === "string" && meta.when_to_use.trim()
      ? meta.when_to_use.trim()
      : undefined;
  const description = whenToUse
    ? `${rawDescription} — ${whenToUse}`
    : rawDescription;

  const tools = parseToolsValue(meta.tools, meta);
  const modelRole =
    (typeof meta["model-role"] === "string"
      ? meta["model-role"]
      : undefined) ??
    mapCCModel(meta.model) ??
    "main";
  const antiHallucinationLevel = meta["anti-hallucination-level"] as
    | string
    | undefined;

  const triggers =
    typeof meta.triggers === "string"
      ? (meta.triggers as string)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : Array.isArray(meta.triggers)
        ? (meta.triggers as string[])
        : undefined;

  const tags =
    typeof meta.tags === "string"
      ? (meta.tags as string)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : Array.isArray(meta.tags)
        ? (meta.tags as string[])
        : undefined;

  return {
    name,
    description,
    tools,
    modelRole,
    systemPrompt: body,
    antiHallucinationLevel,
    whenToUse,
    triggers,
    tags,
    homepage: meta.homepage as string | undefined,
    version: meta.version as string | undefined,
    author: meta.author as string | undefined,
    emoji: meta.emoji as string | undefined,
  };
}

function deriveSkillName(fileName: string): string {
  return fileName
    .replace(/\.md$/i, "")
    .replace(/SKILL$/i, "")
    .replace(/\/$/, "");
}

function mapCCModel(model: unknown): string | undefined {
  if (!model || typeof model !== "string") return undefined;
  const m = model.toLowerCase().trim();
  if (!m || m === "inherit" || m === "default") return "main";
  return "main";
}

function parseToolsValue(
  raw: unknown,
  meta: Record<string, unknown>,
): string[] {
  const value = raw ?? meta["allowed-tools"];
  if (!value) return ["*"];
  if (Array.isArray(value)) return value as string[];
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || trimmed === "*") return ["*"];
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      return trimmed
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (trimmed.includes(" ") && !trimmed.includes(",")) {
      return trimmed.split(/\s+/).filter(Boolean);
    }
    return trimmed.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return ["*"];
}

function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const lines = yaml.split("\n");
  let pos = 0;

  const getIndent = (lineIdx: number): number => lines[lineIdx]!.search(/\S/);

  const stripQuotes = (s: string): string => {
    if (
      ((s.startsWith('"') && s.endsWith('"')) ||
        (s.startsWith("'") && s.endsWith("'"))) &&
      s.length >= 2
    ) {
      return s.slice(1, -1);
    }
    return s;
  };

  const parseInlineArray = (value: string): string[] =>
    value
      .slice(1, -1)
      .split(",")
      .map((s) => stripQuotes(s.trim()))
      .filter(Boolean);

  const parseValue = (raw: string): unknown => {
    const v = raw.trim();
    if (v.startsWith("[") && v.endsWith("]")) return parseInlineArray(v);
    return stripQuotes(v);
  };

  const parseObject = (minIndent: number): Record<string, unknown> => {
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
      if (trimmed.startsWith("- ")) break;
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
        const childIndent = peekNextIndent();
        if (childIndent < 0 || childIndent <= indent) {
          obj[key] = null;
        } else {
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
  };

  const parseArray = (itemIndent: number): unknown[] => {
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
      arr.push(stripQuotes(itemText));
    }
    return arr;
  };

  const peekNextIndent = (): number => {
    for (let i = pos; i < lines.length; i++) {
      const t = lines[i]!.trim();
      if (t && !t.startsWith("#")) return getIndent(i);
    }
    return -1;
  };

  return parseObject(0);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pickString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function pickStringArray(v: unknown): string[] | undefined {
  if (Array.isArray(v)) {
    const arr = v
      .filter((x): x is string => typeof x === "string")
      .map((s) => s.trim())
      .filter(Boolean);
    return arr.length ? arr : undefined;
  }
  if (typeof v === "string") {
    const arr = v.split(",").map((s) => s.trim()).filter(Boolean);
    return arr.length ? arr : undefined;
  }
  return undefined;
}

/** Generate a URL-safe slug from a skill name (mirrors marketplace.ts). */
export function skillNameToSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-|-$/g, "");
}
