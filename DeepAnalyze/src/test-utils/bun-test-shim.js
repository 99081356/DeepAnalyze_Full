// bun:test shim — redirects to vitest for Node.js test execution
export { describe, test, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from "vitest";
