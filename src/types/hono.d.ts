/**
 * Hono type augmentation for authentication context.
 */

import "hono";

declare module "hono" {
  interface ContextVariableMap {
    workerId: string;
    userId: string;
    userPermissions: string[];
    userOrgId: string | null;
    isSuperAdmin: boolean;
  }
}
