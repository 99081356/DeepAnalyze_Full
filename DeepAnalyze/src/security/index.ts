// =============================================================================
// DeepAnalyze - Security Module
// =============================================================================

export {
  detectSuspiciousPatterns,
  wrapExternalContent,
  unwrapExternalContent,
  hasBoundaryMarkers,
  type ExternalContentSource,
  type InjectionDetectionResult,
  type WrapOptions,
  type WrapResult,
} from "./prompt-injection.js";
