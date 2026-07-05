// =============================================================================
// DeepAnalyze - VideoPlayer
// Video playback with scene synchronization, transcript, and frame timeline
// =============================================================================

import { useState, useRef, useCallback } from "react";
import { Clock } from "lucide-react";

export interface VideoScene {
  startTime: number;
  endTime: number;
  description: string;
  thumbnailUrl?: string;
}

export interface VideoPlayerProps {
  /** URL of the original video file (supports Range requests). */
  src: string;
  /** Duration in seconds. */
  duration: number;
  /** Video resolution string (e.g. "1920x1080"). */
  resolution?: string;
  /** Scenes from video understanding model. */
  scenes: VideoScene[];
  /** Transcript data. */
  transcript: {
    speakers: { id: string; label: string }[];
    turns: { speaker: string; startTime: number; endTime: number; text: string }[];
  };
  /** Frame thumbnail URLs (index-based). */
  frameUrls: string[];
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

export function VideoPlayer({ src, duration, resolution, scenes, transcript, frameUrls }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [activeScene, setActiveScene] = useState<VideoScene | null>(null);
  const [activeTurns, setActiveTurns] = useState<typeof transcript.turns>([]);
  const [loadError, setLoadError] = useState(false);

  const handleTimeUpdate = useCallback(() => {
    const t = videoRef.current?.currentTime ?? 0;
    setCurrentTime(t);

    const scene = scenes.find((s) => t >= s.startTime && t <= s.endTime);
    setActiveScene(scene ?? null);

    const active = transcript.turns.filter((turn) => t >= turn.startTime && t <= turn.endTime);
    setActiveTurns(active);
  }, [scenes, transcript.turns]);

  const seekTo = useCallback((time: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = time;
    }
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      {/* Video player */}
      <div style={{ position: "relative" }}>
        {loadError ? (
          <div style={{
            width: "100%",
            height: 200,
            borderRadius: "var(--radius-md)",
            backgroundColor: "#000",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--error)",
            fontSize: "var(--text-sm)",
          }}>
            视频文件加载失败。请确认文件已正确上传。
          </div>
        ) : (
        <video
          ref={videoRef}
          src={src}
          controls
          preload="metadata"
          onTimeUpdate={handleTimeUpdate}
          onError={() => setLoadError(true)}
          style={{ width: "100%", maxHeight: 360, borderRadius: "var(--radius-md)", backgroundColor: "#000" }}
        />
        )}
      </div>

      {/* Info row */}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>
        <Clock size={10} />
        <span>{formatTime(currentTime)} / {formatTime(duration)}</span>
        {resolution && (
          <>
            <span>·</span>
            <span>{resolution}</span>
          </>
        )}
        {scenes.length > 0 && (
          <>
            <span>·</span>
            <span>{scenes.length} 个场景</span>
          </>
        )}
      </div>

      {/* Scene info + transcript sidebar */}
      {(activeScene || activeTurns.length > 0) && (
        <div style={{
          padding: "var(--space-3)",
          border: "1px solid var(--border-primary)",
          borderRadius: "var(--radius-md)",
          backgroundColor: "var(--bg-tertiary)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-2)",
        }}>
          {activeScene && (
            <>
              <div style={{ fontSize: "var(--text-xs)", fontWeight: "var(--font-medium)", color: "var(--text-secondary)" }}>
                场景 ({formatTime(activeScene.startTime)}-{formatTime(activeScene.endTime)})
              </div>
              <p style={{ fontSize: "var(--text-xs)", color: "var(--text-primary)", margin: 0 }}>
                {activeScene.description}
              </p>
            </>
          )}
          {activeTurns.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)", marginTop: activeScene ? "var(--space-2)" : 0, borderTop: activeScene ? "1px solid var(--border-primary)" : "none", paddingTop: activeScene ? "var(--space-2)" : 0 }}>
              <span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>对话</span>
              {activeTurns.map((turn, i) => (
                <div key={i} style={{ display: "flex", gap: "var(--space-2)", alignItems: "flex-start" }}>
                  <span style={{
                    fontSize: "var(--text-xs)",
                    fontWeight: "var(--font-medium)",
                    color: getSpeakerColor(turn.speaker),
                    flexShrink: 0,
                  }}>
                    [{turn.speaker}]
                  </span>
                  <span style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
                    {turn.text}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Frame timeline */}
      {frameUrls.length > 0 && (
        <div style={{
          display: "flex",
          gap: "var(--space-1)",
          overflowX: "auto",
          padding: "var(--space-2) 0",
        }}>
          {frameUrls.map((url, i) => {
            const frameTime = (duration / (frameUrls.length + 1)) * (i + 1);
            return (
              <button
                key={i}
                onClick={() => seekTo(frameTime)}
                title={formatTime(frameTime)}
                style={{
                  flexShrink: 0,
                  padding: 0,
                  border: `1px solid ${Math.abs(currentTime - frameTime) < (duration / (frameUrls.length + 1) / 2) ? "var(--interactive)" : "var(--border-primary)"}`,
                  borderRadius: "var(--radius-sm)",
                  overflow: "hidden",
                  cursor: "pointer",
                  backgroundColor: "transparent",
                  position: "relative",
                }}
              >
                <img
                  src={url}
                  alt={`frame ${i}`}
                  style={{ width: 80, height: 45, objectFit: "cover", display: "block" }}
                />
                <span style={{
                  position: "absolute",
                  bottom: 0,
                  left: 0,
                  right: 0,
                  fontSize: 9,
                  color: "#fff",
                  backgroundColor: "rgba(0,0,0,0.7)",
                  textAlign: "center",
                  padding: "1px 0",
                }}>
                  {formatTime(frameTime)}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
