// =============================================================================
// src/setup/emergency-reset.ts
// =============================================================================
// Emergency recovery: when Hub is unreachable and admins need access.
// Validates recovery.key (proving filesystem access), then creates a
// temporary 24h emergency-admin account in local auth mode.
//
// Usage: bun run src/setup/emergency-reset.ts
//   or:  da-admin (if installed via npm install -g)
// =============================================================================

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../services/auth/local-idp.js";
import { getRepos } from "../store/repos/index.js";

export async function emergencyReset(): Promise<void> {
  console.log("=== DeepAnalyze Emergency Reset ===");

  // Step 1: validate recovery.key exists (proves filesystem access to the server)
  const recoveryKeyPath = process.env.DA_RECOVERY_KEY || resolve(process.cwd(), "data/auth/recovery.key");
  if (!existsSync(recoveryKeyPath)) {
    console.error(`Recovery key not found: ${recoveryKeyPath}`);
    console.error("This command must be run on the DA server itself.");
    process.exit(1);
  }

  // Step 2: temporarily switch to local mode for this session
  process.env.DA_AUTH_MODE = "local";

  // Step 3: create emergency-admin account (24h expiry)
  const tempPassword = randomBytes(8).toString("hex");
  const username = "emergency-admin";
  const hash = await hashPassword(tempPassword);

  const repo = (await getRepos()).settings;
  await repo.set("auth", JSON.stringify({
    mode: "local",
    username,
    passwordHash: hash,
    expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    emergency: true,
  }));

  // Step 4: output credentials
  console.log("\n========================================");
  console.log("Emergency admin credentials (24h):");
  console.log(`  Username: ${username}`);
  console.log(`  Password: ${tempPassword}`);
  console.log("========================================\n");
  console.log("Once Hub is restored, switch back:");
  console.log("  1. Set DA_AUTH_MODE=hub");
  console.log("  2. Restart DA");
}

// Entry point when run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  emergencyReset().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
