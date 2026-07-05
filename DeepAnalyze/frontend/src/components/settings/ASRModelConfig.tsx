import { ModuleCard } from "./ModuleCard";
import type { ProviderConfig, ProviderDefaults, ProviderMetadata } from "../../types/index";

/**
 * ASR (Whisper) configuration — wraps the unified ModuleCard.
 *
 * Previously a 212-line bare ModelConfigCard wrapper that consumed
 * providers/defaults/registry props. Now self-contained: the local Whisper
 * service and remote OpenAI-compatible APIs are configured via ModuleCard's
 * local/remote tabs. ModelsPanel still passes legacy props; they are accepted
 * but unused to preserve backwards compatibility.
 */
export function ASRModelConfig(_props: {
  providers: ProviderConfig[];
  defaults: ProviderDefaults | null;
  registry: ProviderMetadata[];
  onSetDefault: (role: string, providerId: string) => void;
  onSaveProvider: (provider: ProviderConfig) => Promise<void>;
}) {
  return <ModuleCard moduleId="asr" />;
}
