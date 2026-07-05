# Sub-Project 3: Knowledge UI Unified Rewrite

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge documents/Wiki/search into a unified knowledge page, implement L0/L1/L2 button interaction with expand/collapse, add multimedia preview/playback (image, audio, video), and connect chat file upload.

**Architecture:** Replace the 7-tab KnowledgePanel with a single-page layout: top bar (KB selector + search + upload), document list with type-aware DocumentCards. Each card shows L0/L1/L2 level buttons that toggle inline content preview. Image/Audio/Video cards include dedicated media preview components. Chat page gets file upload wired to auto-create temp knowledge bases.

**Tech Stack:** React 19, TypeScript, Zustand, lucide-react icons, HTML5 `<audio>`/`<video>` elements

**Spec:** `docs/superpowers/specs/2026-04-18-deepanalyze-system-redesign.md` Section 五

---

## File Structure

| File | Responsibility |
|------|---------------|
| `frontend/src/components/knowledge/KnowledgePanel.tsx` | Major rewrite: remove tabs, unified layout with search bar |
| `frontend/src/components/knowledge/DocumentCard.tsx` | New: type-aware document card with L0/L1/L2 buttons + media preview |
| `frontend/src/components/knowledge/ImagePreview.tsx` | New: image preview with thumbnail, EXIF panel, fullscreen viewer |
| `frontend/src/components/knowledge/AudioPlayer.tsx` | New: audio player with transcript sync and speaker labels |
| `frontend/src/components/knowledge/VideoPlayer.tsx` | New: video player with scene sync, transcript, frame timeline |
| `frontend/src/components/knowledge/MediaPlayer.tsx` | New: auto-detect media type, delegates to Image/Audio/Video |
| `frontend/src/components/knowledge/KnowledgeSearchBar.tsx` | New: unified search bar with mode/topK/level controls |
| `frontend/src/hooks/useDocProcessing.ts` | Modify: add level-ready tracking (L0/L1/L2 per document) |
| `frontend/src/api/client.ts` | Modify: add media file serving API methods |
| `frontend/src/components/chat/MessageInput.tsx` | Modify: wire file upload to knowledge base |

---

### Task 1: API Client — Media File Serving Endpoints

**Files:**
- Modify: `frontend/src/api/client.ts`

Add API methods for the three file serving routes added in Sub-Project 2.

- [ ] **Step 1: Add media URL helpers and API methods**

In `frontend/src/api/client.ts`, add the following methods to the `api` object after the document methods (around line 243):

```typescript
// --- Media file serving ---

/** Get the URL for a document's original file (supports Range requests for audio/video). */
getOriginalFileUrl(kbId: string, docId: string): string {
  return `/api/knowledge/kbs/${kbId}/documents/${docId}/original`;
},

/** Get the URL for a document's image thumbnail. */
getThumbnailUrl(kbId: string, docId: string): string {
  return `/api/knowledge/kbs/${kbId}/documents/${docId}/thumbnail`;
},

/** Get the URL for a video document's frame thumbnail by index. */
getFrameUrl(kbId: string, docId: string, index: number): string {
  return `/api/knowledge/kbs/${kbId}/documents/${docId}/frames/${index}`;
},
```

These are pure URL constructors — no fetch needed since `<img>`, `<audio>`, `<video>` elements consume URLs directly.

- [ ] **Step 2: Commit**

```bash
git add frontend/src/api/client.ts
git commit -m "feat(api): add media file serving URL helpers for original, thumbnail, and video frames"
```

---

### Task 2: useDocProcessing Hook — Level-Ready Tracking

**Files:**
- Modify: `frontend/src/hooks/useDocProcessing.ts`

The spec requires L0/L1/L2 buttons to turn green independently as each level's compilation completes. The current hook only tracks a single step + progress. We need per-level readiness state.

- [ ] **Step 1: Add level readiness tracking**

Add a new `LevelReadiness` interface and expand the hook's state and return type:

```typescript
export interface LevelReadiness {
  L0: boolean;
  L1: boolean;
  L2: boolean;
}

interface UseDocProcessingReturn {
  /** Map of docId -> current processing state for docs being processed. */
  processingDocs: Map<string, ProcessingState>;
  /** Map of docId -> which levels are ready for expanded docs. */
  levelReadiness: Map<string, LevelReadiness>;
  /** Whether the WebSocket connection is alive. */
  wsConnected: boolean;
}
```

Add state:

```typescript
const [levelReadiness, setLevelReadiness] = useState<Map<string, LevelReadiness>>(() => new Map());
```

Handle `doc_compilation_progress` messages (new WS event type from backend). The backend sends these during compilation as each level completes:

```typescript
case "doc_level_ready": {
  const { docId, level } = msg; // level = "L0" | "L1" | "L2"
  setLevelReadiness((prev) => {
    const next = new Map(prev);
    const existing = next.get(docId) ?? { L0: false, L1: false, L2: false };
    next.set(docId, { ...existing, [level]: true });
    return next;
  });
  break;
}
```

