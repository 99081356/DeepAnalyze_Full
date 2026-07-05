// =============================================================================
// DeepAnalyze - AudioPlayer
// Audio playback with synchronized transcript and speaker labels
// =============================================================================

import { useState, useRef, useCallback } from "react";

export interface AudioPlayerProps {
  /** URL of the original audio file (supports Range requests). */
  src: string;
  /** Duration in seconds. */
  duration: number;
  /** Speaker list. */
  speakers: { id: string; label: string }[];
  /** Transcript turns with timestamps. */
  turns: { speaker: string; startTime: number; endTime: number; text: string }[];
}

const SPEAKER_COLORS = [
  "var(--interactive)",
  "var(--success)",
  "#f97316",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
];

function getSpeakerColor(speakerId: string): string {
  const idx = parseInt(speakerId.replace(/\D/g, ""), 10) || 0;
  return SPEAKER_COLORS[idx % SPEAKER_COLORS.length];
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export function AudioPlayer({ src, duration, speakers, turns }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [activeTurnIndex, setActiveTurnIndex] = useState(-1);
  const [loadError, setLoadError] = useState(false);

  const handleTimeUpdate = useCallback(() => {
    const t = audioRef.current?.currentTime ?? 0;
    setCurrentTime(t);
    const idx = turns.findIndex((turn) => t >= turn.startTime && t <= turn.endTime);
    if (idx !== activeTurnIndex) {
      setActiveTurnIndex(idx);
      if (idx >= 0 && transcriptRef.current) {
        const el = transcriptRef.current.querySelector(`[data-turn-index="${idx}"]`);
        el?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
  }, [turns, activeTurnIndex]);

  const seekTo = useCallback((time: number) => {
    if (audioRef.current) {
      audioRef.current.currentTime = time;
    }
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      {/* Audio element */}
      {loadError ? (
        <div style={{
          padding: "var(--space-3)",
          backgroundColor: "rgba(239, 68, 68, 0.06)",
          border: "1px solid rgba(239, 68, 68, 0.2)",
          borderRadius: "var(--radius-md)",
          color: "var(--error)",
          fontSize: "var(--text-sm)",
        }}>
          音频文件加载失败。请确认文件已正确上传。
        </div>
      ) : (
      <audio
        ref={audioRef}
        src={src}
        controls
        preload="metadata"
        onTimeUpdate={handleTimeUpdate}
        onError={() => setLoadError(true)}
        style={{ width: "100%", height: 40 }}
      />
      )}

      {/* Duration info */}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>
        <span>{formatTime(currentTime)} / {formatTime(duration)}</span>
        {speakers.length > 0 && (
          <>
            <span>·</span>
            <span>{speakers.length} 位发言人</span>
          </>
        )}
      </div>

      {/* Speaker legend */}
      {speakers.length > 1 && (
        <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
          {speakers.map((s) => (
            <span
              key={s.id}
              style={{
                fontSize: "var(--text-xs)",
                padding: "1px var(--space-2)",
                borderRadius: "var(--radius-sm)",
                border: `1px solid ${getSpeakerColor(s.id)}`,
                color: getSpeakerColor(s.id),
              }}
            >
              {s.label}
            </span>
          ))}
        </div>
      )}

      {/* Transcript with sync */}
      {turns.length > 0 && (
        <div
          ref={transcriptRef}
          style={{
            maxHeight: 200,
            overflowY: "auto",
            border: "1px solid var(--border-primary)",
            borderRadius: "var(--radius-md)",
            padding: "var(--space-2)",
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-1)",
          }}
        >
          {turns.map((turn, i) => {
            const isActive = i === activeTurnIndex;
            const speakerColor = getSpeakerColor(turn.speaker);
            return (
              <div
                key={i}
                data-turn-index={i}
                onClick={() => seekTo(turn.startTime)}
                style={{
                  padding: "var(--space-1) var(--space-2)",
                  borderRadius: "var(--radius-sm)",
                  backgroundColor: isActive ? "var(--interactive-light)" : "transparent",
                  cursor: "pointer",
                  transition: "background-color 0.2s",
                  display: "flex",
                  gap: "var(--space-2)",
                  alignItems: "flex-start",
                }}
              >
                <span
                  style={{
                    fontSize: "var(--text-xs)",
                    fontWeight: "var(--font-medium)",
                    color: speakerColor,
                    flexShrink: 0,
                    minWidth: 24,
                  }}
                >
                  {turn.speaker}
                </span>
                <span style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
                  {turn.text}
                </span>
                <span
                  style={{
                    fontSize: "var(--text-xs)",
                    color: "var(--text-tertiary)",
                    flexShrink: 0,
                    marginLeft: "auto",
                  }}
                >
                  {formatTime(turn.startTime)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
