// =============================================================================
// src/lib/skill-packager.ts
// =============================================================================
// Skill package fetcher. Each skill becomes a subdirectory under the bundle's
// skills/ folder. Local skills are copied recursively; Hub skills are stored
// as their original .zip (deferring extraction to install time on the target
// machine).
// =============================================================================

import {
  existsSync, mkdirSync, readdirSync, writeFileSync, cpSync, statSync,
} from "node:fs";
import { join } from "node:path";
import type { PackagedSkill } from "../types.js";

// Re-export so existing imports from this module keep working
export type { PackagedSkill };

export interface SkillToPackage {
  name: string;
  version?: string;
  source: "hub" | "local";
  localPath?: string;  // source=local 时
}

export interface PackageSkillsOptions {
  skills: SkillToPackage[];
  outputDir: string;
  hubUrl?: string;
  skipSkills?: boolean;
}

export async function packageSkills(opts: PackageSkillsOptions): Promise<{
  skills: PackagedSkill[];
}> {
  const skillsDir = join(opts.outputDir, "skills");
  mkdirSync(skillsDir, { recursive: true });

  if (opts.skipSkills) return { skills: [] };

  const result: PackagedSkill[] = [];

  for (const skill of opts.skills) {
    const skillDir = join(skillsDir, skill.name);
    mkdirSync(skillDir, { recursive: true });

    if (skill.source === "local" && skill.localPath && existsSync(skill.localPath)) {
      cpSync(skill.localPath, skillDir, { recursive: true });
      result.push({
        name: skill.name,
        version: skill.version || "1.0.0",
        source: "local",
        sizeBytes: computeDirSize(skillDir),
      });
    } else if (skill.source === "hub" && opts.hubUrl) {
      const url = `${opts.hubUrl}/api/v1/marketplace/skills/${skill.name}/download`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!resp.ok) {
        console.warn(`[skill-packager] failed to fetch ${skill.name}: ${resp.status}`);
        continue;
      }
      const buf = Buffer.from(await resp.arrayBuffer());
      // Store the .zip verbatim — install-hub.sh extracts on target machine.
      writeFileSync(join(skillDir, `${skill.name}.zip`), buf);
      result.push({
        name: skill.name,
        version: skill.version || "1.0.0",
        source: "hub",
        sizeBytes: buf.byteLength,
      });
    } else {
      console.warn(`[skill-packager] skipping ${skill.name}: no source`);
    }
  }

  return { skills: result };
}

function computeDirSize(dir: string): number {
  let total = 0;
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else total += statSync(full).size;
    }
  };
  walk(dir);
  return total;
}
