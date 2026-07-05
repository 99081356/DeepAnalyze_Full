// =============================================================================
// DeepAnalyze - useVoiceInput Hook
// Manages browser audio recording via MediaRecorder API and transcription.
// State machine: idle → recording → transcribing → idle
// =============================================================================

import { useState, useCallback, useRef } from "react";
import { api } from "../api/client";

type VoiceState = "idle" | "recording" | "transcribing";

export function useVoiceInput() {
  const [state, setState] = useState<VoiceState>("idle");
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  const start = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];

      // Prefer webm/opus, fall back to browser default
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : undefined;

      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      recorder.start(250); // Collect data every 250ms for responsiveness
      setState("recording");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setState("idle");
    }
  }, []);

  const stop = useCallback(async (): Promise<string | null> => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state !== "recording") {
      setState("idle");
      return null;
    }

    return new Promise<string | null>((resolve) => {
      recorder.onstop = async () => {
        // Stop all audio tracks
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;

        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        chunksRef.current = [];

        if (blob.size === 0) {
          setState("idle");
          resolve(null);
          return;
        }

        setState("transcribing");
        try {
          const result = await api.transcribeAudio(blob);
          setState("idle");
          resolve(result.text || null);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setError(msg);
          setState("idle");
          resolve(null);
        }
      };

      recorder.stop();
    });
  }, []);

  const cancel = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state === "recording") {
      recorder.onstop = null;
      recorder.stop();
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    chunksRef.current = [];
    mediaRecorderRef.current = null;
    setState("idle");
    setError(null);
  }, []);

  return { state, error, start, stop, cancel };
}
