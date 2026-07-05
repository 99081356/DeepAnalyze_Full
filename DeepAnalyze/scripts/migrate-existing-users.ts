#!/usr/bin/env tsx
/**
 * Migration script for existing da:full users.
 *
 * Detects weight directories that already exist on disk and writes
 * corresponding module_states rows (status=installed, mode=local).
 * Idempotent — safe to run multiple times.
 *
 * Usage:
 *   bun run scripts/migrate-existing-users.ts
 *   # or: tsx scripts/migrate-existing-users.ts
 *   # or: npx tsx scripts/migrate-existing-users.ts
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getPool, closePool } from '../src/store/pg.ts';
import { PgModuleStatesRepo } from '../src/store/repos/module-states.ts';

// Portable equivalent of Bun's `import.meta.dir` — works under tsx and bun.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const MODELS_DIR = path.join(PROJECT_ROOT, 'data', 'models');

type ModuleId = 'embedding' | 'asr' | 'docling' | 'mineru';

interface DetectedWeights {
  moduleId: ModuleId;
  exists: boolean;
  weightsPath?: string;
  weightsSizeMb?: number;
  processType: 'subprocess' | 'docker';
}

async function detectExistingWeights(): Promise<DetectedWeights[]> {
  const results: DetectedWeights[] = [];

  // BGE-M3
  const bgeDir = path.join(MODELS_DIR, 'bge-m3');
  const bgeBin = path.join(bgeDir, 'pytorch_model.bin');
  if (fs.existsSync(bgeBin)) {
    const stat = fs.statSync(bgeBin);
    results.push({
      moduleId: 'embedding',
      exists: true,
      weightsPath: 'data/models/bge-m3',
      weightsSizeMb: Math.floor(stat.size / 1024 / 1024),
      processType: 'subprocess',
    });
  } else {
    results.push({ moduleId: 'embedding', exists: false, processType: 'subprocess' });
  }

  // Whisper (cache dir, not models dir)
  const whisperCache = path.join(process.env.HOME || '/root', '.cache', 'whisper');
  const whisperBase = path.join(whisperCache, 'base.pt');
  if (fs.existsSync(whisperBase)) {
    const stat = fs.statSync(whisperBase);
    results.push({
      moduleId: 'asr',
      exists: true,
      weightsPath: whisperCache,
      weightsSizeMb: Math.floor(stat.size / 1024 / 1024),
      processType: 'subprocess',
    });
  } else {
    results.push({ moduleId: 'asr', exists: false, processType: 'subprocess' });
  }

  // Docling
  const doclingDir = path.join(MODELS_DIR, 'docling', 'layout');
  if (fs.existsSync(doclingDir)) {
    results.push({
      moduleId: 'docling',
      exists: true,
      weightsPath: 'data/models/docling',
      processType: 'subprocess',
    });
  } else {
    results.push({ moduleId: 'docling', exists: false, processType: 'subprocess' });
  }

  // MinerU — check if Docker image is present.
  // Detection of a local Docker image is environment-dependent; leaving as
  // not_installed by default. Users who have pulled the MinerU image can
  // manually set it to installed via the UI.
  results.push({ moduleId: 'mineru', exists: false, processType: 'docker' });

  return results;
}

async function main() {
  console.log('[migrate] detecting existing weights...');
  const pool = await getPool();
  const repo = new PgModuleStatesRepo(pool);

  const detected = await detectExistingWeights();
  for (const d of detected) {
    if (d.exists) {
      const existing = await repo.get(d.moduleId);
      if (existing && existing.status !== 'not_installed') {
        console.log(
          `[migrate] ${d.moduleId}: already configured (${existing.status}/${existing.mode}) — skipping`,
        );
        continue;
      }
      await repo.upsert({
        moduleId: d.moduleId,
        status: 'installed',
        mode: 'local',
        weightsPath: d.weightsPath,
        weightsSizeMb: d.weightsSizeMb,
        processType: d.processType,
        // NOTE: brief specifies gpuRequired=false unconditionally; users who
        // previously had GPU acceleration can flip this via the UI after
        // migration. See task-15 report (Minor concern).
        gpuRequired: false,
        installedAt: new Date(),
      });
      console.log(
        `[migrate] ${d.moduleId}: marked as installed/local (weights at ${d.weightsPath})`,
      );
    } else {
      console.log(`[migrate] ${d.moduleId}: no weights detected, leaving as not_installed`);
    }
  }

  await closePool();
  console.log('[migrate] done');
}

main().catch((err) => {
  console.error('[migrate] FATAL:', err);
  process.exit(1);
});
