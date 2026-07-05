// src/services/modules/probes/embedding.ts
import { probeHttp } from "../health-probe.js";
import { loadModuleState, unknownHealth } from "./_helpers.js";

const EMBEDDING_PORT = process.env.EMBEDDING_PORT ?? "11435";

export async function probeEmbedding() {
  const state = await loadModuleState("embedding");
  if (!state || state.status === "not_installed") {
    return unknownHealth(state?.mode);
  }
  if (state.mode !== "local") {
    // remote mode: probe the configured endpoint
    return probeHttp({
      url: `${state.remoteEndpoint ?? "http://127.0.0.1:" + EMBEDDING_PORT}/health`,
      mode: state.mode,
      endpoint: state.remoteEndpoint ?? null,
    });
  }
  // local mode: probe the canonical local port
  return probeHttp({
    url: `http://127.0.0.1:${EMBEDDING_PORT}/health`,
    mode: state.mode,
    endpoint: `http://127.0.0.1:${EMBEDDING_PORT}`,
  });
}