In `doc_ready` handler, also set all levels to ready:

```typescript
case "doc_ready": {
  // ... existing code ...
  setLevelReadiness((prev) => {
    const next = new Map(prev);
    next.set(msg.docId, { L0: true, L1: true, L2: true });
    return next;
  });
  // ... existing code ...
}
```

In the cleanup effect, clear levelReadiness too:

```typescript
setLevelReadiness(new Map());
```

Update the return:

```typescript
return { processingDocs, levelReadiness, wsConnected: connected };
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/hooks/useDocProcessing.ts
git commit -m "feat(hook): add per-document L0/L1/L2 level readiness tracking via WebSocket"
```

---

### Task 3: KnowledgeSearchBar Component

**Files:**
- Create: `frontend/src/components/knowledge/KnowledgeSearchBar.tsx`

Unified search bar with mode/topK/level controls as specified in Section 5.4.6.

- [ ] **Step 1: Create the KnowledgeSearchBar component**

Create `frontend/src/components/knowledge/KnowledgeSearchBar.tsx`:

```typescript
// =============================================================================
// DeepAnalyze - KnowledgeSearchBar
// Unified search bar with mode, topK, and level controls for knowledge search
// =============================================================================

import { useState, useRef, useCallback } from "react";
import { Search, ChevronDown } from "lucide-react";

export type SearchMode = "semantic" | "vector" | "hybrid";

export interface KnowledgeSearchBarProps {
  /** Fired when search query changes (debounced). Empty string = clear. */
  onSearch: (query: string, mode: SearchMode, topK: number, levels: string[]) => void;
  /** Whether a search is in flight. */
  loading?: boolean;
  /** Additional CSS class name. */
  className?: string;
}

export function KnowledgeSearchBar({ onSearch, loading, className }: KnowledgeSearchBarProps) {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<SearchMode>("semantic");
  const [topK, setTopK] = useState(10);
  const [levels, setLevels] = useState<string[]>(["L1"]);
  const [showControls, setShowControls] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const handleChange = useCallback((value: string) => {
    setQuery(value);
    clearTimeout(debounceRef.current);
    if (!value.trim()) {
      onSearch("", mode, topK, levels);
      return;
    }
    debounceRef.current = setTimeout(() => {
      onSearch(value.trim(), mode, topK, levels);
    }, 300);
  }, [mode, topK, levels, onSearch]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && query.trim()) {
      clearTimeout(debounceRef.current);
      onSearch(query.trim(), mode, topK, levels);
    }
  }, [query, mode, topK, levels, onSearch]);

  const toggleLevel = useCallback((level: string) => {
    setLevels((prev) => {
      const next = prev.includes(level) ? prev.filter((l) => l !== level) : [...prev, level];
      if (next.length === 0) next.push("L1"); // keep at least one
      return next;
    });
  }, []);

  return (
    <div className={className} style={{ position: "relative" }}>
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        padding: "var(--space-2) var(--space-3)",
        border: "1px solid var(--border-primary)",
        borderRadius: "var(--radius-md)",
        backgroundColor: "var(--bg-tertiary)",
      }}>
        <Search size={16} style={{ color: "var(--text-tertiary)", flexShrink: 0 }} />
        <input
          type="text"
          value={query}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="搜索知识库..."
          style={{
            flex: 1,
            border: "none",
            outline: "none",
            backgroundColor: "transparent",
            fontSize: "var(--text-sm)",
            color: "var(--text-primary)",
          }}
        />
        {loading && (
          <span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>
            搜索中...
          </span>
        )}
        <button
          onClick={() => setShowControls((v) => !v)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-1)",
            padding: "var(--space-1) var(--space-2)",
            border: "1px solid var(--border-primary)",
            borderRadius: "var(--radius-sm)",
            backgroundColor: "transparent",
            color: "var(--text-secondary)",
            fontSize: "var(--text-xs)",
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          {mode === "semantic" ? "语义" : mode === "vector" ? "向量" : "混合"}
          <ChevronDown size={12} />
        </button>
      </div>

      {showControls && (
        <div style={{
          position: "absolute",
          top: "100%",
          left: 0,
          right: 0,
          zIndex: 10,
          marginTop: "var(--space-1)",
          padding: "var(--space-3)",
          border: "1px solid var(--border-primary)",
          borderRadius: "var(--radius-md)",
          backgroundColor: "var(--bg-secondary)",
          boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-3)",
        }}>
          {/* Search mode */}
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
            <span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)", width: 48 }}>
              模式
            </span>
            <div style={{ display: "flex", gap: "var(--space-1)" }}>
              {(["semantic", "vector", "hybrid"] as SearchMode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  style={{
                    padding: "var(--space-1) var(--space-2)",
                    border: mode === m ? "1px solid var(--interactive)" : "1px solid var(--border-primary)",
                    borderRadius: "var(--radius-sm)",
                    backgroundColor: mode === m ? "var(--interactive-light)" : "transparent",
                    color: mode === m ? "var(--interactive)" : "var(--text-secondary)",
                    fontSize: "var(--text-xs)",
                    cursor: "pointer",
                  }}
                >
                  {m === "semantic" ? "语义检索" : m === "vector" ? "向量检索" : "混合检索"}
                </button>
              ))}
            </div>
          </div>

          {/* TopK */}
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
            <span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)", width: 48 }}>
              召回数
            </span>
            <div style={{ display: "flex", gap: "var(--space-1)" }}>
              {[5, 10, 20, 50].map((k) => (
                <button
                  key={k}
                  onClick={() => setTopK(k)}
                  style={{
                    padding: "var(--space-1) var(--space-2)",
                    border: topK === k ? "1px solid var(--interactive)" : "1px solid var(--border-primary)",
                    borderRadius: "var(--radius-sm)",
                    backgroundColor: topK === k ? "var(--interactive-light)" : "transparent",
                    color: topK === k ? "var(--interactive)" : "var(--text-secondary)",
                    fontSize: "var(--text-xs)",
                    cursor: "pointer",
                  }}
                >
                  {k}
                </button>
              ))}
            </div>
          </div>

          {/* Levels */}
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
            <span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)", width: 48 }}>
              层级
            </span>
            <div style={{ display: "flex", gap: "var(--space-1)" }}>
              {["L0", "L1", "L2"].map((level) => (
                <button
                  key={level}
                  onClick={() => toggleLevel(level)}
                  style={{
                    padding: "var(--space-1) var(--space-2)",
                    border: levels.includes(level) ? "1px solid var(--interactive)" : "1px solid var(--border-primary)",
                    borderRadius: "var(--radius-sm)",
                    backgroundColor: levels.includes(level) ? "var(--interactive-light)" : "transparent",
                    color: levels.includes(level) ? "var(--interactive)" : "var(--text-secondary)",
                    fontSize: "var(--text-xs)",
                    cursor: "pointer",
                  }}
                >
                  {level}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/knowledge/KnowledgeSearchBar.tsx
git commit -m "feat(knowledge): add unified search bar with mode/topK/level controls"
```

