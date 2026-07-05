// =============================================================================
// DeepAnalyze - JWT Utility
// =============================================================================

export function extractBearer(authHeader: string): string | null {
  if (!authHeader.startsWith("Bearer ")) return null;
  return authHeader.slice(7).trim();
}

// Reserved for Task A3 (hub mode): inspect kid to select JWKS key for verification.
export function parseJwtHeader(token: string): {
  alg: string;
  kid?: string;
  iss?: string;
} | null {
  try {
    const part = token.split(".")[0];
    if (!part) return null;
    const padded = part + "=".repeat((4 - (part.length % 4)) % 4);
    const json = Buffer.from(padded, "base64url").toString("utf-8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}
