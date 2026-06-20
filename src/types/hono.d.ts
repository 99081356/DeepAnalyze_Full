/**
 * Hono type augmentation for authentication context.
 */

import "hono";
import type { SecurityMatch } from "../domain/security-gateway.js";

declare module "hono" {
  interface ContextVariableMap {
    workerId: string;
    userId: string;
    username: string;
    userPermissions: string[];
    userOrgId: string | null;
    isSuperAdmin: boolean;
    // Phase 4: Security Gateway context
    securityInputMatches: SecurityMatch[];
    securityInputAction: string;
    securitySanitizedBody: string;
    // Phase 4: MFA pending secret (between setup and verify)
    pendingMfaSecret: string;
  }
}