---

### Task 4: ImagePreview Component

**Files:**
- Create: `frontend/src/components/knowledge/ImagePreview.tsx`

Image preview with thumbnail, EXIF info panel, and fullscreen viewer.

- [ ] **Step 1: Create the ImagePreview component**

Create `frontend/src/components/knowledge/ImagePreview.tsx`:

```typescript
// =============================================================================
// DeepAnalyze - ImagePreview
// Image preview component with thumbnail, EXIF metadata, and fullscreen viewer
// =============================================================================

import { useState, useCallback } from "react";
import { X, Download, Maximize2, Camera, MapPin, Clock } from "lucide-react";

export interface ImagePreviewProps {
  /** URL for the thumbnail image. */
  thumbnailUrl: string;
  /** URL for the full-size original image. */
  originalUrl: string;
  /** Image dimensions (e.g. "1920x1080"). */
  resolution?: string;
  /** EXIF metadata from the processed image. */
  exif?: {
    make?: string;
    model?: string;
    dateTime?: string;
    gps?: { lat: number; lng: number };
    iso?: number;
    exposureTime?: string;
    focalLength?: string;
    orientation?: number;
  };
}

export function ImagePreview({ thumbnailUrl, originalUrl, resolution, exif }: ImagePreviewProps) {
  const [fullscreen, setFullscreen] = useState(false);

  const handleDownload = useCallback(() => {
    const a = document.createElement("a");
    a.href = originalUrl;
    a.download = "image";
    a.click();
  }, [originalUrl]);

  return (
    <>
      <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "flex-start" }}>
        {/* Thumbnail */}
        <div style={{ position: "relative", flexShrink: 0 }}>
          <img
            src={thumbnailUrl}
            alt="thumbnail"
            style={{
              width: 120,
              height: 90,
              objectFit: "cover",
              borderRadius: "var(--radius-md)",
              border: "1px solid var(--border-primary)",
              cursor: "pointer",
            }}
            onClick={() => setFullscreen(true)}
          />
          <button
            onClick={() => setFullscreen(true)}
            title="查看原图"
            style={{
              position: "absolute",
              bottom: 4,
              right: 4,
              padding: 2,
              border: "none",
              borderRadius: "var(--radius-sm)",
              backgroundColor: "rgba(0,0,0,0.6)",
              color: "#fff",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
            }}
          >
            <Maximize2 size={12} />
          </button>
        </div>

        {/* EXIF info */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {resolution && (
            <p style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)", margin: "0 0 var(--space-1)" }}>
              {resolution}
            </p>
          )}
          {exif && (
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {exif.dateTime && (
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-1)", fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>
                  <Clock size={10} /> {exif.dateTime}
                </div>
              )}
              {(exif.make || exif.model) && (
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-1)", fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>
                  <Camera size={10} /> {exif.make} {exif.model}
                </div>
              )}
              {exif.gps && (
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-1)", fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>
                  <MapPin size={10} /> {exif.gps.lat.toFixed(4)}, {exif.gps.lng.toFixed(4)}
                </div>
              )}
            </div>
          )}
          <button
            onClick={handleDownload}
            style={{
              marginTop: "var(--space-2)",
              display: "flex",
              alignItems: "center",
              gap: "var(--space-1)",
              padding: "var(--space-1) var(--space-2)",
              border: "1px solid var(--border-primary)",
              borderRadius: "var(--radius-sm)",
              backgroundColor: "transparent",
              color: "var(--text-secondary)",
              fontSize: "var(--text-xs)",
              cursor: "pointer",
            }}
          >
            <Download size={10} /> 下载原图
          </button>
        </div>
      </div>

      {/* Fullscreen overlay */}
      {fullscreen && (
        <div
          onClick={() => setFullscreen(false)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9999,
            backgroundColor: "rgba(0,0,0,0.9)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
          }}
        >
          <img
            src={originalUrl}
            alt="full"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: "95vw", maxHeight: "95vh", objectFit: "contain" }}
          />
          <button
            onClick={() => setFullscreen(false)}
            style={{
              position: "absolute",
              top: 16,
              right: 16,
              padding: "var(--space-2)",
              border: "none",
              borderRadius: "50%",
              backgroundColor: "rgba(255,255,255,0.2)",
              color: "#fff",
              cursor: "pointer",
            }}
          >
            <X size={20} />
          </button>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/knowledge/ImagePreview.tsx
git commit -m "feat(knowledge): add image preview with EXIF metadata and fullscreen viewer"
```

