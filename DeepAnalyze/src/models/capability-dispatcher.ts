// =============================================================================
// DeepAnalyze - Model Capability Dispatcher
// =============================================================================
// Routes non-chat API calls (TTS, image gen, video gen, music gen) to the
// correct provider based on settings configuration. Each capability type has
// its own API protocol which this dispatcher implements.
// =============================================================================

import { getRepos } from "../store/repos/index.js";
import type { ProviderConfig } from "../store/repos/index.js";
import type { ModelRole } from "./provider.js";
import { resolveRegistryKey, PROVIDER_REGISTRY } from "./provider-registry.js";
import { withRetry } from "../utils/retry.js";

// ---------------------------------------------------------------------------
// Retryable predicate for capability-dispatcher errors
// ---------------------------------------------------------------------------

/**
 * Determine if an error from a capability API call is transient and worth
 * retrying. These errors are regular Error instances with HTTP status codes
 * or network keywords embedded in the message string.
 */
const isTransientApiError = (err: unknown): boolean => {
  if (err instanceof Error) {
    const msg = err.message;
    return /HTTP (429|500|502|503|504)/.test(msg) ||
           /timeout|ECONNREFUSED|ECONNRESET|fetch failed|rate.?limit|too many requests/i.test(msg);
  }
  return false;
};

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface TTSResult {
  /** Audio data as ArrayBuffer */
  audio: ArrayBuffer;
  /** MIME type (e.g. "audio/mp3") */
  contentType: string;
}

export interface ImageGenResult {
  /** Image data as ArrayBuffer */
  image: ArrayBuffer;
  /** MIME type (e.g. "image/png") */
  contentType: string;
}

export interface VideoGenResult {
  /** Video file URL or data */
  fileUrl?: string;
  video?: ArrayBuffer;
  contentType: string;
}

export interface MusicGenResult {
  /** Audio data as ArrayBuffer */
  audio: ArrayBuffer;
  /** MIME type (e.g. "audio/mp3") */
  contentType: string;
}

export interface TranscriptionResult {
  /** Transcribed text */
  text: string;
  /** Detected language */
  language?: string;
  /** Audio duration in seconds */
  duration?: number;
}

/** Runtime system capabilities derived from configured providers. */
export interface SystemCapabilities {
  text: boolean;
  vision: boolean;
  tts: boolean;
  audioTranscription: boolean;
  imageGeneration: boolean;
  videoGeneration: boolean;
  musicGeneration: boolean;
  embedding: boolean;
  webSearch: boolean;
}

export interface VisionAnalysisResult {
  /** Text description/analysis of the image */
  content: string;
}

// ---------------------------------------------------------------------------
// CapabilityDispatcher
// ---------------------------------------------------------------------------

export class CapabilityDispatcher {
  /**
   * Resolve a provider config for a given role by reading settings.
   */
  private async resolveProvider(role: ModelRole): Promise<ProviderConfig | null> {
    const repos = await getRepos();
    const settings = await repos.settings.getProviderSettings();
    const defaultId = settings.defaults[role as keyof typeof settings.defaults];
    if (!defaultId) return null;

    const provider = settings.providers.find(
      (p) => p.id === defaultId && p.enabled,
    );
    return provider ?? null;
  }

  /**
   * Detect system capabilities by inspecting configured providers.
   * For each capability, check if a provider is configured for the
   * corresponding role AND that provider's ProviderFeatures include it.
   */
  async getSystemCapabilities(): Promise<SystemCapabilities> {
    const repos = await getRepos();
    const settings = await repos.settings.getProviderSettings();

    // Build a map of role -> provider config
    const roleProviders: Partial<Record<string, ProviderConfig>> = {};
    for (const [role, providerId] of Object.entries(settings.defaults)) {
      if (!providerId) continue;
      const config = settings.providers.find(
        (p) => p.id === providerId && p.enabled,
      );
      if (config) {
        roleProviders[role] = config;
      }
    }

    // Check web search availability (env-based)
    const webSearch = !!(process.env.SEARCH_BACKEND === "serper"
      ? process.env.SERPER_API_KEY
      : true); // SearXNG default, always available if running

    // Derive capabilities from provider features
    const checkFeature = (
      role: string,
      feature: "chat" | "embeddings" | "tts" | "imageGeneration" | "videoGeneration" | "musicGeneration" | "audioTranscription" | "vision",
    ): boolean => {
      const config = roleProviders[role];
      if (!config) return false;
      const registryKey = resolveRegistryKey(config);
      if (!registryKey) return true; // Unknown provider — assume capable
      const meta = PROVIDER_REGISTRY[registryKey];
      if (!meta) return true; // Unknown provider — assume capable
      return meta.features[feature];
    };

    return {
      text: !!roleProviders.main,
      vision: checkFeature("vlm", "vision"),
      tts: checkFeature("tts", "tts"),
      audioTranscription: checkFeature("audio_transcribe", "audioTranscription"),
      imageGeneration: checkFeature("image_gen", "imageGeneration"),
      videoGeneration: checkFeature("video_gen", "videoGeneration"),
      musicGeneration: checkFeature("music_gen", "musicGeneration"),
      embedding: !!roleProviders.embedding,
      webSearch,
    };
  }

