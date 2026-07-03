// =============================================================================
// @deepanalyze/da-packer - Type Definitions
// =============================================================================
// Centralized type layer. Packager modules re-export Packaged* types from here
// to avoid circular imports between install-script-gen ↔ individual packagers.
// =============================================================================

export interface BuildOptions {
  daVersion: string;
  hubVersion: string;
  models: string[];           // ["bge-m3", "whisper-tiny", ...]
  skills: string[];           // skill package ids
  output: string;             // "da-bundle-v0.9.0.tar.gz"
  source: "hf" | "hf_mirror" | "enterprise" | "cache";
  enterpriseUrl?: string;
  platform: string[];         // ["linux/amd64", "linux/arm64"]
  split?: string;             // "2GB"
  includeHub: boolean;
  skipImages?: boolean;
  skipModels?: boolean;
  skipSkills?: boolean;
}

export interface BundleManifest {
  version: string;
  generatedAt: string;
  daImageTag: string;
  hubImageTag: string;
  platforms: string[];
  models: Array<{
    name: string;
    version: string;
    sha256: string;
    sizeBytes: number;
    files: Array<{ path: string; sha256: string; sizeBytes: number }>;
  }>;
  skills: Array<{
    name: string;
    version: string;
    source: string;
  }>;
  images: Array<{
    name: string;
    tag: string;
    platforms: Array<{ arch: string; sha256: string; sizeBytes: number }>;
  }>;
  checksumSha256: string;     // entire tar.gz sha
  totalSizeBytes: number;
}

// Wire-format model file (matches da-assets/manifest.json on disk)
export interface ModelFile {
  path: string;
  sha256: string;
  size_bytes: number;
}

export interface ModelManifestEntry {
  version: string;
  category: string;
  size_bytes: number;
  files: ModelFile[];
  sources: { huggingface?: string; hf_mirror?: string };
}

// =============================================================================
// Packaged* forward declarations — packager modules re-export from here
// =============================================================================

export interface PackagedImage {
  name: string;
  tag: string;
  fileName: string;
  sha256: string;
  sizeBytes: number;
  platform: string;
}

export interface PackagedModel {
  name: string;
  version: string;
  sha256: string;
  sizeBytes: number;
  files: Array<{ path: string; sha256: string; sizeBytes: number }>;
  status: "ok" | "failed" | "skipped";
  error?: string;
}

export interface PackagedSkill {
  name: string;
  version: string;
  source: string;
  sizeBytes: number;
}
