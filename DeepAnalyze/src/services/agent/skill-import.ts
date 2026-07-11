// =============================================================================
// DeepAnalyze - Skill Import Service
// =============================================================================
//
// Parses uploaded skill files (SKILL.md / JSON / ZIP) into NewAgentSkill records.
// Reuses parseSkillMd() from skill-loader.ts (supports DA + Claude Code/OpenClaw
// frontmatter formats). ZIP archives are read in-memory via adm-zip; the bundled
// SKILL.md is parsed and any sibling resource files are written to
// {dataDir}/skills/{name}/ so that <!-- @include --> directives resolve at runtime.
//
// Used by POST /api/agent-skills/import.
// =============================================================================

import { promises as fs } from "node:fs";
import path from "node:path";
import { DEEPANALYZE_CONFIG } from "../../core/config.js";
import { parseSkillMd, type SkillManifest } from "./skill-loader.js";
import type { NewAgentSkill } from "../../store/repos/interfaces.js";

/** A skill parsed from an uploaded file, ready to map into NewAgentSkill. */
export interface ParsedSkill {
  /** Final skill name (may differ from manifest if renamed to avoid conflict). */
  name: string;
  manifest: SkillManifest;
}

/** Normalized conflict payload returned to the caller. */
export interface ConflictExisting {
  id: string;
  name: string;
  description: string;
  prompt: string;
  source: string;
}

// ---------------------------------------------------------------------------
// File-type dispatch
// ---------------------------------------------------------------------------

/**
 * Parse a single uploaded File into one or more ParsedSkill entries.
 *
 * - `.md`  → one skill (the file itself)
 * - `.json`→ one skill (a serialized agent skill object)
 * - `.zip` → one or more skills (one SKILL.md per top-level skill folder;
 *            sibling files are extracted to {dataDir}/skills/{name}/)
 *
 * Any other extension throws synchronously.
 */
export async function parseSkillFile(file: File): Promise<ParsedSkill[]> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".md")) {
    const content = await file.text();
    return [manifestToParsed(parseSkillMd(content, file.name))];
  }
  if (lower.endsWith(".json")) {
    const text = await file.text();
    return [parseJsonSkill(text, file.name)];
  }
  if (lower.endsWith(".zip")) {
    return parseZipSkill(file);
  }
  throw new Error(
    `不支持的文件格式: ${file.name}。仅支持 .md / .json / .zip。`,
  );
}

/**
 * Parse a JSON folder bundle — the client serializes a folder upload into
 * { type: "folder", files: [{path, content}] } to avoid FormData multipart
 * quirks. This reconstructs the in-memory file map and delegates to the same
 * logic as parseSkillFiles.
 */
export async function parseSkillBundle(
  files: Array<{ path: string; content: string }>,
): Promise<ParsedSkill[]> {
  if (files.length === 0) {
    throw new Error("未收到任何文件。");
  }
  console.log(`[bundle] fileCount=${files.length} paths=${JSON.stringify(files.map(f=>f.path).slice(0,5))}`);

  // Build path → content map.
  const fileMap = new Map<string, string>();
  for (const f of files) {
    if (f.path) fileMap.set(f.path, f.content);
  }

  // Find all SKILL.md files (case-insensitive).
  const skillMdPaths = Array.from(fileMap.keys()).filter((p) =>
    /(^|\/)skill\.md$/i.test(p),
  );
  if (skillMdPaths.length === 0) {
    // Log all keys for debugging
    console.log(`[bundle] no SKILL.md found. keys:`, Array.from(fileMap.keys()).slice(0, 10));
    throw new Error("文件夹中未找到 SKILL.md 文件。");
  }

  const parsed: ParsedSkill[] = [];
  for (const skillMdPath of skillMdPaths) {
    const content = fileMap.get(skillMdPath)!;
    const entryDir = posixDirname(skillMdPath);
    const folderName = entryDir ? entryDir.split("/").pop()! : skillMdPath;
    const manifest = parseSkillMd(content, folderName);

    // Extract sibling resource files to disk.
    const destDir = path.join(
      DEEPANALYZE_CONFIG.dataDir,
      "skills",
      sanitizeDir(manifest.name),
    );
    await extractBundleResources(fileMap, entryDir, destDir, skillMdPath);

    parsed.push(manifestToParsed(manifest));
  }
  return parsed;
}

/**
 * Extract sibling files from the bundle map to destDir.
 */
async function extractBundleResources(
  fileMap: Map<string, string>,
  rootDir: string,
  destDir: string,
  skillMdPath: string,
): Promise<void> {
  const rootPrefix = rootDir ? rootDir + "/" : "";
  for (const [relPath, content] of fileMap) {
    if (relPath === skillMdPath) continue;
    if (rootPrefix && !relPath.startsWith(rootPrefix)) continue;
    if (!rootPrefix && relPath.includes("/")) continue;

    const rel = rootPrefix ? relPath.slice(rootPrefix.length) : relPath;
    if (!rel || rel.includes("..")) continue;

    const target = path.join(destDir, rel);
    if (!isWithin(destDir, target)) continue;

    const targetDir = path.dirname(target);
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(target, content, "utf-8");
  }
}

