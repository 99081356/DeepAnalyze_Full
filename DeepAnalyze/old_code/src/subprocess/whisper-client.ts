/**
 * Whisper client – thin convenience wrapper around SubprocessManager
 * for communicating with the Python Whisper ASR service.
 *
 * Usage:
 *   const mgr = new SubprocessManager();
 *   await startWhisper(baseDir, mgr);
 *   const result = await transcribeWithWhisper(mgr, "/path/to/audio.wav");
 *   await mgr.stopAll();
 */

import { SubprocessManager } from "./manager.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WhisperTranscriptionResult {
  text: string;
  language?: string;
}

export interface WhisperOptions {
  /** Language hint (e.g. "zh"). null / undefined = auto-detect. */
  language?: string | null;
  /** Whisper model size: tiny | base | small | medium | large. Default: base */
  model_size?: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the Whisper Python subprocess.
 *
 * @param baseDir  Project root directory (whisper-service/ is expected
 *                 to live directly under this directory).
 * @param mgr      SubprocessManager instance.
 */
export async function startWhisper(baseDir: string, mgr: SubprocessManager): Promise<void> {
  const separator = baseDir.endsWith("/") ? "" : "/";
  const servicePath = `${baseDir}${separator}whisper-service`;

  await mgr.start("whisper", ["python3", "main.py"], servicePath);
}

/**
 * Send an audio file to the Whisper subprocess for transcription.
 *
 * @param mgr      SubprocessManager with a running "whisper" process.
 * @param filePath Absolute path to the audio file to transcribe.
 * @param options  Optional transcription options (language, model_size).
 * @returns        Transcription result with text and detected language.
 * @throws         Error if the Python service returns a non-ok status.
 */
export async function transcribeWithWhisper(
  mgr: SubprocessManager,
  filePath: string,
  options?: WhisperOptions,
): Promise<WhisperTranscriptionResult> {
  const result = await mgr.send("whisper", {
    file_path: filePath,
    language: options?.language ?? null,
    model_size: options?.model_size ?? "base",
  });

  if (result.status === "error") {
    throw new Error(result.error ?? "Unknown Whisper error");
  }

  return result.data as WhisperTranscriptionResult;
}

// ---------------------------------------------------------------------------
// Shared singleton manager (follows docling-processor.ts pattern)
// ---------------------------------------------------------------------------

let _sharedMgr: SubprocessManager | null = null;
let _sharedMgrStarting = false;
let _whisperAvailable: boolean | null = null;

/**
 * Get the shared Whisper subprocess manager singleton.
 *
 * Returns a cached SubprocessManager if the "whisper" process is already
 * running.  Otherwise creates a new SubprocessManager, starts the whisper
 * subprocess, and returns it.
 *
 * Uses project root derived from DEEPANALYZE_CONFIG.dataDir (or process.cwd()
 * as a fallback).
 *
 * Returns null if Whisper is not available (e.g. openai-whisper not installed).
 */
export async function getWhisperManager(): Promise<SubprocessManager | null> {
  // If we already have a running manager, check it's still alive
  if (_sharedMgr) {
    if (_sharedMgr.isRunning("whisper")) {
      return _sharedMgr;
    }
    // Process died - discard and recreate
    console.warn("[WhisperClient] Shared process died, will restart");
    try { await _sharedMgr.stop("whisper"); } catch { /* ignore */ }
    _sharedMgr = null;
    _whisperAvailable = null;
  }

  // Prevent concurrent initialization
  if (_sharedMgrStarting) {
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (_sharedMgr && _sharedMgr.isRunning("whisper")) return _sharedMgr;
      if (!_sharedMgrStarting) break;
    }
    return null;
  }

  _sharedMgrStarting = true;
  try {
    // Determine project root from DEEPANALYZE_CONFIG or process.cwd()
    let projectRoot: string;
    try {
      const { DEEPANALYZE_CONFIG } = await import("../core/config.js");
      const { resolve } = await import("node:path");
      projectRoot = resolve(DEEPANALYZE_CONFIG.dataDir, "..");
    } catch {
      projectRoot = process.cwd();
    }

    const mgr = new SubprocessManager();
    await startWhisper(projectRoot, mgr);

    // Wait for the process to stabilize
    await new Promise((r) => setTimeout(r, 3000));

    if (mgr.isRunning("whisper")) {
      _sharedMgr = mgr;
      _whisperAvailable = true;
      console.log("[WhisperClient] Shared Whisper process started");
      return _sharedMgr;
    }

    // Process exited during startup
    console.warn("[WhisperClient] Whisper process exited during startup");
    _whisperAvailable = false;
    return null;
  } catch (err) {
    console.warn(
      `[WhisperClient] Failed to start shared process: ${err instanceof Error ? err.message : String(err)}`,
    );
    _whisperAvailable = false;
    return null;
  } finally {
    _sharedMgrStarting = false;
  }
}
