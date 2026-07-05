// ---------------------------------------------------------------------------
// JSON-safe truncation: cut a JSON string at maxLen while keeping it valid
// ---------------------------------------------------------------------------

/**
 * Safely truncate a JSON string so that the result is still valid JSON.
 *
 * The approach:
 * 1. Walk the JSON character-by-character tracking depth and string state.
 * 2. Stop at or before `maxLen`, at a position that leaves the JSON structurally
 *    intact (not inside a string literal, not mid-escape).
 * 3. Close any open containers (arrays/objects) so the result parses cleanly.
 */
export function safeTruncateJSON(json: string, maxLen: number): string {
  if (json.length <= maxLen) return json;

  // We need room for closing brackets/braces (worst case: deeply nested).
  // Reserve a reasonable budget and truncate the content portion accordingly.
  const reserveForSuffix = 32; // enough for closing chars + margin
  const effectiveMax = Math.max(maxLen - reserveForSuffix, Math.floor(maxLen * 0.9));

  let inString = false;
  let escape = false;
  const depthStack: ("{" | "[")[] = [];
  let lastSafeEnd = 0;

  for (let i = 0; i < json.length && i <= effectiveMax; i++) {
    const ch = json[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === "{" || ch === "[") {
      depthStack.push(ch);
    } else if (ch === "}" || ch === "]") {
      depthStack.pop();
    }

    // Outside a string, after a complete token boundary
    if (!inString) {
      lastSafeEnd = i + 1;
    }
  }

  // If we never found a safe point (entire content is one giant string), just cut at effectiveMax
  // and close the string + containers
  let cutPoint = lastSafeEnd > 0 ? lastSafeEnd : effectiveMax;

  // If we're stuck inside a string, close it
  let suffix = "";
  if (inString) {
    suffix += '"';
  }

  // Close all open containers in reverse order
  for (let i = depthStack.length - 1; i >= 0; i--) {
    suffix += depthStack[i] === "{" ? "}" : "]";
  }

  // Ensure the result is valid JSON by attempting parse; if it fails, use a simple fallback
  const candidate = json.substring(0, cutPoint) + suffix;
  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    // Fallback: find the outermost closing bracket position within maxLen
    const outerClose = json.lastIndexOf("}", maxLen);
    const outerBracket = json.lastIndexOf("]", maxLen);
    const fallbackCut = Math.max(outerClose, outerBracket);
    if (fallbackCut > 0) {
      const fallbackStr = json.substring(0, fallbackCut + 1);
      try {
        JSON.parse(fallbackStr);
        return fallbackStr;
      } catch {
        // Last resort
      }
    }
    return json.substring(0, maxLen);
  }
}
