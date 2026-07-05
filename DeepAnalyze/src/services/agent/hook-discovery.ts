// =============================================================================
// DeepAnalyze - Hook Discovery & Loading
// =============================================================================
// Discovers and loads hooks from the filesystem:
//   1. Workspace hooks: <dataDir>/hooks/ — user-created hooks
//   2. Plugin hooks: <dataDir>/plugins/<name>/hooks/ — plugin-provided hooks
//   3. Managed hooks: <dataDir>/managed-hooks/ — admin-installed hooks
//
// Each hook is a directory containing:
//   - HOOK.md: frontmatter metadata + documentation
//   - handler.js or handler.ts: the hook handler module
//
// Override precedence (higher wins):
//   bundled (10) < plugin (20) < managed (30) < workspace (40)
//
// Reference: OpenClaw src/hooks/workspace.ts, src/hooks/loader.ts

import { join, resolve, dirname } from "node:path";
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import type { HookType } from "./hook-types.js";
import { HookManager, type HookDefinition } from "./hooks.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HookSource = "bundled" | "plugin" | "managed" | "workspace";

export interface HookFrontmatter {
  /** Hook name/identifier */
  name: string;
  /** Description */
  description?: string;
  /** Events this hook listens to */
  events: HookType[];
  /** Handler file path relative to hook directory */
  handler?: string;
  /** Export name if handler has multiple exports */
  export?: string;
  /** Whether this hook is enabled (default: true for bundled/plugin, false for workspace) */
  enabled?: boolean;
  /** OS constraints (e.g., ["linux", "darwin"]) */
  os?: string[];
  /** Required CLI binaries */
  requiresBins?: string[];
  /** Required environment variables */
  requiresEnv?: string[];
  /** Tool name matcher for tool-related hooks */
  matcher?: string;
}

interface DiscoveredHook {
  key: string;
  dirPath: string;
  frontmatter: HookFrontmatter;
  source: HookSource;
  precedence: number;
}

// ---------------------------------------------------------------------------
// Precedence levels
// ---------------------------------------------------------------------------

const PRECEDENCE: Record<HookSource, number> = {
  bundled: 10,
  plugin: 20,
  managed: 30,
  workspace: 40,
};

// ---------------------------------------------------------------------------
// HOOK.md frontmatter parser (simple YAML)
// ---------------------------------------------------------------------------

function parseHookFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return {};

  const yaml = match[1]!;
  const result: Record<string, unknown> = {};

  for (const line of yaml.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) continue;

    const key = line.slice(0, colonIdx).trim();
    let value: unknown = line.slice(colonIdx + 1).trim();

    // Parse arrays: [item1, item2]
    if (typeof value === "string" && value.startsWith("[") && value.endsWith("]")) {
      value = value.slice(1, -1).split(",").map(s => s.trim()).filter(Boolean);
    }

    // Parse booleans
    if (value === "true") value = true;
    if (value === "false") value = false;

    result[key] = value;
  }

  return result;
}

/**
 * Validate and normalize hook frontmatter.
 */
