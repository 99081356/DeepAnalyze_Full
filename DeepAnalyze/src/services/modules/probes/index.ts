// src/services/modules/probes/index.ts
// Aggregator: re-exports all 7 probes + probeAllModules().
//
// Probe categories (per T17 brief correction 1):
//   - 4 true modules (rows in module_states): embedding/asr/docling/mineru
//   - 2 VLM sidecars (Docker containers, no module_states row): paddleocr-vl/glm-ocr
//   - 1 infrastructure (the database itself): pg
import type { ModuleHealth, ModuleHealthMap } from "../health-probe.js";
import { probeEmbedding } from "./embedding.js";
import { probeAsr } from "./asr.js";
import { probeDocling } from "./docling.js";
import { probeMineru } from "./mineru.js";
import { probePaddleocrVl } from "./paddleocr-vl.js";
import { probeGlmOcr } from "./glm-ocr.js";
import { probePg } from "./pg.js";

export { probeEmbedding, probeAsr, probeDocling, probeMineru, probePaddleocrVl, probeGlmOcr, probePg };

/**
 * Probe all 7 services in parallel. Each probe is independent — failures don't affect others.
 * Returns undefined for any probe that rejects (so the map key is omitted).
 */
export async function probeAllModules(): Promise<ModuleHealthMap> {
  const [embedding, asr, docling, mineru, paddleocrVl, glmOcr, pg] = await Promise.allSettled([
    probeEmbedding(),
    probeAsr(),
    probeDocling(),
    probeMineru(),
    probePaddleocrVl(),
    probeGlmOcr(),
    probePg(),
  ]);
  const unwrap = <T>(p: PromiseSettledResult<T>): T | undefined =>
    p.status === "fulfilled" ? p.value : undefined;
  return {
    embedding: unwrap(embedding),
    asr: unwrap(asr),
    docling: unwrap(docling),
    mineru: unwrap(mineru),
    paddleocrVl: unwrap(paddleocrVl),
    glmOcr: unwrap(glmOcr),
    pg: unwrap(pg),
  };
}