---

### Task 5: AudioPlayer Component

**Files:**
- Create: `frontend/src/components/knowledge/AudioPlayer.tsx`

HTML5 audio player with transcript sync and speaker color labels.

- [ ] **Step 1: Create the AudioPlayer component**

Create `frontend/src/components/knowledge/AudioPlayer.tsx`:

```typescript
// =============================================================================
// DeepAnalyze - AudioPlayer
// Audio playback with synchronized transcript and speaker labels
// =============================================================================

import { useState, useRef, useCallback, useEffect } from "react";

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
  "var(--interactive)",      // blue
  "var(--success)",          // green
  "#f97316",                 // orange
  "#8b5cf6",                 // purple
  "#ec4899",                 // pink
  "#14b8a6",                 // teal
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

  const handleTimeUpdate = useCallback(() => {
    const t = audioRef.current?.currentTime ?? 0;
    setCurrentTime(t);
    // Find the current turn
    const idx = turns.findIndex((turn) => t >= turn.startTime && t <= turn.endTime);
    if (idx !== activeTurnIndex) {
      setActiveTurnIndex(idx);
      // Auto-scroll to the active turn
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
      <audio
        ref={audioRef}
        src={src}
        controls
        preload="metadata"
        onTimeUpdate={handleTimeUpdate}
        style={{ width: "100%", height: 40 }}
      />

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
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/knowledge/AudioPlayer.tsx
git commit -m "feat(knowledge): add audio player with transcript sync and speaker labels"
```

---

### Task 6: VideoPlayer Component

**Files:**
- Create: `frontend/src/components/knowledge/VideoPlayer.tsx`

HTML5 video player with scene sync, transcript overlay, and frame timeline.

- [ ] **Step 1: Create the VideoPlayer component**

Create `frontend/src/components/knowledge/VideoPlayer.tsx`:

```typescript
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

  const handleTimeUpdate = useCallback(() => {
    const t = videoRef.current?.currentTime ?? 0;
    setCurrentTime(t);

    // Find active scene
    const scene = scenes.find((s) => t >= s.startTime && t <= s.endTime);
    setActiveScene(scene ?? null);

    // Find active turns in current time window
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
        <video
          ref={videoRef}
          src={src}
          controls
          preload="metadata"
          onTimeUpdate={handleTimeUpdate}
          style={{ width: "100%", maxHeight: 360, borderRadius: "var(--radius-md)", backgroundColor: "#000" }}
        />
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
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/knowledge/VideoPlayer.tsx
git commit -m "feat(knowledge): add video player with scene sync, transcript, and frame timeline"
```

---

### Task 7: MediaPlayer Wrapper Component

**Files:**
- Create: `frontend/src/components/knowledge/MediaPlayer.tsx`

Auto-detect media type and delegate to the correct player component.

- [ ] **Step 1: Create the MediaPlayer wrapper**

Create `frontend/src/components/knowledge/MediaPlayer.tsx`:

