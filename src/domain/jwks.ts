// =============================================================================
// DeepAnalyze Hub - JWKS Public Key Endpoint
// =============================================================================
// 输出 Hub 公钥集合（JWK Set 格式），DA 拉取用于本地验签。
// 当前仅暴露 1 把 key；预留扩展为多 key（轮换场景）。
// =============================================================================

import { getKeyPair, type Jwk } from "../core/keys.js";

export function getJwks(): { keys: Jwk[] } {
  const kp = getKeyPair();
  return { keys: [kp.jwk] };
}