/**
 * Parse a folder upload — multiple File objects with `webkitRelativePath`
 * (e.g. "my-skill/SKILL.md", "my-skill/resources/spec.md").
 *
 * Scans for one or more SKILL.md entries, parses each, and extracts sibling
 * resource files to {dataDir}/skills/{name}/. Supports a folder containing
 * multiple skills (each in its own subdirectory with a SKILL.md).
 */
export async function parseSkillFiles(files: File[]): Promise<ParsedSkill[]> {
  if (files.length === 0) {
    throw new Error("未收到任何文件。");
  }

  // Build a map of relativePath → File. The client sends relative paths via
  // a "paths" JSON field; the route overrides each File's name with the path.
  const fileMap = new Map<string, File>();
  for (const f of files) {
    if (f.name) fileMap.set(f.name, f);
  }

  // Find all SKILL.md files (case-insensitive), anywhere in the tree.
  // Matches both "my-skill/SKILL.md" and bare "SKILL.md".
  const skillMdPaths = Array.from(fileMap.keys()).filter((p) =>
    /(^|\/)skill\.md$/i.test(p),
  );
  if (skillMdPaths.length === 0) {
    throw new Error("文件夹中未找到 SKILL.md 文件。");
  }

  const parsed: ParsedSkill[] = [];
  for (const skillMdPath of skillMdPaths) {
    const file = fileMap.get(skillMdPath)!;
    const content = await file.text();
    // Derive the skill folder name from the SKILL.md's parent directory.
    const entryDir = posixDirname(skillMdPath);
    const folderName = entryDir ? entryDir.split("/").pop()! : file.name;
    const manifest = parseSkillMd(content, folderName);

    // Extract sibling resource files (same directory subtree, excluding
    // the SKILL.md itself) to {dataDir}/skills/{name}/.
    const destDir = path.join(
      DEEPANALYZE_CONFIG.dataDir,
      "skills",
      sanitizeDir(manifest.name),
    );
    await extractFileResources(fileMap, entryDir, destDir, skillMdPath);

    parsed.push(manifestToParsed(manifest));
  }
  return parsed;
}

/**
 * Extract sibling files of a SKILL.md to destDir, preserving relative paths.
 * Path traversal is rejected via isWithin().
 */
async function extractFileResources(
  fileMap: Map<string, File>,
  rootDir: string,
  destDir: string,
  skillMdPath: string,
): Promise<void> {
  const rootPrefix = rootDir ? rootDir + "/" : "";
  for (const [relPath, file] of fileMap) {
    if (relPath === skillMdPath) continue;
    if (rootPrefix && !relPath.startsWith(rootPrefix)) continue;
    if (!rootPrefix && relPath.includes("/")) continue; // top-level only

    const rel = rootPrefix
      ? relPath.slice(rootPrefix.length)
      : relPath;
    if (!rel || rel.includes("..")) continue; // safety

    const target = path.join(destDir, rel);
    if (!isWithin(destDir, target)) continue; // reject traversal

    const targetDir = path.dirname(target);
    await fs.mkdir(targetDir, { recursive: true });
    const buf = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(target, buf);
  }
}

/** POSIX-style dirname (works on relative paths which always use "/"). */
function posixDirname(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx >= 0 ? p.slice(0, idx) : "";
}

// ---------------------------------------------------------------------------
// JSON parsing
// ---------------------------------------------------------------------------

/**
 * Parse a JSON-serialized skill. Accepts either:
 *   - a full AgentSkill/NewAgentSkill object (uses name, description, prompt,
 *     tools, modelRole, triggers, tags, version, author, emoji)
 *   - a SkillManifest object (uses name, description, systemPrompt, tools, ...)
 */
function parseJsonSkill(text: string, fileName: string): ParsedSkill {
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
    throw new Error(
      `JSON 技能缺少必填字段 name/prompt: ${fileName}`,
    );
  }

  const manifest: SkillManifest = {
    name,
    description: pickString(obj.description) ?? "",
    tools: pickStringArray(obj.tools) ?? ["*"],
    modelRole: pickString(obj.modelRole) ?? pickString(obj.model_role) ?? "main",
    systemPrompt: prompt,
    triggers: pickStringArray(obj.triggers),
    tags: pickStringArray(obj.tags),
    version: pickString(obj.version) ?? undefined,
    author: pickString(obj.author) ?? undefined,
    emoji: pickString(obj.emoji) ?? undefined,
    homepage: pickString(obj.homepage) ?? undefined,
    whenToUse: pickString(obj.whenTo_use) ?? pickString(obj.whenToUse) ?? undefined,
    antiHallucinationLevel: pickString(obj.antiHallucinationLevel)
      ?? pickString(obj.anti_hallucination_level) ?? undefined,
  };

  return { name, manifest };
}

// ---------------------------------------------------------------------------
// ZIP parsing
// ---------------------------------------------------------------------------