```typescript
// =============================================================================
// DeepAnalyze - MediaPlayer
// Auto-detect media type and delegate to the correct preview component
// =============================================================================

import type { ImagePreviewProps } from "./ImagePreview";
import type { AudioPlayerProps } from "./AudioPlayer";
import type { VideoPlayerProps } from "./VideoPlayer";

export type MediaType = "image" | "audio" | "video";

export interface MediaPlayerProps {
  /** The type of media to display. */
  mediaType: MediaType;
  /** Props for image preview (required if mediaType is "image"). */
  imageProps?: ImagePreviewProps;
  /** Props for audio player (required if mediaType is "audio"). */
  audioProps?: AudioPlayerProps;
  /** Props for video player (required if mediaType is "video"). */
  videoProps?: VideoPlayerProps;
}

// Lazy imports to avoid loading all three when only one is needed
import { ImagePreview } from "./ImagePreview";
import { AudioPlayer } from "./AudioPlayer";
import { VideoPlayer } from "./VideoPlayer";

export function MediaPlayer({ mediaType, imageProps, audioProps, videoProps }: MediaPlayerProps) {
  switch (mediaType) {
    case "image":
      if (!imageProps) return null;
      return <ImagePreview {...imageProps} />;
    case "audio":
      if (!audioProps) return null;
      return <AudioPlayer {...audioProps} />;
    case "video":
      if (!videoProps) return null;
      return <VideoPlayer {...videoProps} />;
    default:
      return null;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/knowledge/MediaPlayer.tsx
git commit -m "feat(knowledge): add MediaPlayer wrapper for auto-detecting media type"
```

---

### Task 8: DocumentCard Component

**Files:**
- Create: `frontend/src/components/knowledge/DocumentCard.tsx`

The core card component that renders differently based on file type, with L0/L1/L2 buttons, media preview, and expand/collapse content areas.

- [ ] **Step 1: Create the DocumentCard component**

Create `frontend/src/components/knowledge/DocumentCard.tsx` with the following structure:

