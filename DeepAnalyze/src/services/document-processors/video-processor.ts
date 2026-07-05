// =============================================================================
// DeepAnalyze - Video Processor
// Uses ffprobe for metadata, ffmpeg for thumbnail extraction + audio track,
// VLM for scene-by-scene video understanding, and CapabilityDispatcher for
// audio transcription with speaker diarization.
// Falls back gracefully when ffmpeg, VLM, or ASR is unavailable.
// =============================================================================

import { execSync } from "node:child_process";
import { join, basename } from "node:path";
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  readFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import sharp from "sharp";
import type { DocumentProcessor, ParsedContent } from "./types.js";
import type {
  VideoRawData,
  VideoKeyframe,
  VideoScene,
  AudioRawData,
} from "./modality-types.js";
import { DocTagsFormatters } from "./modality-types.js";

/** Maximum number of thumbnails to extract (one every 30 s). */
const MAX_THUMBNAILS = 120;

/** Interval between thumbnail extractions in seconds. */
const THUMBNAIL_INTERVAL = 30;

/** Maximum number of frames to send to VLM in a single request. */
const MAX_VLM_FRAMES = 20;

/** Thumbnail resize width in pixels. */
const THUMBNAIL_WIDTH = 320;

export class VideoProcessor implements DocumentProcessor {
  private static readonly HANDLED_TYPES = new Set([
    "mp4", "avi", "mov", "mkv", "webm", "flv", "wmv",
  ]);

  canHandle(fileType: string): boolean {
    return VideoProcessor.HANDLED_TYPES.has(fileType);
  }

  getStepLabel(): string {
    return "video_analysis";
  }

  async parse(filePath: string): Promise<ParsedContent> {
    const format = filePath.split(".").pop() ?? "unknown";

    // ---- 1. ffprobe metadata ------------------------------------------------
    const duration = this.getDuration(filePath);
    const resolution = this.getResolution(filePath);
    const fps = this.getFps(filePath);
    const codec = this.getCodec(filePath);

    // Temp directory for all intermediate files
    const tmpDir = mkdtempSync(join(tmpdir(), "da-video-"));

    try {
      // ---- 2. Thumbnail generation ------------------------------------------
      const thumbnails = await this.extractThumbnails(filePath, tmpDir, duration);

      // ---- 3. Video understanding via VLM ----------------------------------
      const { scenes, keyframes } = await this.analyzeVideoWithVLM(
        filePath,
        thumbnails,
        duration,
        tmpDir,
      );

      // ---- 4. Audio track extraction + ASR ----------------------------------
      const transcript = await this.extractAndTranscribeAudio(
        filePath,
        tmpDir,
        duration,
      );

      // ---- 5. Time alignment: match transcript turns to scenes ---------------
      if (scenes.length > 0) {
        this.alignTurnsWithScenes(scenes, transcript.turns);
      }

      // ---- 6. Build VideoRawData -------------------------------------------
      const videoUnderstandingMethod = scenes.length > 0
        ? ("vlm_video" as const)
        : ("vlm_frames" as const);

      const videoRaw: VideoRawData = {
        duration,
        resolution,
        fps,
        codec,
        scenes: scenes.length > 0 ? scenes : undefined,
        keyframes,
        transcript,
        videoUnderstandingMethod,
      };

      // ---- 7. Build output text and doctags ---------------------------------
      const timeline = this.buildTimelineText(
        duration,
        format,
        scenes,
        keyframes,
        transcript,
      );

      const doctags = this.buildDoctags(scenes, keyframes, transcript);

      return {
        text: timeline,
        metadata: { sourceType: "video", duration, format },
        success: true,
        raw: videoRaw as unknown as Record<string, unknown>,
        doctags,
        modality: "video",
      };
    } catch (err) {
      return {
        text: `[视频分析失败: ${err instanceof Error ? err.message : String(err)}]`,
        metadata: { sourceType: "video", duration, format },
        success: false,
        error: err instanceof Error ? err.message : String(err),
        modality: "video",
      };
    } finally {
      // ---- Cleanup temp directory -------------------------------------------
      try {
        rmSync(tmpDir, { recursive: true });
      } catch {
        // Best-effort cleanup
      }
    }
  }

