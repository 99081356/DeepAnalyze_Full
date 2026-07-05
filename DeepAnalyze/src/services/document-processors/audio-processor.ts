// =============================================================================
// DeepAnalyze - Audio Processor
// Uses CapabilityDispatcher.transcribeAudio() for ASR with speaker diarization
// via silence detection. Falls back gracefully when ASR is not configured.
// =============================================================================

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { DocumentProcessor, ParsedContent } from "./types.js";
import type { AudioRawData, SpeakerTurn } from "./modality-types.js";
import { DocTagsFormatters } from "./modality-types.js";

/** Minimum silence gap (seconds) to treat as a speaker change boundary. */
const SILENCE_GAP_THRESHOLD = 1.5;

/** Sentence-splitting regex covering CJK and Latin punctuation plus newlines. */
const SENTENCE_RE = /[。！？.!?\n]+/;

export class AudioProcessor implements DocumentProcessor {
  private static readonly HANDLED_TYPES = new Set([
    "mp3", "wav", "flac", "aac", "ogg", "m4a", "wma",
  ]);

  canHandle(fileType: string): boolean {
    return AudioProcessor.HANDLED_TYPES.has(fileType);
  }

  getStepLabel(): string {
    return "transcription";
  }

  async parse(filePath: string): Promise<ParsedContent> {
    // ---- 1. ffprobe metadata ------------------------------------------------
    const { duration, sampleRate, channels } = this.getAudioMetadata(filePath);
    const format = filePath.split(".").pop() ?? "unknown";
    const fileName = basename(filePath);

    let transcription = "";
    let detectedLanguage: string | undefined;

    // ---- 2. ASR via CapabilityDispatcher ------------------------------------
    try {
      const audioData = readFileSync(filePath).buffer as ArrayBuffer;
      const { CapabilityDispatcher } = await import("../../models/capability-dispatcher.js");
      const dispatcher = new CapabilityDispatcher();

      const result = await dispatcher.transcribeAudio(audioData, fileName, {
        language: undefined, // auto-detect
      });

      transcription = result.text || "";
      detectedLanguage = result.language;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // If the error is about no provider configured, give a helpful message
      if (message.includes("No audio transcription provider")) {
        transcription = "";
      } else {
        transcription = `[音频转写失败: ${message}]`;
      }
    }

    // ---- 2b. Local Whisper fallback -----------------------------------------
    if (!transcription || transcription.startsWith("[")) {
      try {
        const { getWhisperManager, transcribeWithWhisper } = await import("../../subprocess/whisper-client.js");
        const whisperMgr = await getWhisperManager();
        if (whisperMgr) {
          const result = await transcribeWithWhisper(whisperMgr, resolve(filePath), { language: null, model_size: "base" });
          transcription = result.text;
          detectedLanguage = result.language;
        }
      } catch (whisperErr) {
        console.warn(`[AudioProcessor] Local Whisper ASR failed: ${whisperErr instanceof Error ? whisperErr.message : String(whisperErr)}`);
      }
    }

    // ---- 3. Fallback: ASR unavailable or empty transcription -----------------
    if (!transcription) {
      // ASR ran but produced no text, or ASR was unavailable
      const reason = detectedLanguage
        ? `ASR 服务已执行但未识别到语音内容（检测语言: ${detectedLanguage}）。` +
          `可能原因: 音频时长过短（${duration}s）、静音或无语音片段。`
        : `未配置ASR模型。请在设置中为 "audio_transcribe" 角色配置 Whisper API 兼容端点。`;

      const warning =
        `[音频转写不可用 - 时长: ${duration}s, 格式: ${format}]\n\n` + reason;

      const audioRaw: AudioRawData = {
        duration,
        sampleRate,
        channels,
        speakers: [],
        turns: [],
        diarizationMethod: "none",
      };

      return {
        text: warning,
        metadata: { sourceType: "audio", duration, format, fileName, transcriptionAvailable: false },
        success: true,
        raw: audioRaw,
        doctags: "",
        modality: "audio",
      };
    }

    // ---- 4. Build turns & speaker diarization --------------------------------
    const { turns, speakers, diarizationMethod } = this.buildTurnsWithDiarization(
      transcription,
      duration,
    );

    // ---- 5. Build AudioRawData -----------------------------------------------
    const audioRaw: AudioRawData = {
      duration,
      language: detectedLanguage,
      sampleRate,
      channels,
      speakers,
      turns,
      diarizationMethod,
    };

    const doctags = turns
      .map((turn) => DocTagsFormatters.audioTurn(turn))
      .join('\n');

    return {
      text: transcription,
      metadata: { sourceType: "audio", duration, format, fileName },
      success: true,
      raw: audioRaw,
      doctags,
      modality: "audio",
    };
  }

  // ---------------------------------------------------------------------------
  // Turn splitting & speaker diarization
  // ---------------------------------------------------------------------------

