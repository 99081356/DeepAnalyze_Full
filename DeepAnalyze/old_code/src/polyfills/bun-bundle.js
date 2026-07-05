/**
 * Minimal ESM polyfill for CC's `bun:bundle` feature flags.
 * CC uses Bun's build-time `feature()` to toggle behavior at compile time.
 * DA runs on Node.js where bun:bundle doesn't exist. All features default to false.
 */
export function feature(name) {
  return false;
}

export default { feature };
