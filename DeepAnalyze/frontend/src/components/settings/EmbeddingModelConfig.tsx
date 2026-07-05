import { ModuleCard } from "./ModuleCard";
import type { ProviderConfig, ProviderDefaults } from "../../types/index";

/**
 * Embedding model configuration — wraps the unified ModuleCard.
 *
 * The previous 466-line component with manual Provider/custom-endpoint
 * dual mode is replaced by ModuleCard's local-deploy/remote-API tabs.
 * The mode switching and weight management is delegated to /api/modules/*.
 *
 * Existing props (`providers`, `defaults`, `onSave`, `onTest`) are kept
 * in the signature for backwards compatibility with ModelsPanel but are
 * no longer used — the new component is self-contained.
 */
export function EmbeddingModelConfig(_props: {
  providers: ProviderConfig[];
  defaults: ProviderDefaults | null;
  onSave: (providerId: string) => Promise<void>;
  onTest: (providerId: string) => Promise<{ success: boolean; message: string }>;
}) {
  return <ModuleCard moduleId="embedding" />;
}
