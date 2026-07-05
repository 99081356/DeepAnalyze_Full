// src/services/modules/probes/asr.ts
import { probeHttp } from "../health-probe.js";
import { loadModuleState, unknownHealth } from "./_helpers.js";

const WHISPER_PORT = process.env.WHISPER_HTTP_PORT ?? "9877";

export async function probeAsr() {
  const state = await loadModuleState("asr");
  if (!state || state.status === "not_installed") {
    return unknownHealth(state?.mode);
  }
  return probeHttp({
    url: `http://127.0.0.1:${WHISPER_PORT}/health`,
    mode: state.mode,
    endpoint: state.remoteEndpoint ?? `http://127.0.0.1:${WHISPER_PORT}`,
  });
}
