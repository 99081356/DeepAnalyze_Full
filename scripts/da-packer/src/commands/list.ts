// =============================================================================
// src/commands/list.ts
// =============================================================================
// List previously built bundles in a directory. Sorted by mtime (newest first).
// =============================================================================

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { formatBytes } from "../lib/install-script-gen.js";

export async function listCommand(opts: any): Promise<void> {
  const dir = opts.dir;
  if (!dir || !existsSync(dir)) {
    console.log(`No bundles directory: ${dir || "(undefined)"}`);
    return;
  }

  const files = readdirSync(dir)
    .filter(f => f.endsWith(".tar.gz"))
    .map(f => {
      const path = join(dir, f);
      const stat = statSync(path);
      return { name: f, size: stat.size, mtime: stat.mtime };
    })
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  if (files.length === 0) {
    console.log(`No bundles found in ${dir}.`);
    return;
  }

  console.log(`Bundles in ${dir}:\n`);
  for (const f of files) {
    const sidecar = existsSync(join(dir, `${f.name}.sha256`)) ? " ✓" : "";
    console.log(`  ${f.name}  ${formatBytes(f.size).padStart(12)}  ${f.mtime.toISOString()}${sidecar}`);
  }
  console.log("");
  console.log("  (✓ = sidecar .sha256 present, run `da-packer verify <bundle>` to check integrity)");
}
