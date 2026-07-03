// =============================================================================
// DeepAnalyze Hub - AES-256-GCM Encryption Helper
// =============================================================================
// Used to encrypt stored SSH private keys (ssh_key_encrypted column).
// Master key comes from HUB_DATA_KEY env var, falling back to
// HUB_CONFIG.auth.jwtSecret.
//
// Format: base64(iv[12] | authTag[16] | ciphertext)
//
// SECURITY NOTE: The key derivation here uses padEnd/slice to ensure exactly
// 32 bytes for AES-256. This is NOT a proper KDF (no PBKDF2/argon2/scrypt).
// It is acceptable for deriving a key from a pre-shared secret that is already
// high-entropy (e.g., a 32+ char random string from HUB_DATA_KEY). If your
// HUB_DATA_KEY or jwtSecret is short or low-entropy, rotate to a strong random
// secret. For production hardening, consider wrapping this with a proper KDF
// in a future task.
// =============================================================================

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { HUB_CONFIG } from "./config.js";

const DATA_KEY = process.env.HUB_DATA_KEY || HUB_CONFIG.auth.jwtSecret;
const KEY = Buffer.from(DATA_KEY.padEnd(32, "0").slice(0, 32), "utf-8");

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns base64(iv[12] | authTag[16] | ciphertext).
 */
export function encryptString(plaintext: string): string {
  const iv = randomBytes(12);                // 12-byte IV (standard for GCM)
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();            // 16-byte authentication tag
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

/**
 * Decrypt a base64(iv[12] | authTag[16] | ciphertext) string using AES-256-GCM.
 * Throws if the auth tag verification fails (tampered or wrong key).
 */
export function decryptString(b64: string): string {
  const buf = Buffer.from(b64, "base64");
  const iv = buf.subarray(0, 12);             // first 12 bytes = IV
  const tag = buf.subarray(12, 28);           // next 16 bytes = auth tag
  const enc = buf.subarray(28);               // remainder = ciphertext
  const decipher = createDecipheriv("aes-256-gcm", KEY, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString("utf-8");
}