  /**
   * Split ASR text into sentences and assign speakers via silence-based
   * diarization (Tier 1) or fall back to single-speaker (Tier 2).
   *
   * Tier 1: Sentences are distributed across the total duration proportional
   *         to their character length. If the estimated gap between consecutive
   *         sentences is >= SILENCE_GAP_THRESHOLD seconds, we treat it as a
   *         speaker change and assign the next speaker label (S1, S2, S3...).
   * Tier 2: If no gaps meet the threshold, all turns belong to a single speaker.
   */
  private buildTurnsWithDiarization(
    text: string,
    duration: number,
  ): {
    turns: SpeakerTurn[];
    speakers: AudioRawData["speakers"];
    diarizationMethod: "silence" | "none";
  } {
    if (!text || text.startsWith("[")) {
      // Error or empty text: single placeholder turn
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

    // Split into sentences, keeping only non-empty fragments
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

    // ---- Estimate timestamps via proportional time allocation ----------------
    const totalChars = sentences.reduce((sum, s) => sum + s.length, 0);
    const effectiveDuration = duration > 0 ? duration : totalChars * 0.25; // fallback ~4 chars/sec

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

    // ---- Tier 1: Silence-based speaker diarization --------------------------
    // Detect gaps >= threshold between consecutive segments and mark as speaker changes.
    let speakerCount = 1;
    const speakerIds: string[] = ["S1"]; // one per sentence, by index
    let hadSilenceGap = false;

    for (let i = 1; i < timed.length; i++) {
      const gap = timed[i].startTime - timed[i - 1].endTime;
      if (gap >= SILENCE_GAP_THRESHOLD) {
        speakerCount++;
        hadSilenceGap = true;
      }
      const currentSpeakerNum = hadSilenceGap ? speakerCount : 1;
      speakerIds.push(`S${currentSpeakerNum}`);
      // If we didn't actually find a gap, reset so all are S1
    }

    // Re-evaluate: if no gap was ever >= threshold, everything is one speaker
    let diarizationMethod: "silence" | "none";
    const finalSpeakerIds: string[] = [];

    if (!hadSilenceGap) {
      // Tier 2: single speaker
      diarizationMethod = "none";
      for (let i = 0; i < timed.length; i++) {
        finalSpeakerIds.push("S1");
      }
    } else {
      // Re-run with proper speaker tracking
      diarizationMethod = "silence";
      let currentSpeaker = 1;
      finalSpeakerIds.push("S1");

      for (let i = 1; i < timed.length; i++) {
        const gap = timed[i].startTime - timed[i - 1].endTime;
        if (gap >= SILENCE_GAP_THRESHOLD) {
          currentSpeaker++;
        }
        finalSpeakerIds.push(`S${currentSpeaker}`);
      }
    }

    // Group consecutive sentences from the same speaker into turns
    const turns: SpeakerTurn[] = [];
    const speakerDurations: Map<string, number> = new Map();

    let i = 0;
    while (i < timed.length) {
      const speaker = finalSpeakerIds[i];
      let turnStart = timed[i].startTime;
      let turnEnd = timed[i].endTime;
      const textParts: string[] = [timed[i].text];
      let j = i + 1;

      while (j < timed.length && finalSpeakerIds[j] === speaker) {
        turnEnd = timed[j].endTime;
        textParts.push(timed[j].text);
        j++;
      }

      const turn: SpeakerTurn = {
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

    // Build speakers list
    const uniqueSpeakers = [...new Set(finalSpeakerIds)];
    const speakers: AudioRawData["speakers"] = uniqueSpeakers.map((id) => ({
      id,
      label: `说话者 ${id.slice(1)}`,
      totalDuration: speakerDurations.get(id) ?? 0,
    }));

    return { turns, speakers, diarizationMethod };
  }

  // ---------------------------------------------------------------------------
  // ffprobe helpers
  // ---------------------------------------------------------------------------

  /**
   * Get audio metadata (duration, sample rate, channels) via ffprobe.
   * Returns 0 / undefined for fields that cannot be determined.
   */
  private getAudioMetadata(filePath: string): {
    duration: number;
    sampleRate?: number;
    channels?: number;
  } {
    try {
      const duration = this.getFFProbeValue(filePath, "format=duration");
      const sampleRateStr = this.getFFProbeValue(filePath, "stream=sample_rate");
      const channelsStr = this.getFFProbeValue(filePath, "stream=channels");

      return {
        duration: parseFloat(duration) || 0,
        sampleRate: sampleRateStr ? parseInt(sampleRateStr, 10) || undefined : undefined,
        channels: channelsStr ? parseInt(channelsStr, 10) || undefined : undefined,
      };
    } catch {
      return { duration: 0 };
    }
  }

  /**
   * Query a single ffprobe entry value.
   */
  private getFFProbeValue(filePath: string, entry: string): string {
    try {
      const result = execSync(
        `ffprobe -v error -show_entries ${entry} -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
        { encoding: "utf-8", timeout: 10000 },
      );
      return result.trim();
    } catch {
      return "";
    }
  }
}
