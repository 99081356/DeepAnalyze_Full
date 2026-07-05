// src/services/modules/probes/mineru.ts
import { probeHttp } from "../health-probe.js";
import { loadModuleState, unknownHealth } from "./_helpers.js";

const MINERU_PORT = "8001";  // from src/server/mineru-local-manager.ts:20

export async function probeMineru() {
  const state = await loadModuleState("mineru");
  if (!state || state.status === "not_installed") {
    return unknownHealth(state?.mode);
  }
  return probeHttp({
    url: `http://127.0.0.1:${MINERU_PORT}/health`,
    mode: state.mode,
    endpoint: state.remoteEndpoint ?? `http://127.0.0.1:${MINERU_PORT}`,
  });
}