```typescript
// =============================================================================
// DeepAnalyze - DocumentCard
// Unified document card with L0/L1/L2 level buttons and media preview
// =============================================================================

import { useState, useCallback } from "react";
import { api } from "../../api/client";
import type { DocumentInfo } from "../../types/index";
import { MediaPlayer, type MediaType } from "./MediaPlayer";
import type { ImagePreviewProps } from "./ImagePreview";
import type { AudioPlayerProps } from "./AudioPlayer";
import type { VideoPlayerProps } from "./VideoPlayer";
import {
  FileText,
  Image,
  Mic,
  Video,
  Trash2,
  AlertCircle,
  CheckCircle,
  Clock,
  Loader2,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

/** File type classification based on extension. */
type FileCategory = "document" | "image" | "audio" | "video";

function classifyFile(filename: string): FileCategory {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "bmp", "tiff", "webp", "svg"].includes(ext)) return "image";
  if (["mp3", "wav", "flac", "aac", "ogg", "m4a", "wma"].includes(ext)) return "audio";
  if (["mp4", "avi", "mov", "mkv", "webm", "flv", "wmv"].includes(ext)) return "video";
  return "document";
}

function getFileIcon(category: FileCategory) {
  switch (category) {
    case "image": return Image;
    case "audio": return Mic;
    case "video": return Video;
    default: return FileText;
  }
}

export interface LevelReadiness {
  L0: boolean;
  L1: boolean;
  L2: boolean;
}

export interface DocumentCardProps {
  /** The document to display. */
  document: DocumentInfo;
  /** Per-level readiness state (from useDocProcessing). */
  levels: LevelReadiness;
  /** Active processing state (null if not processing). */
  processing?: { step: string; progress: number; error?: string } | null;
  /** Whether the card is selected for batch operations. */
  selected: boolean;
  /** Toggle selection callback. */
  onToggleSelect: () => void;
  /** Delete callback. */
  onDelete: () => void;
  /** Retry callback. */
  onRetry?: () => void;
  /** KB ID for constructing media URLs. */
  kbId: string;
}

export function DocumentCard({
  document: doc,
  levels,
  processing,
  selected,
  onToggleSelect,
  onDelete,
  onRetry,
  kbId,
}: DocumentCardProps) {
  const category = classifyFile(doc.filename);
  const FileIcon = getFileIcon(category);
  const [expandedLevel, setExpandedLevel] = useState<"L0" | "L1" | "L2" | "media" | null>(null);
  const [levelContent, setLevelContent] = useState<Record<string, string>>({});
  const [loadingLevel, setLoadingLevel] = useState<string | null>(null);

  const toggleLevel = useCallback(async (level: "L0" | "L1" | "L2") => {
    if (expandedLevel === level) {
      setExpandedLevel(null);
      return;
    }
    setExpandedLevel(level);
    // Fetch content if not already loaded
    if (!levelContent[level]) {
      setLoadingLevel(level);
      try {
        const result = await api.expandWiki(kbId, doc.id, level);
        setLevelContent((prev) => ({ ...prev, [level]: result.content }));
      } catch {
        setLevelContent((prev) => ({ ...prev, [level]: "(加载失败)" }));
      } finally {
        setLoadingLevel(null);
      }
    }
  }, [expandedLevel, levelContent, kbId, doc.id]);

  const toggleMedia = useCallback(() => {
    setExpandedLevel((prev) => prev === "media" ? null : "media");
  }, []);

  // Build media props based on category
  const mediaType: MediaType = category === "document" ? "image" : category; // documents don't get media player
  const buildMediaProps = () => {
    const originalUrl = api.getOriginalFileUrl(kbId, doc.id);
    switch (category) {
      case "image":
        return {
          mediaType: "image" as MediaType,
          imageProps: {
            thumbnailUrl: api.getThumbnailUrl(kbId, doc.id),
            originalUrl,
          } as ImagePreviewProps,
        };
      case "audio":
        return {
          mediaType: "audio" as MediaType,
          audioProps: {
            src: originalUrl,
            duration: 0, // will be updated from metadata
            speakers: [],
            turns: [],
          } as AudioPlayerProps,
        };
      case "video":
        return {
          mediaType: "video" as MediaType,
          videoProps: {
            src: originalUrl,
            duration: 0,
            scenes: [],
            transcript: { speakers: [], turns: [] },
            frameUrls: [],
          } as VideoPlayerProps,
        };
      default:
        return null;
    }
  };

  const isProcessing = !!processing;
  const hasError = doc.status === "error" || !!processing?.error;
  const isReady = doc.status === "ready" && !isProcessing;

  return (
    <div style={{
      border: `1px solid ${selected ? "var(--interactive)" : hasError ? "var(--error)" : "var(--border-primary)"}`,
      borderRadius: "var(--radius-lg)",
      backgroundColor: selected ? "var(--interactive-light)" : hasError ? "var(--error-light)" : "var(--bg-tertiary)",
      overflow: "hidden",
    }}>
      {/* Card header */}
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-3)",
        padding: "var(--space-3) var(--space-4)",
      }}>
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          style={{ cursor: "pointer", accentColor: "var(--interactive)", flexShrink: 0 }}
        />
        <FileIcon size={18} style={{ flexShrink: 0, color: "var(--text-tertiary)" }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: "var(--text-sm)", color: "var(--text-primary)", margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {doc.filename}
          </p>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginTop: "var(--space-1)" }}>
            <span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>{doc.fileType}</span>
            <span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>{(doc.fileSize / 1024).toFixed(1)} KB</span>
          </div>
        </div>

        {/* Status */}
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-1)", fontSize: "var(--text-xs)", fontWeight: "var(--font-medium)", flexShrink: 0, color: isProcessing ? "var(--warning)" : hasError ? "var(--error)" : isReady ? "var(--success)" : "var(--text-tertiary)" }}>
          {isProcessing ? <Loader2 size={14} className="animate-spin" /> : hasError ? <AlertCircle size={14} /> : isReady ? <CheckCircle size={14} /> : <Clock size={14} />}
          {isProcessing ? (processing?.step ?? "处理中") : hasError ? "失败" : isReady ? "就绪" : "排队中"}
        </div>

        {/* Delete */}
        <button
          onClick={onDelete}
          title="删除文档"
          style={{ padding: "var(--space-1)", border: "none", borderRadius: "var(--radius-sm)", cursor: "pointer", color: "var(--text-tertiary)", backgroundColor: "transparent", flexShrink: 0 }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--error)"; e.currentTarget.style.backgroundColor = "var(--error-light)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-tertiary)"; e.currentTarget.style.backgroundColor = "transparent"; }}
        >
          <Trash2 size={14} />
        </button>
      </div>

      {/* Processing progress bar */}
      {isProcessing && (
        <div style={{ padding: "0 var(--space-4)", display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
          <div style={{ flex: 1, height: 4, backgroundColor: "var(--border-primary)", borderRadius: 2 }}>
            <div style={{ width: `${processing?.progress ?? 0}%`, height: "100%", backgroundColor: "var(--interactive)", borderRadius: 2, transition: "width 0.3s" }} />
          </div>
          <span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)", flexShrink: 0 }}>
            {processing?.progress ?? 0}%
          </span>
        </div>
      )}

      {/* Error message */}
      {hasError && processing?.error && (
        <div style={{ padding: "var(--space-1) var(--space-4)", display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
          <span style={{ fontSize: "var(--text-xs)", color: "var(--error)" }}>{processing.error}</span>
          {onRetry && (
            <button onClick={onRetry} style={{ fontSize: "var(--text-xs)", color: "var(--interactive)", background: "none", border: "1px solid var(--interactive)", borderRadius: "var(--radius-sm)", padding: "0 var(--space-2)", cursor: "pointer" }}>
              重试
            </button>
          )}
        </div>
      )}

      {/* Level buttons + Media button row (only when ready) */}
      {isReady && (
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", padding: "var(--space-2) var(--space-4)", borderTop: "1px solid var(--border-primary)" }}>
          {/* Media preview toggle */}
          {category !== "document" && (
            <button
              onClick={toggleMedia}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-1)",
                padding: "var(--space-1) var(--space-2)",
                border: `1px solid ${expandedLevel === "media" ? "var(--interactive)" : "var(--border-primary)"}`,
                borderRadius: "var(--radius-sm)",
                backgroundColor: expandedLevel === "media" ? "var(--interactive-light)" : "transparent",
                color: expandedLevel === "media" ? "var(--interactive)" : "var(--text-secondary)",
                fontSize: "var(--text-xs)",
                cursor: "pointer",
                marginRight: "var(--space-2)",
              }}
            >
              {expandedLevel === "media" ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              {category === "image" ? "缩略图" : category === "audio" ? "播放录音" : "播放视频"}
            </button>
          )}

          {/* L0/L1/L2 buttons */}
          {(["L0", "L1", "L2"] as const).map((level) => {
            const ready = levels[level];
            const isExpanded = expandedLevel === level;
            return (
              <button
                key={level}
                onClick={() => ready && toggleLevel(level)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-1)",
                  padding: "var(--space-1) var(--space-2)",
                  border: `1px solid ${isExpanded ? "var(--interactive)" : ready ? "var(--success)" : "var(--border-primary)"}`,
                  borderRadius: "var(--radius-sm)",
                  backgroundColor: isExpanded ? "var(--interactive-light)" : "transparent",
                  color: isExpanded ? "var(--interactive)" : ready ? "var(--success)" : "var(--text-tertiary)",
                  fontSize: "var(--text-xs)",
                  cursor: ready ? "pointer" : "default",
                  opacity: ready ? 1 : 0.5,
                }}
              >
                {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                {level} {ready && "●"}
              </button>
            );
          })}
        </div>
      )}

      {/* Expanded content area */}
      {expandedLevel && (
        <div style={{
          padding: "var(--space-3) var(--space-4)",
          borderTop: "1px solid var(--border-primary)",
          backgroundColor: "var(--bg-secondary)",
        }}>
          {expandedLevel === "media" ? (
            (() => {
              const mp = buildMediaProps();
              return mp ? <MediaPlayer {...mp} /> : null;
            })()
          ) : loadingLevel === expandedLevel ? (
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", color: "var(--text-tertiary)", fontSize: "var(--text-sm)" }}>
              <Loader2 size={14} className="animate-spin" /> 加载中...
            </div>
          ) : (
            <div style={{
              fontSize: "var(--text-sm)",
              color: "var(--text-primary)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              maxHeight: 300,
              overflowY: "auto",
            }}>
              {levelContent[expandedLevel] ?? ""}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/knowledge/DocumentCard.tsx
git commit -m "feat(knowledge): add unified DocumentCard with L0/L1/L2 buttons and media preview"
```

