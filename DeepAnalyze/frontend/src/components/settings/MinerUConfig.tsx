import { ModuleCard } from "./ModuleCard";

/**
 * MinerU configuration — wraps the unified ModuleCard.
 *
 * Previously configured only a remote endpoint via getMinerUConfig/saveMinerUConfig.
 * Now ModuleCard handles both local Docker deployment and remote endpoint
 * configuration. The local mode uses mineru-local-manager.ts via /api/modules/mineru.
 */
export function MinerUConfig() {
  return <ModuleCard moduleId="mineru" />;
}