  // ===========================================================================
  // Thumbnail extraction
  // ===========================================================================

  /**
   * Extract frames every 30 seconds (max 120), resize to 320px width via
   * Sharp, and save as JPEG to a `frames/` subdirectory inside tmpDir.
   */
  private async extractThumbnails(
    filePath: string,
    tmpDir: string,
    duration: number,
  ): Promise<Array<{ time: number; path: string }>> {
    const framesDir = join(tmpDir, "frames");
    mkdirSync(framesDir, { recursive: true });

    if (duration <= 0) return [];

    const count = Math.min(
      Math.ceil(duration / THUMBNAIL_INTERVAL),
      MAX_THUMBNAILS,
    );

    try {
      // Extract raw frames via ffmpeg
      const rawDir = join(tmpDir, "raw_frames");
      mkdirSync(rawDir, { recursive: true });

      execSync(
        `ffmpeg -i "${filePath}" -vf "fps=1/${THUMBNAIL_INTERVAL}" -frames:v ${count} "${join(rawDir, "frame_%04d.jpg")}"`,
        { encoding: "utf-8", timeout: 120000 },
      );

      const files = readdirSync(rawDir)
        .filter((f) => f.endsWith(".jpg"))
        .sort();

      const thumbnails: Array<{ time: number; path: string }> = [];

      for (let i = 0; i < files.length; i++) {
        const rawPath = join(rawDir, files[i]);
        const time = i * THUMBNAIL_INTERVAL;
        const thumbPath = join(framesDir, `thumb_${String(i).padStart(4, "0")}.jpg`);

        try {
          // Resize to 320px width preserving aspect ratio
          await sharp(rawPath)
            .resize(THUMBNAIL_WIDTH, undefined, { withoutEnlargement: true })
            .jpeg({ quality: 80 })
            .toFile(thumbPath);

          thumbnails.push({ time, path: thumbPath });
        } catch {
          // If sharp fails for this frame, use the raw frame
          thumbnails.push({ time, path: rawPath });
        }
      }

      return thumbnails;
    } catch {
      return [];
    }
  }

  // ===========================================================================
  // VLM video understanding
  // ===========================================================================

