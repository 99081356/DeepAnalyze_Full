/**
 * Hono type augmentation for worker authentication context.
 */

import "hono";

declare module "hono" {
  interface ContextVariableMap {
    workerId: string;
  }
}
