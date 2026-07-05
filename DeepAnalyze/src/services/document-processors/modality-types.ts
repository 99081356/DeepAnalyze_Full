// =============================================================================
// DeepAnalyze - Modality Raw Data Types & DocTags Formatters
// Defines structured data interfaces for each modality and utilities
// for generating DocTags format text used in Structure layer compilation.
// =============================================================================

// ---------------------------------------------------------------------------
// Raw data interfaces per modality
// ---------------------------------------------------------------------------

/** Image raw data from VLM description + OCR extraction. */
export interface ImageRawData {
  description: string;
  ocrText?: string;
  width?: number;
  height?: number;
  format?: string;
  exif?: {
    make?: string;
    model?: string;
    dateTime?: string;
    gps?: { lat: number; lng: number };
    orientation?: number;
    iso?: number;
    exposureTime?: string;
    focalLength?: string;
  };
  thumbnailPath?: string;
}

/** A single speaker turn in audio transcription. */
export interface SpeakerTurn {
  speaker: string;
  startTime: number;
  endTime: number;
  text: string;
}

/** Audio raw data from ASR transcription with speaker diarization. */
export interface AudioRawData {
  duration: number;
  language?: string;
  sampleRate?: number;
  channels?: number;
  speakers: Array<{
    id: string;
    label: string;
    totalDuration?: number;
  }>;
  turns: SpeakerTurn[];
  diarizationMethod?: 'api' | 'silence' | 'none';
}

/** A video keyframe with timestamp and visual description. */
export interface VideoKeyframe {
  time: number;
  description: string;
}

/** A video scene with time range and description from video understanding model. */
export interface VideoScene {
  index: number;
  startTime: number;
  endTime: number;
  description: string;
  keyEvents?: string[];
  textOnScreen?: string;
  sceneTransition?: boolean;
  thumbnailPath?: string;
}

/** Video raw data combining scene analysis and audio transcript. */
export interface VideoRawData {
  duration: number;
  resolution?: string;
  fps?: number;
  codec?: string;
  /** Video understanding model output (primary path) */
  scenes?: VideoScene[];
  /** Legacy keyframe path (fallback) */
  keyframes: VideoKeyframe[];
  /** Audio track transcript */
  transcript: AudioRawData;
  /** Method used for video understanding */
  videoUnderstandingMethod?: 'vlm_video' | 'vlm_frames';
}

/** Excel sheet table summary for structured metadata. */
export interface ExcelTableSummary {
  sheetName: string;
  tableIndex: number;
  headers: string[];
  rowCount: number;
  colCount: number;
}

// ---------------------------------------------------------------------------
// DocTags formatters
// ---------------------------------------------------------------------------

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export const DocTagsFormatters = {
  /** Format image raw data as DocTags. */
  image(raw: ImageRawData): string {
    const parts: string[] = [];
    const sizeInfo = raw.width && raw.height ? `(size=${raw.width}x${raw.height}` + (raw.format ? `;format=${raw.format}` : '') + ')' : '';
    parts.push(`[img]${sizeInfo ? ' ' + sizeInfo : ''} 视觉描述: ${raw.description}`);
    if (raw.ocrText) {
      parts.push(`[ocr] 文本内容: ${raw.ocrText}`);
    }
    if (raw.exif) {
      const metaParts: string[] = [];
      if (raw.exif.dateTime) metaParts.push(`拍摄时间: ${raw.exif.dateTime}`);
      if (raw.exif.make && raw.exif.model) metaParts.push(`相机: ${raw.exif.make} ${raw.exif.model}`);
      if (raw.exif.gps) metaParts.push(`GPS: ${raw.exif.gps.lat},${raw.exif.gps.lng}`);
      if (metaParts.length > 0) {
        parts.push(`[meta] ${metaParts.join(', ')}`);
      }
    }
    return parts.join('\n');
  },

  /** Format a single audio speaker turn as DocTags. */
  audioTurn(turn: SpeakerTurn): string {
    const timeStr = `${formatTime(turn.startTime)}-${formatTime(turn.endTime)}`;
    return `[p](speaker=${turn.speaker};time=${timeStr}) ${turn.text}`;
  },

  /** Format a video scene with related dialog turns as DocTags. */
  videoScene(sceneOrKeyframe: VideoScene | VideoKeyframe, turns: SpeakerTurn[]): string {
    const parts: string[] = [];
    if ('index' in sceneOrKeyframe) {
      // VideoScene format
      const scene = sceneOrKeyframe;
      parts.push(`[scene](time=${formatTime(scene.startTime)}-${formatTime(scene.endTime)}) ${scene.description}`);
      if (scene.textOnScreen) {
        parts.push(`[text_on_screen] ${scene.textOnScreen}`);
      }
      if (scene.keyEvents && scene.keyEvents.length > 0) {
        parts.push(`[events] ${scene.keyEvents.join('; ')}`);
      }
    } else {
      // Legacy VideoKeyframe format
      parts.push(`[scene](time=${formatTime(sceneOrKeyframe.time)}) ${sceneOrKeyframe.description}`);
    }
    for (const turn of turns) {
      parts.push(`[dialog](speaker=${turn.speaker};time=${formatTime(turn.startTime)}) ${turn.text}`);
    }
    return parts.join('\n');
  },
};

/** Re-export formatTime for use in modality compilers. */
export { formatTime };