function normalizeFrontmatter(
  raw: Record<string, unknown>,
  hookKey: string,
): HookFrontmatter {
  const events = (raw.events ?? raw.event ?? []) as string[];
  const eventsArray = Array.isArray(events) ? events : [events];

  return {
    name: (raw.name as string) ?? hookKey,
    description: raw.description as string | undefined,
    events: eventsArray as HookType[],
    handler: raw.handler as string | undefined,
    export: raw.export as string | undefined,
    enabled: raw.enabled as boolean | undefined,
    os: (raw.os as string[] | undefined),
    requiresBins: (raw.requiresBins ?? raw["requires-bins"]) as string[] | undefined,
    requiresEnv: (raw.requiresEnv ?? raw["requires-env"]) as string[] | undefined,
    matcher: (raw.matcher as string | undefined) ?? "*",
  };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

const HANDLER_FILES = ["handler.js", "handler.ts", "index.js", "index.ts"];

/**
 * Scan a directory for hook directories containing HOOK.md.
 */
function scanHookDir(
  baseDir: string,
  source: HookSource,
): DiscoveredHook[] {
  if (!existsSync(baseDir)) return [];

  const hooks: DiscoveredHook[] = [];

  try {
    const entries = readdirSync(baseDir);
    for (const entry of entries) {
      const full = join(baseDir, entry);
      if (!statSync(full).isDirectory()) continue;

      const hookMd = join(full, "HOOK.md");
      if (!existsSync(hookMd)) continue;

      try {
        const content = readFileSync(hookMd, "utf-8");
        const raw = parseHookFrontmatter(content);
        const frontmatter = normalizeFrontmatter(raw, entry);

        // Check handler file exists
        const handlerFile = HANDLER_FILES.find(f => existsSync(join(full, f)));
        if (!handlerFile) {
          console.warn(`[HookDiscovery] No handler file found in ${full}`);
          continue;
        }

        if (!frontmatter.handler) {
          frontmatter.handler = handlerFile;
        }

        hooks.push({
          key: entry,
          dirPath: full,
          frontmatter,
          source,
          precedence: PRECEDENCE[source],
        });
      } catch (err) {
        console.warn(`[HookDiscovery] Failed to parse ${hookMd}:`, err instanceof Error ? err.message : String(err));
      }
    }
  } catch {
    // Directory not readable
  }

  return hooks;
}

/**
 * Check if a hook is eligible for the current environment.
 */
function isEligible(hook: DiscoveredHook): boolean {
  const fm = hook.frontmatter;

  // OS check
  if (fm.os && fm.os.length > 0) {
    const platform = process.platform;
    if (!fm.os.includes(platform) && !(fm.os.includes("linux") && platform === "linux")) {
      return false;
    }
  }

  // Required bins check
  if (fm.requiresBins && fm.requiresBins.length > 0) {
    for (const bin of fm.requiresBins) {
      try {
        const { execSync } = require("node:child_process");
        execSync(`which ${bin}`, { stdio: "pipe" });
      } catch {
        return false;
      }
    }
  }

  // Required env vars check
  if (fm.requiresEnv && fm.requiresEnv.length > 0) {
    for (const envVar of fm.requiresEnv) {
      if (!process.env[envVar]) return false;
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Resolve override conflicts: when two hooks have the same name,
 * the higher-precedence source wins.
 */
function resolveOverrides(hooks: DiscoveredHook[]): DiscoveredHook[] {
  const byKey = new Map<string, DiscoveredHook>();

  // Sort by precedence ascending so higher precedence overwrites
  const sorted = [...hooks].sort((a, b) => a.precedence - b.precedence);
  for (const hook of sorted) {
    byKey.set(hook.key, hook);
  }

  return [...byKey.values()];
}

/**
 * Dynamically load a hook handler module and register it with the HookManager.
 */
async function loadAndRegister(
  hook: DiscoveredHook,
  manager: HookManager,
): Promise<boolean> {
  const fm = hook.frontmatter;

  // Default enabled state based on source
  const enabled = fm.enabled ?? (hook.source !== "workspace");

  if (!enabled) {
    console.log(`[HookDiscovery] Skipping disabled hook "${fm.name}" (${hook.source})`);
    return false;
  }

  const handlerPath = resolve(hook.dirPath, fm.handler ?? "handler.js");

  // Validate handler path stays within hook directory (security boundary)
  const resolvedHandler = resolve(handlerPath);
  const hookDir = resolve(hook.dirPath);
  if (!resolvedHandler.startsWith(hookDir + "/") && resolvedHandler !== hookDir) {
    console.warn(`[HookDiscovery] Handler path escapes hook directory: ${handlerPath}`);
    return false;
  }

  try {
    // Dynamic import with cache-busting for mutable sources
    const cacheBust = hook.source === "workspace" || hook.source === "managed"
      ? `?t=${Date.now()}`
      : "";
    const module = await import(`file://${resolvedHandler}${cacheBust}`);

    // Resolve export
    const handlerFn = module[fm.export ?? "default"] ?? module.default ?? module.handle;
    if (typeof handlerFn !== "function") {
      console.warn(`[HookDiscovery] No handler function found in ${handlerPath}`);
      return false;
    }

    // Register for each event
    for (const event of fm.events) {
      manager.registerCallbackHook(
        event,
        `discovered:${hook.source}:${fm.name}`,
        async (ctx) => {
          try {
            const result = await handlerFn(ctx);
            return result ?? { allowed: true };
          } catch (err) {
            console.warn(`[HookDiscovery] Handler "${fm.name}" threw:`, err instanceof Error ? err.message : String(err));
            return { allowed: false, error: err instanceof Error ? err.message : String(err) };
          }
        },
        fm.matcher,
      );
    }

    console.log(`[HookDiscovery] Registered hook "${fm.name}" (${hook.source}) for events: ${fm.events.join(", ")}`);
    return true;
  } catch (err) {
    console.warn(`[HookDiscovery] Failed to load hook "${fm.name}":`, err instanceof Error ? err.message : String(err));
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Discover and load all hooks from the filesystem.
 * Registers discovered hooks with the provided HookManager.
 *
 * @param dataDir - The data directory containing hooks
 * @param manager - The HookManager to register hooks with
 * @returns Summary of discovered hooks
 */
export async function discoverAndLoadHooks(
  dataDir: string,
  manager: HookManager,
): Promise<{
  total: number;
  loaded: number;
  skipped: number;
  sources: Record<string, number>;
}> {
  const allHooks: DiscoveredHook[] = [];

  // Scan workspace hooks
  const workspaceDir = join(dataDir, "hooks");
  allHooks.push(...scanHookDir(workspaceDir, "workspace"));

  // Scan plugin hooks
  const pluginsDir = join(dataDir, "plugins");
  if (existsSync(pluginsDir)) {
    try {
      const pluginEntries = readdirSync(pluginsDir);
      for (const entry of pluginEntries) {
        const pluginHooksDir = join(pluginsDir, entry, "hooks");
        allHooks.push(...scanHookDir(pluginHooksDir, "plugin"));
      }
    } catch {
      // Not readable
    }
  }

  // Scan managed hooks
  const managedDir = join(dataDir, "managed-hooks");
  allHooks.push(...scanHookDir(managedDir, "managed"));

  // Resolve overrides and filter eligible
  const resolved = resolveOverrides(allHooks);
  const eligible = resolved.filter(isEligible);

  // Load and register
  let loaded = 0;
  let skipped = 0;
  const sources: Record<string, number> = {};

  for (const hook of eligible) {
    const success = await loadAndRegister(hook, manager);
    if (success) {
      loaded++;
      sources[hook.source] = (sources[hook.source] ?? 0) + 1;
    } else {
      skipped++;
    }
  }

  return {
    total: allHooks.length,
    loaded,
    skipped,
    sources,
  };
}
