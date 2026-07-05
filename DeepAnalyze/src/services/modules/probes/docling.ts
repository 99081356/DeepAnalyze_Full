// src/services/modules/probes/docling.ts
import { probeHttp } from "../health-probe.js";
import { loadModuleState, unknownHealth } from "./_helpers.js";

const DOCLING_PORT = process.env.DOCLING_PORT ?? "8700";

export async function probeDocling() {
  const state = await loadModuleState("docling");
  if (!state || state.status === "not_installed") {
    return unknownHealth(state?.mode);
  }
  return probeHttp({
    url: `http://127.0.0.1:${DOCLING_PORT}/health`,
    mode: state.mode,
    endpoint: state.remoteEndpoint ?? `http://127.0.0.1:${DOCLING_PORT}`,
  });
}