  /** Detect the API protocol based on provider endpoint */
  private detectProtocol(provider: ProviderConfig): 'minimax' | 'openai' {
    const endpoint = provider.endpoint || '';
    if (endpoint.includes('minimax')) return 'minimax';
    return 'openai';
  }

  // -----------------------------------------------------------------------
  // TTS (Text-to-Speech)
  // -----------------------------------------------------------------------

  /**
   * Generate speech from text using the configured TTS provider.
   * Supports MiniMax TTS API format and OpenAI-compatible /audio/speech.
   */
  async textToSpeech(
    text: string,
    options?: {
      voice?: string;
      speed?: number;
      model?: string;
    },
  ): Promise<TTSResult> {
    const provider = await this.resolveProvider("tts");
    if (!provider) throw new Error("No TTS provider configured. Set the 'tts' role default.");

    const protocol = this.detectProtocol(provider);
    const endpoint = provider.endpoint.replace(/\/+$/, "");
    const model = options?.model ?? provider.model;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (provider.apiKey) {
      headers["Authorization"] = `Bearer ${provider.apiKey}`;
    }

    if (protocol === 'minimax') {
      // MiniMax TTS API: POST /tts/text_to_speech
      return withRetry(async () => {
        const url = `${endpoint}/tts/text_to_speech`;
        const body = {
          model,
          text,
          voice: options?.voice ?? "male-qn-qingse",
          speed: options?.speed ?? 1.0,
          response_format: "mp3",
        };

        const resp = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });

        if (!resp.ok) {
          const errorText = await resp.text().catch(() => "unknown error");
          throw new Error(`TTS API returned HTTP ${resp.status}: ${errorText}`);
        }

        const audio = await resp.arrayBuffer();
        const contentType = resp.headers.get("content-type") ?? "audio/mp3";
        return { audio, contentType };
      }, { maxRetries: 3, baseDelayMs: 1000, isRetryable: isTransientApiError });
    }

    // OpenAI-compatible: POST /audio/speech
    return withRetry(async () => {
      const url = `${endpoint}/audio/speech`;
      const body = {
        model,
        input: text,
        voice: options?.voice ?? "alloy",
        speed: options?.speed ?? 1.0,
        response_format: "mp3",
      };

      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const errorText = await resp.text().catch(() => "unknown error");
        throw new Error(`TTS API returned HTTP ${resp.status}: ${errorText}`);
      }

      const audio = await resp.arrayBuffer();
      const contentType = resp.headers.get("content-type") ?? "audio/mp3";
      return { audio, contentType };
    }, { maxRetries: 3, baseDelayMs: 1000, isRetryable: isTransientApiError });
  }

  // -----------------------------------------------------------------------
  // Image Generation
  // -----------------------------------------------------------------------

  /**
   * Generate an image from a text prompt using the configured image_gen provider.
   * Supports MiniMax and OpenAI-compatible image generation API formats.
   */
  async generateImage(
    prompt: string,
    options?: {
      model?: string;
      width?: number;
      height?: number;
    },
  ): Promise<ImageGenResult> {
    const provider = await this.resolveProvider("image_gen");
    if (!provider) throw new Error("No image generation provider configured. Set the 'image_gen' role default.");

    const protocol = this.detectProtocol(provider);
    const endpoint = provider.endpoint.replace(/\/+$/, "");
    const model = options?.model ?? provider.model;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (provider.apiKey) {
      headers["Authorization"] = `Bearer ${provider.apiKey}`;
    }

    let url: string;
    let body: Record<string, unknown>;

    if (protocol === 'minimax') {
      url = `${endpoint}/image/generation`;
      body = { model, prompt };
      if (options?.width) body.width = options.width;
      if (options?.height) body.height = options.height;
    } else {
      // OpenAI-compatible: POST /images/generations
      url = `${endpoint}/images/generations`;
      body = {
        model,
        prompt,
        n: 1,
        size: `${options?.width ?? 1024}x${options?.height ?? 1024}`,
        response_format: "b64_json",
      };
    }

    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errorText = await resp.text().catch(() => "unknown error");
      throw new Error(`Image Gen API returned HTTP ${resp.status}: ${errorText}`);
    }

    const data = await resp.json() as { data?: Array<{ url?: string; b64_json?: string }> };

    if (data.data?.[0]?.url) {
      const imgResp = await fetch(data.data[0].url);
      const image = await imgResp.arrayBuffer();
      return { image, contentType: "image/png" };
    }

    if (data.data?.[0]?.b64_json) {
      const image = Uint8Array.from(atob(data.data[0].b64_json), (c) => c.charCodeAt(0)).buffer;
      return { image, contentType: "image/png" };
    }

    throw new Error("Image generation returned no data");
  }

  // -----------------------------------------------------------------------
  // Video Generation
  // -----------------------------------------------------------------------

  /**
   * Generate a video from a text prompt using the configured video_gen provider.
   * MiniMax video generation is asynchronous - this submits the task and polls
   * for completion.
   */
  async generateVideo(
    prompt: string,
    options?: {
      model?: string;
    },
  ): Promise<VideoGenResult> {
    const provider = await this.resolveProvider("video_gen");
    if (!provider) throw new Error("No video generation provider configured. Set the 'video_gen' role default.");

    const endpoint = provider.endpoint.replace(/\/+$/, "");
    const model = options?.model ?? provider.model;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (provider.apiKey) {
      headers["Authorization"] = `Bearer ${provider.apiKey}`;
    }

    // Step 1: Submit video generation task
    const submitUrl = `${endpoint}/video/generation`;
    const submitBody = { model, prompt };

    const submitResp = await fetch(submitUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(submitBody),
    });

    if (!submitResp.ok) {
      const errorText = await submitResp.text().catch(() => "unknown error");
      throw new Error(`Video Gen submit returned HTTP ${submitResp.status}: ${errorText}`);
    }

    const submitData = await submitResp.json() as { task_id?: string; id?: string };
    const taskId = submitData.task_id ?? submitData.id;

    if (!taskId) throw new Error("Video generation did not return a task ID");

    // Step 2: Poll for completion
    const pollUrl = `${endpoint}/video/generation/task`;
    const maxPolls = 120; // 10 minutes max at 5s intervals
    for (let i = 0; i < maxPolls; i++) {
      await new Promise((r) => setTimeout(r, 5000));

      const pollResp = await fetch(`${pollUrl}?task_id=${taskId}`, { headers });
      if (!pollResp.ok) continue;

      const pollData = await pollResp.json() as {
        status?: string;
        file?: { download_url?: string };
        output?: { download_url?: string };
      };

      if (pollData.status === "success" || pollData.status === "succeeded") {
        const downloadUrl = pollData.file?.download_url ?? pollData.output?.download_url;
        if (downloadUrl) {
          return { fileUrl: downloadUrl, contentType: "video/mp4" };
        }
      }

      if (pollData.status === "fail" || pollData.status === "failed") {
        throw new Error("Video generation task failed");
      }
    }

    throw new Error("Video generation timed out");
  }

  // -----------------------------------------------------------------------
  // Music Generation
  // -----------------------------------------------------------------------

  /**
   * Generate music from a text prompt using the configured music_gen provider.
   */
  async generateMusic(
    prompt: string,
    options?: {
      model?: string;
      duration?: number;
    },
  ): Promise<MusicGenResult> {
    const provider = await this.resolveProvider("music_gen");
    if (!provider) throw new Error("No music generation provider configured. Set the 'music_gen' role default.");

    const endpoint = provider.endpoint.replace(/\/+$/, "");
    const model = options?.model ?? provider.model;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (provider.apiKey) {
      headers["Authorization"] = `Bearer ${provider.apiKey}`;
    }

    // MiniMax Music Gen API: POST /music/generation
    const url = `${endpoint}/music/generation`;
    const body: Record<string, unknown> = {
      model,
      prompt,
    };
    if (options?.duration) body.duration = options.duration;

    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errorText = await resp.text().catch(() => "unknown error");
      throw new Error(`Music Gen API returned HTTP ${resp.status}: ${errorText}`);
    }

    const data = await resp.json() as { data?: { audio_url?: string; audio?: string } };

    if (data.data?.audio_url) {
      const audioResp = await fetch(data.data.audio_url);
      const audio = await audioResp.arrayBuffer();
      return { audio, contentType: "audio/mp3" };
    }

    if (data.data?.audio) {
      // base64 encoded audio
      const audio = Uint8Array.from(atob(data.data.audio), (c) => c.charCodeAt(0)).buffer;
      return { audio, contentType: "audio/mp3" };
    }

    throw new Error("Music generation returned no audio data");
  }

  // -----------------------------------------------------------------------
  // Audio Transcription (ASR)
  // -----------------------------------------------------------------------

  /**
   * Transcribe audio to text.
   * Mode-driven dispatch via module_states:
   *   - disabled (or no row): error
   *   - local: must be status=running, then call local Whisper HTTP service
   *   - remote: call the configured audio_transcribe provider
   */
  async transcribeAudio(
    audioData: ArrayBuffer,
    filename: string,
    options?: {
      language?: string;
      model?: string;
    },
  ): Promise<{
    text: string;
    language?: string;
    duration?: number;
  }> {
    // Read the ASR module's effective mode from module_states (single source
    // of truth — replaces the old hardcoded local-first priority).
    const { getPool } = await import("../store/pg.ts");
    const { PgModuleStatesRepo } = await import("../store/repos/module-states.ts");
    const repo = new PgModuleStatesRepo(await getPool());
    const state = await repo.get("asr");

    const mode = state?.mode ?? "disabled";

    if (mode === "disabled" || !state) {
      throw new Error("ASR module is disabled — configure it in Settings → Models → ASR");
    }

    if (mode === "local") {
      if (state.status !== "running") {
        throw new Error(`ASR local service is ${state.status} — start it in Settings`);
      }
      try {
        const localResult = await this.transcribeViaLocalWhisper(audioData, filename, options);
        if (localResult !== null) return localResult;
        throw new Error("Local Whisper service returned no result");
      } catch (err) {
        throw new Error(`Local Whisper failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (mode === "remote") {
      const provider = await this.resolveProvider("audio_transcribe");
      if (!provider) throw new Error("no remote ASR provider configured");

      const endpoint = provider.endpoint.replace(/\/+$/, "");
      const model = options?.model ?? provider.model;

      // Whisper-compatible: POST /audio/transcriptions (multipart/form-data)
      const formData = new FormData();
      formData.append("file", new Blob([audioData]), filename);
      formData.append("model", model);
      formData.append("response_format", "verbose_json");
      if (options?.language) formData.append("language", options.language);

      const headers: Record<string, string> = {};
      if (provider.apiKey) {
        headers["Authorization"] = `Bearer ${provider.apiKey}`;
      }

      return withRetry(async () => {
        const resp = await fetch(`${endpoint}/audio/transcriptions`, {
          method: "POST",
          headers,
          body: formData,
        });

        if (!resp.ok) {
          const errorText = await resp.text().catch(() => "unknown error");
          throw new Error(`ASR API returned HTTP ${resp.status}: ${errorText}`);
        }

        const data = await resp.json() as {
          text?: string;
          language?: string;
          duration?: number;
        };

        return {
          text: data.text ?? "",
          language: data.language,
          duration: data.duration,
        };
      }, { maxRetries: 3, baseDelayMs: 1000, isRetryable: isTransientApiError });
    }

    throw new Error(`unsupported ASR mode: ${mode}`);
  }

  /**
   * Try to transcribe audio via the local Whisper HTTP service.
   * Uses curl subprocess to bypass any proxy env vars that might interfere
   * with direct fetch() calls to localhost.
   * Returns null if local Whisper is unavailable.
   */
  private async transcribeViaLocalWhisper(
    audioData: ArrayBuffer,
    filename: string,
    options?: { language?: string; model?: string },
  ): Promise<{ text: string; language?: string; duration?: number } | null> {
    try {
      const { writeFile, unlink } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const { tmpdir } = await import("node:os");
      const { execFile } = await import("node:child_process");

      // Write to temp file — use only extension to avoid filename corruption
      const ext = filename.includes(".") ? filename.split(".").pop() : "wav";
      const tmpPath = join(tmpdir(), `asr-${Date.now()}.${ext}`);
      await writeFile(tmpPath, new Uint8Array(audioData));

      const whisperPort = process.env.WHISPER_HTTP_PORT ?? "9877";
      const model = options?.model ?? "base";
      const curlArgs = [
        "-s", "--noproxy", "*", "--max-time", "30",
        "-X", "POST",
        `http://127.0.0.1:${whisperPort}/v1/audio/transcriptions`,
        "-F", `file=@${tmpPath}`,
        "-F", `model=${model}`,
      ];
      if (options?.language) {
        curlArgs.push("-F", `language=${options.language}`);
      }

      try {
        return await new Promise<{ text: string; language?: string; duration?: number } | null>((resolve) => {
          execFile("curl", curlArgs, { timeout: 35000 }, (err, stdout) => {
            if (err) {
              console.warn(`[ASR] curl error: ${err.message}`);
              resolve(null);
              return;
            }
            try {
              const data = JSON.parse(stdout);
              if (data.error) {
                console.warn(`[ASR] Whisper error: ${data.error}`);
                resolve(null);
              } else if (typeof data.text === "string") {
                resolve({ text: data.text ?? "", language: data.language, duration: data.duration });
              } else {
                resolve(null);
              }
            } catch {
              resolve(null);
            }
          });
        });
      } finally {
        await unlink(tmpPath).catch(() => {});
      }
    } catch (subErr) {
      console.warn("[ASR] Local Whisper failed:", subErr instanceof Error ? subErr.message : String(subErr));
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // Vision / Image Understanding (VLM)
  // -----------------------------------------------------------------------

  /**
   * Analyze an image using the configured VLM provider.
   * For MiniMax: uses the /v1/coding_plan/vlm endpoint (Token Plan VLM API).
   * For OpenAI-compatible: uses /chat/completions with vision-format messages.
   */
  async analyzeImage(
    imageDataUrl: string,
    prompt: string,
    options?: {
      signal?: AbortSignal;
    },
  ): Promise<VisionAnalysisResult> {
    const provider = await this.resolveProvider("vlm");
    if (!provider) throw new Error("No VLM provider configured. Set the 'vlm' role default.");

    const protocol = this.detectProtocol(provider);
    const endpoint = provider.endpoint.replace(/\/+$/, "");

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (provider.apiKey) {
      headers["Authorization"] = `Bearer ${provider.apiKey}`;
    }

    if (protocol === 'minimax') {
      // MiniMax Token Plan VLM: POST /v1/coding_plan/vlm
      return withRetry(async () => {
        const url = `${endpoint}/coding_plan/vlm`;
        const body = {
          prompt,
          image_url: imageDataUrl,
        };

        const resp = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: options?.signal,
        });

        if (!resp.ok) {
          const errorText = await resp.text().catch(() => "unknown error");
          throw new Error(`MiniMax VLM API returned HTTP ${resp.status}: ${errorText}`);
        }

        const data = await resp.json() as {
          content?: string;
          base_resp?: { status_code: number; status_msg: string };
        };

        if (data.base_resp?.status_code !== undefined && data.base_resp.status_code !== 0) {
          throw new Error(`MiniMax VLM API error: ${data.base_resp.status_msg} (code ${data.base_resp.status_code})`);
        }

        return { content: data.content ?? "" };
      }, { maxRetries: 3, baseDelayMs: 1000, isRetryable: isTransientApiError, signal: options?.signal });
    }

    // OpenAI-compatible vision: POST /chat/completions with image_url content
    return withRetry(async () => {
      const url = `${endpoint}/chat/completions`;
      const body = {
        model: provider.model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: imageDataUrl } },
            ],
          },
        ],
        max_tokens: 4096,
      };

      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: options?.signal,
      });

      if (!resp.ok) {
        const errorText = await resp.text().catch(() => "unknown error");
        throw new Error(`VLM API returned HTTP ${resp.status}: ${errorText}`);
      }

      const data = await resp.json() as {
        choices?: Array<{ message?: { content?: string } }>;
      };

      if (!data.choices?.[0]?.message?.content) {
        throw new Error("VLM API returned no content");
      }

      return { content: data.choices[0].message.content };
    }, { maxRetries: 3, baseDelayMs: 1000, isRetryable: isTransientApiError, signal: options?.signal });
  }
}
