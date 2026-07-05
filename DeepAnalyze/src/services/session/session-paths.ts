/**
 * Session path utilities — centralized path computation for session-scoped storage.
 * All paths use dataDir (from DEEPANALYZE_CONFIG) instead of process.cwd() + "data".
 */
import path from "path";
import { existsSync, readdirSync } from "fs";
import { resolve } from "path";

/** Get session root directory: {dataDir}/sessions/{sessionId}/ */
export function getSessionDir(dataDir: string, sessionId: string): string {
  return path.join(dataDir, "sessions", sessionId);
}

/** Get session output directory: {dataDir}/sessions/{sessionId}/output/ */
export function getSessionOutputDir(dataDir: string, sessionId: string): string {
  return path.join(getSessionDir(dataDir, sessionId), "output");
}

/** Get session subagents directory: {dataDir}/sessions/{sessionId}/subagents/ */
export function getSessionSubagentsDir(dataDir: string, sessionId: string): string {
  return path.join(getSessionDir(dataDir, sessionId), "subagents");
}

/** Get session workflows directory: {dataDir}/sessions/{sessionId}/workflows/ */
export function getSessionWorkflowsDir(dataDir: string, sessionId: string): string {
  return path.join(getSessionDir(dataDir, sessionId), "workflows");
}

/** Get session generated directory: {dataDir}/sessions/{sessionId}/generated/ */
export function getSessionGeneratedDir(dataDir: string, sessionId: string): string {
  return path.join(getSessionDir(dataDir, sessionId), "generated");
}

/** Get session tool-results directory: {dataDir}/sessions/{sessionId}/tool-results/ */
export function getSessionToolResultsDir(dataDir: string, sessionId: string): string {
  return path.join(getSessionDir(dataDir, sessionId), "tool-results");
}

/** Get transcript file path: {dataDir}/sessions/{sessionId}/transcripts/{taskId}.jsonl */
export function getTranscriptPath(dataDir: string, sessionId: string, taskId: string): string {
  return path.join(getSessionDir(dataDir, sessionId), "transcripts", `${taskId}.jsonl`);
}

/** Get session media directory: {dataDir}/sessions/{sessionId}/media/ */
export function getSessionMediaDir(dataDir: string, sessionId: string): string {
  return path.join(getSessionDir(dataDir, sessionId), "media");
}

/** Get session media item directory: {dataDir}/sessions/{sessionId}/media/{mediaId}/ */
export function getSessionMediaItemDir(dataDir: string, sessionId: string, mediaId: string): string {
  return path.join(getSessionMediaDir(dataDir, sessionId), mediaId);
}

/** Check if a normalized path targets shared data (wiki/, original/) that should not go to session output. */
export function isSharedDataPath(normalizedPath: string): boolean {
  return normalizedPath.startsWith("wiki/") || normalizedPath.startsWith("wiki\\") ||
         normalizedPath.startsWith("original/") || normalizedPath.startsWith("original\\");
}

/**
 * Generate a prefixed filename for session-scoped files.
 * Format: {role}_{timestamp}_{originalName}
 * - role: "main" (主Agent), "sub" (子Agent), "wf-{agentId}" (工作流Agent)
 */
export function makeAgentFilename(role: string, originalName: string): string {
  // Preserve Unicode (CJK, accented Latin, etc.) for readability.
  // Only strip path separators and filesystem-unsafe characters.
  const safe = originalName
    .replace(/[/\\]/g, "_")                     // Flatten path separators
    .replace(/[:*?"<>|\x00-\x1f\x7f]/g, "_");   // Remove Windows-unsafe and control chars
  return `${role}_${Date.now()}_${safe}`;
}

/**
 * Try to resolve a file path in the session output directory.
 * Used by push_content and read_file when the direct path doesn't exist —
 * typically because write_file remapped the original filename with makeAgentFilename.
 *
 * Resolution strategy:
 * 1. Exact match in output dir
 * 2. Fuzzy match: file whose suffix contains the requested name (handles prefixed names)
 * 3. Fallback: search workflow subdirectories (sub-agent outputs stored under
 *    sessions/{sid}/workflows/{wfId}/ with prefixed filenames like wf-{agentId}_{ts}_{name})
 *
 * Returns the resolved absolute path, or the original `directPath` if no match found.
 */
export function resolveSessionOutputPath(
  normalizedPath: string,
  dataDir: string,
  sessionId: string,
): string {
  // Local helper: try exact + fuzzy match within a single flat directory.
  const tryMatchInDir = (dir: string): string | null => {
    if (!existsSync(dir)) return null;
    const directMatch = resolve(dir, normalizedPath);
    if (existsSync(directMatch)) return directMatch;
    const baseName = normalizedPath.replace(/^\/+/, "");
    const flatBaseName = baseName.replace(/[/\\]/g, "_");
    try {
      const files = readdirSync(dir);
      const match = files.find(f => {
        if (f.endsWith(baseName)) return true;
        if (flatBaseName !== baseName && f.endsWith(flatBaseName)) return true;
        const baseNoExt = baseName.replace(/\.[^.]+$/, "");
        const flatNoExt = flatBaseName.replace(/\.[^.]+$/, "");
        return f.includes(baseNoExt) || (flatNoExt !== baseNoExt && f.includes(flatNoExt));
      });
      if (match) return resolve(dir, match);
    } catch { /* dir read failed */ }
    return null;
  };

  // 1+2. Try session output dir (main agent outputs)
  const outputDir = getSessionOutputDir(dataDir, sessionId);
  const outputMatch = tryMatchInDir(outputDir);
  if (outputMatch) return outputMatch;

  // 3. Try workflow subdirectories (sub-agent outputs)
  const workflowsDir = getSessionWorkflowsDir(dataDir, sessionId);
  if (existsSync(workflowsDir)) {
    try {
      for (const entry of readdirSync(workflowsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const wfMatch = tryMatchInDir(resolve(workflowsDir, entry.name));
        if (wfMatch) return wfMatch;
      }
    } catch { /* workflows dir read failed */ }
  }

  return resolve(dataDir, normalizedPath);
}