---

### Task 9: KnowledgePanel Rewrite — Unified Layout

**Files:**
- Modify: `frontend/src/components/knowledge/KnowledgePanel.tsx`

Major rewrite: remove the 7-tab system, replace with a single-page layout that integrates documents, wiki search, entity navigation, and the new DocumentCard component.

- [ ] **Step 1: Rewrite KnowledgePanel**

The new structure:
1. **Header row**: KB selector dropdown + "新建KB" button
2. **Search row**: `<KnowledgeSearchBar>` integrated into the page
3. **Action row**: Upload buttons (file + folder) + batch operations
4. **Content area**: Document list using `<DocumentCard>` components (replaces the old inline rendering)

When search is active, the document list is replaced by search results. Clearing search restores the document list.

Key changes from the old KnowledgePanel:
- Remove all 7 tabs (documents, wiki, entities, graph, search, teams, settings)
- Remove `TabId` type and `tabs` array
- Remove `activeTab` state
- Keep: KB selector, document list, upload handling, batch operations
- Add: `<KnowledgeSearchBar>` for search
- Add: `<DocumentCard>` for each document (replaces inline card rendering)
- Keep entities and graph as separate pages (accessible via navigation, not tabs)
- Keep settings as a collapsible section at the bottom
- Add search results state that replaces document list when searching

The component retains:
- `kbId` from URL params / UI store
- `knowledgeBases`, `documents`, `entities` state
- `uploads`, `selectedDocs` state
- All upload, delete, retry handlers
- `useDocProcessing` hook (now with `levelReadiness`)
- KB create modal

New state added:
- `searchQuery: string` — current search query
- `searchResults: SearchResult[]` — results from search
- `searching: boolean` — search in progress

When `searchQuery` is non-empty, render search results instead of the document list. When empty, render the document list with DocumentCards.

The rendering flow becomes:

```
if (!kbId) → KB selector + create modal
else:
  Header: KB selector + new KB button
  Search: <KnowledgeSearchBar onSearch={handleSearch} />
  Actions: upload buttons + batch ops + trigger processing
  Content:
    if searchQuery → search results list
    else → uploads + documents list with <DocumentCard>
  Footer: KB settings (collapsible)
```

