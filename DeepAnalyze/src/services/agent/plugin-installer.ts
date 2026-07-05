// =============================================================================
// DeepAnalyze - Plugin Installer
// =============================================================================
// Git-based plugin installation, validation, and version checking.
// Uses git CLI via child_process for remote operations.
// =============================================================================

import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { PluginManifest } from "./plugin-manager.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// PluginInstaller
// ---------------------------------------------------------------------------

export class PluginInstaller {
  /**
   * Clone a git repo to targetDir and validate it contains a plugin manifest.
   * Returns success/failure with optional error message.
   */
  async installFromGit(
    repoUrl: string,
    targetDir: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // Clone the repository
      await execFileAsync("git", ["clone", "--depth", "1", repoUrl, targetDir], {
        timeout: 60_000,
      });

      // Validate the cloned plugin
      const validation = await this.validatePlugin(targetDir);
      if (!validation.valid) {
        return {
          success: false,
          error: `Plugin validation failed: ${validation.errors.join("; ")}`,
        };
      }

      return { success: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Git clone failed: ${message}` };
    }
  }

  /**
   * Validate a plugin directory:
   * - plugin.json exists and is valid JSON
   * - Has name, version, and description fields
   * - Has at least one capability
   * - All referenced skill/agent files exist on disk
   */
  async validatePlugin(dirPath: string): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];

    // 1. plugin.json must exist and be parseable
    let manifest: PluginManifest;
    try {
      const raw = await readFile(join(dirPath, "plugin.json"), "utf-8");
      manifest = JSON.parse(raw);
    } catch {
      return { valid: false, errors: ["plugin.json not found or invalid JSON"] };
    }

    // 2. Required fields
    if (!manifest.name) errors.push("Missing required field: name");
    if (!manifest.version) errors.push("Missing required field: version");
    if (!manifest.description) errors.push("Missing required field: description");

    // 3. At least one capability
    if (!manifest.capabilities || manifest.capabilities.length === 0) {
      errors.push("Plugin must declare at least one capability");
    }

    // 4. Verify referenced skill files exist
    if (manifest.skills) {
      for (const skillRef of manifest.skills) {
        const dir = typeof skillRef === "string" ? skillRef : skillRef.dir;
        const skillDir = join(dirPath, dir);
        try {
          const entries = await readdir(skillDir);
          if (entries.length === 0) {
            errors.push(`Skill directory "${dir}" is empty`);
          }
        } catch {
          errors.push(`Skill directory "${dir}" not found`);
        }
      }
    }

    // 5. Verify referenced agent files exist
    if (manifest.agents) {
      for (const agentRef of manifest.agents) {
        const file = typeof agentRef === "string" ? agentRef : agentRef.file;
        try {
          await readFile(join(dirPath, file), "utf-8");
        } catch {
          errors.push(`Agent file "${file}" not found`);
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Read the version from a plugin's manifest. Returns null if not found.
   */
  async getInstalledVersion(
    pluginName: string,
    pluginDir: string,
  ): Promise<string | null> {
    try {
      const raw = await readFile(join(pluginDir, "plugin.json"), "utf-8");
      const manifest: PluginManifest = JSON.parse(raw);
      if (manifest.name === pluginName) {
        return manifest.version ?? null;
      }
      // Plugin name mismatch — not the plugin we're looking for
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Check whether a remote git repo has a newer version than the currently
   * installed one. Uses `git ls-remote --tags` to discover version tags
   * and performs semver-style comparison.
   */
  async checkForUpdate(
    repoUrl: string,
    currentVersion: string,
  ): Promise<{ hasUpdate: boolean; latestVersion?: string }> {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["ls-remote", "--tags", repoUrl],
        { timeout: 30_000 },
      );

      // Parse tags from ls-remote output (format: <sha>\trefs/tags/<tag>)
      const tags: string[] = [];
      for (const line of stdout.trim().split("\n")) {
        const match = line.match(/refs\/tags\/(.+)$/);
        if (match) {
          const tag = match[1]!;
          // Skip ^{} dereferenced tags
          if (!tag.endsWith("^{}")) {
            tags.push(tag);
          }
        }
      }

      if (tags.length === 0) {
        return { hasUpdate: false };
      }

      // Find the latest version by semver comparison
      const latestTag = findLatestTag(tags);
      if (!latestTag) {
        return { hasUpdate: false };
      }

      const latestVersion = stripVPrefix(latestTag);
      const current = parseSemver(currentVersion);
      const latest = parseSemver(latestVersion);

      if (!current || !latest) {
        // Fall back to string comparison
        return { hasUpdate: latestVersion !== currentVersion, latestVersion };
      }

      const hasUpdate = compareSemver(latest, current) > 0;
      return { hasUpdate, latestVersion: hasUpdate ? latestVersion : undefined };
    } catch {
      return { hasUpdate: false };
    }
  }
}

// ---------------------------------------------------------------------------
// Semver helpers
// ---------------------------------------------------------------------------

interface SemverParts {
  major: number;
  minor: number;
  patch: number;
}

function parseSemver(version: string): SemverParts | null {
  const cleaned = stripVPrefix(version);
  const match = cleaned.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: parseInt(match[1]!, 10),
    minor: parseInt(match[2]!, 10),
    patch: parseInt(match[3]!, 10),
  };
}

function compareSemver(a: SemverParts, b: SemverParts): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function stripVPrefix(tag: string): string {
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

function findLatestTag(tags: string[]): string | null {
  let best: string | null = null;
  let bestParsed: SemverParts | null = null;

  for (const tag of tags) {
    const parsed = parseSemver(tag);
    if (!parsed) continue;
    if (!bestParsed || compareSemver(parsed, bestParsed) > 0) {
      best = tag;
      bestParsed = parsed;
    }
  }

  return best;
}
