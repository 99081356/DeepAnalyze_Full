/**
 * Node.js ESM loader hook that resolves `bun:*` imports.
 * CC code imports from `bun:bundle`, `bun:test`, etc.
 * This loader redirects them to local polyfill modules.
 */
import { pathToFileURL } from 'node:url';
import { resolve as pathResolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUN_POLYFILL = pathToFileURL(pathResolve(__dirname, 'src/polyfills/bun-bundle.mjs')).href;

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('bun:') || specifier === 'bun') {
    return { url: BUN_POLYFILL, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