**Implementation approach:** Rather than rewriting from scratch, modify the existing file. The key surgical changes are:
1. Remove lines 43 (TabId type) and 432-440 (tabs array)
2. Remove activeTab state (line 132)
3. Remove all tab rendering branches (lines 600-1659), replace with unified layout
4. Import and use DocumentCard, KnowledgeSearchBar
5. Add search state and handler
6. Keep entities/graph as overlay pages (navigated to from entity links)
7. Keep settings as collapsible section at bottom

This is a large change but follows the established pattern of the existing component. The file will be significantly shorter since we remove the tab switching logic and inline document card rendering.

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/knowledge/KnowledgePanel.tsx
git commit -m "refactor(knowledge): rewrite KnowledgePanel as unified page with integrated search and DocumentCards"
```

---

### Task 10: Chat File Upload — MessageInput Wiring

**Files:**
- Modify: `frontend/src/components/chat/MessageInput.tsx`

The spec requires chat file upload to work end-to-end: files are uploaded to a temp KB, and the analysis scope is updated.

- [ ] **Step 1: Wire file upload in MessageInput**

Currently `handleSend` only sends text. Modify it to check for pending file uploads:

1. Import `api` and `useUIStore`
2. When `hasPending` (pending uploads exist) and the user sends a message:
   - Check if current session has an associated KB (via `sessionMetadata`)
   - If no KB: create a temp KB named `session-{sessionId}` (or reuse if exists)
   - Upload files to that KB
   - Update analysis scope to include that KB
   - Send the message with the KB context

The implementation modifies the `handleSend` function:

```typescript
const handleSend = useCallback(async () => {
  if (!canSend) return;
  const content = text.trim();
  setText("");

  // Handle pending file uploads
  if (hasPending && currentSessionId) {
    try {
      // Find or create a KB for this session
      const kbs = await api.listKnowledgeBases();
      let kbId = kbs.find((kb) => kb.name === `session-${currentSessionId}`)?.id;
      if (!kbId) {
        const newKb = await api.createKnowledgeBase(`session-${currentSessionId}`);
        kbId = newKb.id;
      }

      // Upload pending files
      for (const upload of uploads) {
        if (upload.file) {
          await api.uploadDocument(kbId, upload.file);
        }
      }

      // Clear uploads after successful upload
      uploads.forEach((u) => removeUpload(u.id));
    } catch (err) {
      console.error("File upload failed:", err);
    }
  }

  sendMessage(content);
  textareaRef.current?.focus();
}, [canSend, text, sendMessage, hasPending, uploads, removeUpload, currentSessionId]);
```

Also update the DropZone/file picker to accept all file types:
- Change `accept` to include all supported types: `.pdf,.doc,.docx,.txt,.md,.csv,.xlsx,.pptx,.html,.htm,.png,.jpg,.jpeg,.gif,.bmp,.webp,.svg,.mp3,.wav,.flac,.aac,.ogg,.m4a,.mp4,.avi,.mov,.mkv,.webm`

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/chat/MessageInput.tsx
git commit -m "feat(chat): wire file upload to auto-create session knowledge base"
```

---

### Task 11: Integration Verification

**Files:**
- Modify: Various (fix any import/type errors)

- [ ] **Step 1: TypeScript compile check**

Run the TypeScript compiler to check for type errors:

```bash
cd frontend && npx tsc --noEmit 2>&1 | head -50
```

Fix any errors found. Common issues to expect:
- `DocumentInfo` may not have all fields expected by `DocumentCard` (check the type in `types/index.ts`)
- `expandWiki` return type may not match what DocumentCard expects
- Import path issues for new components
- Missing `animate-spin` CSS class (may need to add to global styles)

- [ ] **Step 2: Verify all imports resolve**

Check that all new components are importable and referenced correctly:
- `KnowledgePanel` imports `DocumentCard`, `KnowledgeSearchBar`
- `MediaPlayer` imports `ImagePreview`, `AudioPlayer`, `VideoPlayer`
- `DocumentCard` imports `MediaPlayer`, api client

- [ ] **Step 3: Commit fixes**

```bash
git add -A
git commit -m "fix: resolve integration errors in knowledge UI components"
```

---

## Summary

| Task | Component | Description |
|------|-----------|-------------|
| 1 | API Client | Media file URL helpers |
| 2 | useDocProcessing | L0/L1/L2 level readiness tracking |
| 3 | KnowledgeSearchBar | Unified search with mode/topK/level controls |
| 4 | ImagePreview | Image thumbnail, EXIF, fullscreen viewer |
| 5 | AudioPlayer | HTML5 audio with transcript sync + speaker labels |
| 6 | VideoPlayer | HTML5 video with scene sync + frame timeline |
| 7 | MediaPlayer | Wrapper for auto-detecting media type |
| 8 | DocumentCard | Type-aware card with L0/L1/L2 buttons + media preview |
| 9 | KnowledgePanel | Unified rewrite (remove tabs, add search, use DocumentCards) |
| 10 | MessageInput | Wire chat file upload to temp knowledge base |
| 11 | Integration | TypeScript compile check + import verification |
