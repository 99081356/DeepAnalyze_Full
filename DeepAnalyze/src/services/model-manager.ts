import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Manages local ML models stored in data/models/.
 * Supports auto-download from ModelScope (preferred) / HuggingFace (fallback).
 */
export class ModelManager {
  private modelsDir: string;

  constructor(modelsDir?: string) {
    this.modelsDir = modelsDir ?? join(process.cwd(), 'data', 'models');
    if (!existsSync(this.modelsDir)) {
      mkdirSync(this.modelsDir, { recursive: true });
    }
  }

  /**
   * Get the local path for a model. Downloads if not already present.
   */
  async getModelPath(modelName: string): Promise<string> {
    const localPath = join(this.modelsDir, modelName);
    if (existsSync(join(localPath, 'config.json'))) {
      return localPath;
    }
    return this.download(modelName);
  }

  /**
   * List all locally available models (directories with config.json).
   */
  listLocalModels(): string[] {
    if (!existsSync(this.modelsDir)) return [];
    return readdirSync(this.modelsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && existsSync(join(this.modelsDir, d.name, 'config.json')))
      .map(d => d.name);
  }

  /**
   * Download a model. ModelScope first, HuggingFace as fallback.
   */
  private async download(modelName: string): Promise<string> {
    const targetDir = join(this.modelsDir, modelName);
    mkdirSync(targetDir, { recursive: true });

    console.log(`[ModelManager] Downloading model: ${modelName}`);

    // Try ModelScope first
    try {
      await this.downloadFromModelScope(modelName, targetDir);
      console.log(`[ModelManager] Downloaded ${modelName} from ModelScope`);
      return targetDir;
    } catch (err) {
      console.warn(`[ModelManager] ModelScope download failed: ${(err as Error).message}`);
    }

    // Fallback to HuggingFace
    try {
      await this.downloadFromHuggingFace(modelName, targetDir);
      console.log(`[ModelManager] Downloaded ${modelName} from HuggingFace`);
      return targetDir;
    } catch (err) {
      console.error(`[ModelManager] HuggingFace download also failed: ${(err as Error).message}`);
      throw new Error(`Failed to download model ${modelName} from both ModelScope and HuggingFace`);
    }
  }

  private async downloadFromModelScope(modelName: string, targetDir: string): Promise<void> {
    // Use modelscope Python package's snapshot_download
    const script = `
from modelscope import snapshot_download
snapshot_download("${modelName}", cache_dir="${this.modelsDir}")
`;
    const { stdout, stderr } = await execFileAsync('python3', ['-c', script], {
      timeout: 600_000, // 10 minutes timeout
    });
    if (stderr && !stderr.includes('Downloading')) {
      throw new Error(`ModelScope download error: ${stderr}`);
    }
  }

  private async downloadFromHuggingFace(modelName: string, targetDir: string): Promise<void> {
    // Use huggingface-cli
    const { stdout, stderr } = await execFileAsync('huggingface-cli', [
      'download', modelName, '--local-dir', targetDir,
    ], { timeout: 600_000 });
    if (stderr && stderr.includes('error')) {
      throw new Error(`HuggingFace download error: ${stderr}`);
    }
  }
}