/**
 * Parse a ZIP archive. Looks for one or more SKILL.md entries (any nesting
 * depth). For each, the SKILL.md body is parsed and any sibling files in the
 * same folder (and nested subfolders) are extracted to {dataDir}/skills/{name}/.
 *
 * Lazily imports adm-zip so the dependency is only required when a ZIP is
 * actually uploaded. If adm-zip is not installed, a clear error is thrown.
 */
async function parseZipSkill(file: File): Promise<ParsedSkill[]> {
  const mod = (await import("adm-zip").catch(() => null)) as
    typeof import("adm-zip") | null;
  if (!mod) {
    throw new Error(
      "ZIP 导入需要 adm-zip 依赖，请先安装：npm i adm-zip（或改用 .md / .json 导入）。",
    );
  }
  // adm-zip is a CommonJS module; under ESM/Bun the namespace object wraps the
  // constructor in `.default`. Fall back to the namespace itself for CJS.
  const AdmZip = (mod as unknown as { default?: typeof import("adm-zip") })
    .default ?? mod;

  const buf = Buffer.from(await file.arrayBuffer());
  const zip = new AdmZip(buf);
  const entries = zip.getEntries();

  // Locate every SKILL.md (case-insensitive) in the archive.
  const skillEntries = entries.filter((e) =>
    /(^|\/)skill\.md$/i.test(e.entryName) && !e.isDirectory,
  );
  if (skillEntries.length === 0) {
    throw new Error("ZIP 包内未找到 SKILL.md 文件。");
  }

  const parsed: ParsedSkill[] = [];
  for (const entry of skillEntries) {
    const entryDir = path.posix.dirname(entry.entryName);
    const content = entry.getData().toString("utf-8");
    // Derive the skill folder name from the SKILL.md's parent directory.
    const folderName = path.posix.basename(entryDir) || "skill";
    const manifest = parseSkillMd(content, folderName);

    // Extract sibling resource files (everything in the same folder tree,
    // excluding the SKILL.md itself) to {dataDir}/skills/{name}/.
    const destDir = path.join(
      DEEPANALYZE_CONFIG.dataDir,
      "skills",
      sanitizeDir(manifest.name),
    );
    await extractSkillResources(zip, entryDir, destDir, entry.entryName);

    parsed.push(manifestToParsed(manifest));
  }
  return parsed;
}

/**
 * Extract every file under `rootDir` (the SKILL.md's folder) into `destDir`,
 * preserving relative paths. The SKILL.md itself is skipped (its content is
 * already stored in the DB). Path traversal outside destDir is rejected.
 */
async function extractSkillResources(
  zip: import("adm-zip").default,
  rootDir: string,
  destDir: string,
  skillEntryName: string,
): Promise<void> {
  const rootPrefix = rootDir === "." ? "" : rootDir + "/";
  const entries = zip.getEntries();

  for (const e of entries) {
    if (e.isDirectory) continue;
    if (e.entryName === skillEntryName) continue;
    if (rootPrefix && !e.entryName.startsWith(rootPrefix)) continue;
    if (!rootPrefix && e.entryName.includes("/")) continue; // top-level only

    const rel = rootPrefix ? e.entryName.slice(rootPrefix.length) : e.entryName;
    if (!rel || rel.includes("..")) continue; // safety

    const target = path.join(destDir, rel);
    const targetDir = path.dirname(target);
    if (!isWithin(destDir, target)) continue; // reject traversal

    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(target, e.getData());
  }
}

// ---------------------------------------------------------------------------
// Manifest → NewAgentSkill mapping
// ---------------------------------------------------------------------------

/** Map a SkillManifest into a NewAgentSkill with sensible import defaults. */
export function manifestToNewAgentSkill(
  manifest: SkillManifest,
  overrides: Partial<NewAgentSkill> = {},
): NewAgentSkill {
  return {
    name: manifest.name,
    description: manifest.description,
    prompt: manifest.systemPrompt,
    tools: manifest.tools,
    modelRole: manifest.modelRole ?? "main",
    source: "manual",
    antiHallucinationLevel: manifest.antiHallucinationLevel,
    triggers: manifest.triggers,
    tags: manifest.tags,
    homepage: manifest.homepage ?? null,
    version: manifest.version ?? null,
    author: manifest.author ?? null,
    emoji: manifest.emoji ?? null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function manifestToParsed(manifest: SkillManifest): ParsedSkill {
  return { name: manifest.name, manifest };
}

function pickString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function pickStringArray(v: unknown): string[] | undefined {
  if (Array.isArray(v)) {
    const arr = v.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean);
    return arr.length ? arr : undefined;
  }
  if (typeof v === "string") {
    const arr = v.split(",").map((s) => s.trim()).filter(Boolean);
    return arr.length ? arr : undefined;
  }
  return undefined;
}

/** Strip characters unsafe for a filesystem directory name. */
function sanitizeDir(name: string): string {
  return name.replace(/[^a-zA-Z0-9\u4e00-\u9fff._-]+/g, "_").replace(/^\.+/, "") || "skill";
}

/** True iff `child` resolves inside `parent` (no path traversal escape). */
function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