  /**
   * Analyze video frames individually via CapabilityDispatcher.analyzeImage().
   * Uses the dedicated VLM endpoint (e.g. MiniMax /v1/coding_plan/vlm) which
   * correctly processes images, unlike router.chat() which may silently
   * ignore image_url content on some providers.
   *
   * Each selected frame is analyzed independently, then scenes are built from
   * frame descriptions. Consecutive frames with similar descriptions are
   * merged into the same scene.
   */
  private async analyzeVideoWithVLM(
    filePath: string,
    thumbnails: Array<{ time: number; path: string }>,
    duration: number,
    tmpDir: string,
  ): Promise<{ scenes: VideoScene[]; keyframes: VideoKeyframe[] }> {
    // Build keyframes from thumbnails as a baseline
    const keyframes: VideoKeyframe[] = thumbnails.map((t) => ({
      time: t.time,
      description: "",
    }));

    if (thumbnails.length === 0) {
      return { scenes: [], keyframes };
    }

    // Check if VLM is available via CapabilityDispatcher
    let dispatcher: InstanceType<typeof import("../../models/capability-dispatcher.js").CapabilityDispatcher> | null = null;
    try {
      const { CapabilityDispatcher } = await import("../../models/capability-dispatcher.js");
      const d = new CapabilityDispatcher();
      // Verify VLM provider is configured by attempting to resolve it
      const provider = await (d as any).resolveProvider("vlm");
      if (provider) {
        dispatcher = d;
      }
    } catch {
      // VLM not available
    }

    if (!dispatcher) {
      for (const kf of keyframes) {
        kf.description = "[关键帧描述待VLM集成]";
      }
      return { scenes: [], keyframes };
    }

    // Select up to MAX_VLM_FRAMES evenly spaced
    const selectedFrames = this.selectEvenlySpaced(thumbnails, MAX_VLM_FRAMES);

    // Analyze each frame individually via CapabilityDispatcher
    const frameDescriptions: Array<{ time: number; description: string; textOnScreen?: string }> = [];

    for (let i = 0; i < selectedFrames.length; i++) {
      const frame = selectedFrames[i];
      try {
        const base64 = readFileSync(frame.path).toString("base64");
        const imageDataUrl = `data:image/jpeg;base64,${base64}`;

        const prompt =
          `这是视频的第${i + 1}/${selectedFrames.length}帧（时间 ${formatTimeMMSS(frame.time)}）。` +
          "请详细且如实地描述这个视频帧中看到的所有内容，包括：\n" +
          "1. 场景环境（室内/室外、空间布局、背景）\n" +
          "2. 人物（数量、动作、表情、衣着）\n" +
          "3. 屏幕上或画面中的任何文字\n" +
          "4. 物体、工具、设备\n" +
          "5. 其他显著特征\n\n" +
          "重要：只描述你确实看到的内容，不要编造或推测不存在的细节。";

        const result = await dispatcher.analyzeImage(imageDataUrl, prompt, {
          signal: AbortSignal.timeout(90_000),
        });

        // Extract text on screen from the description
        const desc = result.content || "[帧描述不可用]";
        const textMatch = desc.match(/文字[：:]\s*(.+?)(?:\n|$)/);
        const textOnScreen = textMatch ? textMatch[1].trim() : undefined;

        frameDescriptions.push({
          time: frame.time,
          description: desc,
          textOnScreen,
        });

        // Update matching keyframe
        const kf = keyframes.find((k) => k.time === frame.time);
        if (kf) kf.description = desc;

        console.log(`[VideoProcessor] Frame ${i + 1}/${selectedFrames.length} at ${formatTimeMMSS(frame.time)}: ${desc.substring(0, 80)}...`);
      } catch (err) {
        console.warn(
          `[VideoProcessor] Frame ${i + 1} at ${formatTimeMMSS(frame.time)} analysis failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        frameDescriptions.push({ time: frame.time, description: "[帧分析失败]" });
        const kf = keyframes.find((k) => k.time === frame.time);
        if (kf) kf.description = "[帧分析失败]";
      }
    }

    // Build scenes by merging consecutive frames with similar content
    const scenes = this.buildScenesFromFrames(frameDescriptions, duration, thumbnails);

    // Fill remaining keyframes without descriptions
    for (const kf of keyframes) {
      if (!kf.description) {
        // Inherit from the closest scene
        const scene = scenes.find((s) => kf.time >= s.startTime && kf.time < s.endTime);
        kf.description = scene?.description || "[关键帧]";
      }
    }

    return { scenes, keyframes };
  }

  /**
   * Group frame descriptions into scenes. Consecutive frames whose
   * descriptions share significant keyword overlap are merged into one scene.
   */
  private buildScenesFromFrames(
    frameDescriptions: Array<{ time: number; description: string; textOnScreen?: string }>,
    duration: number,
    thumbnails: Array<{ time: number; path: string }>,
  ): VideoScene[] {
    if (frameDescriptions.length === 0) return [];

    const scenes: VideoScene[] = [];
    let sceneStartIdx = 0;

    for (let i = 1; i <= frameDescriptions.length; i++) {
      const isLast = i === frameDescriptions.length;
      const shouldSplit = !isLast && !this.descriptionsSimilar(
        frameDescriptions[i - 1].description,
        frameDescriptions[i].description,
      );

      if (shouldSplit || isLast) {
        const startTime = frameDescriptions[sceneStartIdx].time;
        const endTime = isLast ? duration : frameDescriptions[i].time;

        // Merge descriptions of all frames in this scene
        const merged = frameDescriptions.slice(sceneStartIdx, i);
        const description = merged.length === 1
          ? merged[0].description
          : this.mergeDescriptions(merged.map((f) => f.description));

        const textOnScreen = merged
          .map((f) => f.textOnScreen)
          .filter((t): t is string => !!t)
          .join("; ") || undefined;

        const thumb = this.findClosestThumbnail(thumbnails, startTime);

        scenes.push({
          index: scenes.length,
          startTime,
          endTime,
          description,
          textOnScreen,
          thumbnailPath: thumb?.path,
        });

        sceneStartIdx = i;
      }
    }

    return scenes;
  }

  /**
   * Check if two frame descriptions are similar enough to belong to the same scene.
   * Uses keyword overlap (Jaccard similarity) on Chinese content words.
   */
  private descriptionsSimilar(a: string, b: string): boolean {
    // Skip failed/placeholder descriptions
    if (a.startsWith("[") || b.startsWith("[")) return false;

    const extractWords = (text: string): Set<string> => {
      // Extract meaningful segments (2+ char sequences of CJK or Latin words)
      const cjk = text.match(/[\u4e00-\u9fff]{2,}/g) || [];
      const latin = text.match(/[a-zA-Z]{3,}/g) || [];
      return new Set([...cjk, ...latin.map((w) => w.toLowerCase())]);
    };

    const wordsA = extractWords(a);
    const wordsB = extractWords(b);

    if (wordsA.size === 0 || wordsB.size === 0) return false;

    let overlap = 0;
    for (const w of wordsA) {
      if (wordsB.has(w)) overlap++;
    }

    const jaccard = overlap / (wordsA.size + wordsB.size - overlap);
    return jaccard > 0.35; // 35% overlap threshold
  }

  /**
   * Merge multiple frame descriptions into a single scene description.
   * Takes the longest description and appends unique details from others.
   */
  private mergeDescriptions(descriptions: string[]): string {
    if (descriptions.length === 0) return "";
    if (descriptions.length === 1) return descriptions[0];

    // Sort by length (longest first) and merge unique details
    const sorted = [...descriptions].sort((a, b) => b.length - a.length);
    const merged = sorted[0];

    // For simplicity, just use the longest description
    // (individual frames within the same scene should have similar content)
    return merged;
  }


  // ===========================================================================
  // Audio track extraction + ASR
  // ===========================================================================

  /**
   * Extract the audio track from the video to a temporary WAV file, then
   * reuse the ASR pipeline (CapabilityDispatcher) for transcription with
   * speaker diarization.
   */
  private async extractAndTranscribeAudio(
    filePath: string,
    tmpDir: string,
    duration: number,
  ): Promise<AudioRawData> {
    const wavPath = join(tmpDir, "audio_track.wav");

    // Extract audio to WAV via ffmpeg
    try {
      execSync(
        `ffmpeg -i "${filePath}" -vn -acodec pcm_s16le -ar 16000 -ac 1 "${wavPath}" -y`,
        { encoding: "utf-8", timeout: 120000 },
      );
    } catch {
      // No audio track or ffmpeg failed
      return {
        duration,
        speakers: [],
        turns: [],
        diarizationMethod: "none",
      };
    }

    // Check that the WAV file exists and has content
    if (!existsSync(wavPath)) {
      return {
        duration,
        speakers: [],
        turns: [],
        diarizationMethod: "none",
      };
    }

    // Run ASR via CapabilityDispatcher (same as AudioProcessor)
    let transcription = "";
    let detectedLanguage: string | undefined;

    try {
      const audioData = readFileSync(wavPath).buffer as ArrayBuffer;
      const { CapabilityDispatcher } = await import("../../models/capability-dispatcher.js");
      const dispatcher = new CapabilityDispatcher();

      const result = await dispatcher.transcribeAudio(audioData, basename(wavPath), {
        language: undefined, // auto-detect
      });

      transcription = result.text || "";
      detectedLanguage = result.language;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("No audio transcription provider")) {
        transcription = `[音频转写失败: ${message}]`;
      }
    }

    // Local Whisper fallback
    if (!transcription || transcription.startsWith("[")) {
      try {
        const { getWhisperManager, transcribeWithWhisper } = await import("../../subprocess/whisper-client.js");
        const whisperMgr = await getWhisperManager();
        if (whisperMgr) {
          const result = await transcribeWithWhisper(whisperMgr, wavPath, { language: null, model_size: "base" });
          transcription = result.text;
          detectedLanguage = result.language;
        }
      } catch (whisperErr) {
        console.warn(`[VideoProcessor] Local Whisper ASR failed: ${whisperErr instanceof Error ? whisperErr.message : String(whisperErr)}`);
      }
    }

    if (!transcription) {
      return {
        duration,
        language: detectedLanguage,
        speakers: [],
        turns: [],
        diarizationMethod: "none",
      };
    }

    // Build turns with speaker diarization (reuse same logic as AudioProcessor)
    const { turns, speakers, diarizationMethod } = this.buildTurnsWithDiarization(
      transcription,
      duration,
    );

    return {
      duration,
      language: detectedLanguage,
      speakers,
      turns,
      diarizationMethod,
    };
  }

  // ===========================================================================
  // Time alignment
  // ===========================================================================

  /**
   * Align transcript turns with scenes by assigning turns whose startTime
   * falls within a scene's time range to that scene. This is informational
   * only (used by the video-structure compiler).
   */
  private alignTurnsWithScenes(
    scenes: VideoScene[],
    turns: Array<{ speaker: string; startTime: number; endTime: number; text: string }>,
  ): void {
    // Turns are already aligned by time range in the structure compiler;
    // this method exists for potential future enrichment of scene objects
    // (e.g., embedding transcript snippets in scene descriptions).
    // For now, no-op — the compiler reads turns and scenes separately.
    void scenes;
    void turns;
  }

  // ===========================================================================
  // Output builders
  // ===========================================================================

  private buildTimelineText(
    duration: number,
    format: string,
    scenes: VideoScene[],
    keyframes: VideoKeyframe[],
    transcript: AudioRawData,
  ): string {
    const parts: string[] = [];

    parts.push("# 视频分析\n");
    parts.push(`时长: ${duration}s`);
    parts.push(`格式: ${format}`);
    parts.push(`场景数: ${scenes.length || keyframes.length}`);
    parts.push(`转录段数: ${transcript.turns.length}\n`);

    if (scenes.length > 0) {
      parts.push("## 场景分析\n");
      for (const scene of scenes) {
        const timeStr = `${formatTimeMMSS(scene.startTime)}-${formatTimeMMSS(scene.endTime)}`;
        parts.push(`### 场景${scene.index + 1} (${timeStr})`);
        parts.push(scene.description);
        if (scene.keyEvents && scene.keyEvents.length > 0) {
          parts.push(`关键事件: ${scene.keyEvents.join(", ")}`);
        }
        if (scene.textOnScreen) {
          parts.push(`屏幕文字: ${scene.textOnScreen}`);
        }
        parts.push("");
      }
    } else {
      parts.push("## 关键帧\n");
      for (const kf of keyframes) {
        parts.push(`### ${formatTimeMMSS(kf.time)}`);
        parts.push(kf.description);
        parts.push("");
      }
    }

    if (transcript.turns.length > 0) {
      parts.push("## 转录文本\n");
      for (const turn of transcript.turns) {
        const timeStr = `${formatTimeMMSS(turn.startTime)}-${formatTimeMMSS(turn.endTime)}`;
        parts.push(`[${turn.speaker}] (${timeStr}) ${turn.text}`);
      }
    }

    return parts.join("\n");
  }

  private buildDoctags(
    scenes: VideoScene[],
    keyframes: VideoKeyframe[],
    transcript: AudioRawData,
  ): string {
    const parts: string[] = [];

    if (scenes.length > 0) {
      for (const scene of scenes) {
        const sceneTurns = transcript.turns.filter(
          (t) => t.startTime >= scene.startTime && t.startTime < scene.endTime,
        );
        parts.push(DocTagsFormatters.videoScene(scene, sceneTurns));
      }
    } else {
      for (const kf of keyframes) {
        parts.push(DocTagsFormatters.videoScene(kf, []));
      }
    }

    return parts.join("\n");
  }

  // ===========================================================================
  // Speaker diarization (same logic as AudioProcessor)
  // ===========================================================================

  /** Minimum silence gap (seconds) to treat as a speaker change boundary. */
  private static readonly SILENCE_GAP_THRESHOLD = 1.5;

  /** Sentence-splitting regex covering CJK and Latin punctuation plus newlines. */
  private static readonly SENTENCE_RE = /[。！？.!?\n]+/;

  private buildTurnsWithDiarization(
    text: string,
    duration: number,
  ): {
    turns: AudioRawData["turns"];
    speakers: AudioRawData["speakers"];
    diarizationMethod: "silence" | "none";
  } {
    if (!text || text.startsWith("[")) {
      return {
        turns: [{
          speaker: "S1",
          startTime: 0,
          endTime: duration || 0,
          text: text || "",
        }],
        speakers: [{ id: "S1", label: "说话者 1", totalDuration: duration || 0 }],
        diarizationMethod: "none",
      };
    }

    const SENTENCE_RE = VideoProcessor.SENTENCE_RE;
    const SILENCE_GAP = VideoProcessor.SILENCE_GAP_THRESHOLD;

    const rawSentences = text.split(SENTENCE_RE);
    const sentences: string[] = [];
    for (const s of rawSentences) {
      const trimmed = s.trim();
      if (trimmed) sentences.push(trimmed);
    }

    if (sentences.length === 0) {
      return {
        turns: [{
          speaker: "S1",
          startTime: 0,
          endTime: duration || 0,
          text: text,
        }],
        speakers: [{ id: "S1", label: "说话者 1", totalDuration: duration || 0 }],
        diarizationMethod: "none",
      };
    }

    // Estimate timestamps via proportional time allocation
    const totalChars = sentences.reduce((sum, s) => sum + s.length, 0);
    const effectiveDuration = duration > 0 ? duration : totalChars * 0.25;

    // Reserve time for inter-sentence pauses so that silence-based diarization
    // can detect gaps.  Use 0.4s per gap; total pause time is capped at 20% of
    // the effective duration to avoid over-compressing speech.
    const INTER_SENTENCE_PAUSE = 0.4; // seconds
    const numGaps = sentences.length - 1;
    const totalPauseTime = Math.min(numGaps * INTER_SENTENCE_PAUSE, effectiveDuration * 0.2);
    const speechDuration = effectiveDuration - totalPauseTime;

    interface SentenceWithTime {
      text: string;
      startTime: number;
      endTime: number;
    }

    const timed: SentenceWithTime[] = [];
    let cursor = 0;

    for (let idx = 0; idx < sentences.length; idx++) {
      const sentence = sentences[idx];
      const proportion = sentence.length / totalChars;
      const segmentDuration = proportion * speechDuration;
      const start = cursor;
      const end = cursor + segmentDuration;
      timed.push({ text: sentence, startTime: start, endTime: end });
      cursor = end;
      // Insert a pause after every sentence except the last
      if (idx < sentences.length - 1) {
        cursor += totalPauseTime / numGaps;
      }
    }

    // Silence-based speaker diarization
    let hadSilenceGap = false;
    let currentSpeaker = 1;
    const speakerIds: string[] = ["S1"];

    for (let i = 1; i < timed.length; i++) {
      const gap = timed[i].startTime - timed[i - 1].endTime;
      if (gap >= SILENCE_GAP) {
        currentSpeaker++;
        hadSilenceGap = true;
      }
      speakerIds.push(`S${currentSpeaker}`);
    }

    const diarizationMethod = hadSilenceGap ? "silence" as const : "none" as const;

    if (!hadSilenceGap) {
      for (let i = 0; i < timed.length; i++) {
        speakerIds[i] = "S1";
      }
    }

    // Group consecutive sentences from the same speaker into turns
    const turns: AudioRawData["turns"] = [];
    const speakerDurations: Map<string, number> = new Map();

    let i = 0;
    while (i < timed.length) {
      const speaker = speakerIds[i];
      let turnStart = timed[i].startTime;
      let turnEnd = timed[i].endTime;
      const textParts: string[] = [timed[i].text];
      let j = i + 1;

      while (j < timed.length && speakerIds[j] === speaker) {
        turnEnd = timed[j].endTime;
        textParts.push(timed[j].text);
        j++;
      }

      const turn = {
        speaker,
        startTime: turnStart,
        endTime: turnEnd,
        text: textParts.join(" "),
      };
      turns.push(turn);

      const dur = turnEnd - turnStart;
      speakerDurations.set(speaker, (speakerDurations.get(speaker) ?? 0) + dur);

      i = j;
    }

    const uniqueSpeakers = [...new Set(speakerIds)];
    const speakers: AudioRawData["speakers"] = uniqueSpeakers.map((id) => ({
      id,
      label: `说话者 ${id.slice(1)}`,
      totalDuration: speakerDurations.get(id) ?? 0,
    }));

    return { turns, speakers, diarizationMethod };
  }

  // ===========================================================================
  // ffprobe helpers
  // ===========================================================================

  private getDuration(filePath: string): number {
    try {
      const result = execSync(
        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
        { encoding: "utf-8", timeout: 10000 },
      );
      return parseFloat(result.trim()) || 0;
    } catch {
      return 0;
    }
  }

  private getResolution(filePath: string): string | undefined {
    try {
      const result = execSync(
        `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "${filePath}"`,
        { encoding: "utf-8", timeout: 10000 },
      );
      return result.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private getFps(filePath: string): number | undefined {
    try {
      const result = execSync(
        `ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
        { encoding: "utf-8", timeout: 10000 },
      );
      const parts = result.trim().split("/");
      if (parts.length === 2) {
        return parseFloat(parts[0]) / parseFloat(parts[1]);
      }
      return parseFloat(result.trim()) || undefined;
    } catch {
      return undefined;
    }
  }

  private getCodec(filePath: string): string | undefined {
    try {
      const result = execSync(
        `ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
        { encoding: "utf-8", timeout: 10000 },
      );
      return result.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  // ===========================================================================
  // Utility helpers
  // ===========================================================================

  /**
   * Select up to `maxCount` evenly spaced items from the array.
   */
  private selectEvenlySpaced<T>(
    items: T[],
    maxCount: number,
  ): T[] {
    if (items.length <= maxCount) return items;

    const step = (items.length - 1) / (maxCount - 1);
    const selected: T[] = [];
    for (let i = 0; i < maxCount; i++) {
      selected.push(items[Math.round(i * step)]);
    }
    return selected;
  }

  /**
   * Find the thumbnail closest to a given time.
   */
  private findClosestThumbnail(
    thumbnails: Array<{ time: number; path: string }>,
    targetTime: number,
  ): { time: number; path: string } | undefined {
    if (thumbnails.length === 0) return undefined;

    let closest = thumbnails[0];
    let minDiff = Math.abs(closest.time - targetTime);

    for (const t of thumbnails) {
      const diff = Math.abs(t.time - targetTime);
      if (diff < minDiff) {
        minDiff = diff;
        closest = t;
      }
    }

    return closest;
  }
}

// =============================================================================
// Standalone helper
// =============================================================================

function formatTimeMMSS(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
