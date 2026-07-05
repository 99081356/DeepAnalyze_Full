import type { ImageRawData, AudioRawData, VideoRawData } from "./modality-types.js";

export interface ParsedContent {
  text: string;
  metadata: Record<string, unknown>;
  success: boolean;
  error?: string;
  /** Raw structured data from processor (modality-specific). */
  raw?: Record<string, unknown> | ImageRawData | AudioRawData | VideoRawData;
  /** DocTags text representation from Docling. */
  doctags?: string;
  /** Markdown text representation (for L1_md pages). */
  markdown?: string;
  /** Document modality type. */
  modality?: 'document' | 'image' | 'audio' | 'video' | 'excel';
  /** Extracted tables (e.g. from Docling), each as structured data string (CSV/HTML). */
  tables?: Array<{ data: string; page: number | null }>;
}

export interface DocumentProcessor {
  canHandle(fileType: string): boolean;
  parse(filePath: string, options?: Record<string, unknown>): Promise<ParsedContent>;
  getStepLabel(): string;
}
