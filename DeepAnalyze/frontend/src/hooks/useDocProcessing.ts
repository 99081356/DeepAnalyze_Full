// =============================================================================
// DeepAnalyze - Document Processing Status Hook
// Tracks real-time processing status for documents in a knowledge base.
// Uses the knowledge WebSocket hook to receive updates.
// =============================================================================

import { useState, useEffect, useCallback, useRef } from "react";
import { useWebSocket } from "./useWebSocket";
import type { WsServerMessage } from "./useWebSocket";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProcessingState {
  /** Current processing step label (e.g. "parsing", "compiling"). */
  step: string;
  /** Progress percentage 0-100. */
  progress: number;
  /** Error message if processing failed. */
  error?: string;
  /** Optional finer-grained sub-step within the current step
   *  (e.g. "raw_save", "structure", "abstract", "fulltext" inside "compiling"). */
  subStep?: string;
  /** Optional display message that overrides the subStep label (e.g. retry
   *  counters like "生成摘要中（尝试 1/3）"). Falls back to subStep label. */
  message?: string;
}

export interface LevelReadiness {
  L0: boolean;
  L1: boolean;
  L2: boolean;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

interface UseDocProcessingReturn {
  /** Map of docId -> current processing state for docs being processed. */
  processingDocs: Map<string, ProcessingState>;
  /** Map of docId -> per-level readiness (L0/L1/L2) for compiled documents. */
  levelReadiness: Map<string, LevelReadiness>;
  /** Whether the WebSocket connection is alive. */
  wsConnected: boolean;
}

/**
 * @param kbId Knowledge base ID to subscribe to
 * @param onDocComplete Called when a document finishes (doc_ready) or errors (doc_error).
 *                      Used to trigger a refetch of the document list.
 * @param onUploadComplete Called with docId when a document finishes or errors.
 *                         Used to clean up the uploads tracking array.
 */
export function useDocProcessing(
  kbId: string | null,
  onDocComplete?: () => void,
  onUploadComplete?: (docId: string) => void,
): UseDocProcessingReturn {
  const [processingDocs, setProcessingDocs] = useState<Map<string, ProcessingState>>(
    () => new Map(),
  );
  const [levelReadiness, setLevelReadiness] = useState<Map<string, LevelReadiness>>(
    () => new Map(),
  );
  const kbIdRef = useRef(kbId);
  kbIdRef.current = kbId;
  const onDocCompleteRef = useRef(onDocComplete);
  onDocCompleteRef.current = onDocComplete;
  const onUploadCompleteRef = useRef(onUploadComplete);
  onUploadCompleteRef.current = onUploadComplete;

  const handleMessage = useCallback((msg: WsServerMessage) => {
    // Only process messages for our KB
    if (!kbIdRef.current) return;
    if ("kbId" in msg && msg.kbId !== kbIdRef.current) return;

    switch (msg.type) {
      case "doc_upload_progress": {
        setProcessingDocs((prev) => {
          const next = new Map(prev);
          const existing = next.get(msg.docId);
          next.set(msg.docId, {
            step: existing?.step ?? "uploading",
            progress: msg.progress,
            error: existing?.error,
          });
          return next;
        });
        break;
      }

      case "doc_processing_step": {
        setProcessingDocs((prev) => {
          const next = new Map(prev);
          const existing = next.get(msg.docId);
          next.set(msg.docId, {
            step: msg.step,
            progress: msg.progress,
            error: existing?.error,
            subStep: msg.subStep,
            message: msg.message,
          });
          return next;
        });
        break;
      }

      case "doc_error": {
        setProcessingDocs((prev) => {
          const next = new Map(prev);
          const existing = next.get(msg.docId);
          next.set(msg.docId, {
            step: existing?.step ?? "error",
            progress: existing?.progress ?? 0,
            error: msg.error,
          });
          return next;
        });
        onDocCompleteRef.current?.();
        if ("docId" in msg && typeof msg.docId === "string") {
          onUploadCompleteRef.current?.(msg.docId);
        }
        break;
      }

      case "doc_ready": {
        setProcessingDocs((prev) => {
          const next = new Map(prev);
          next.delete(msg.docId);
          return next;
        });
        // Mark all levels as ready when document processing completes
        setLevelReadiness((prev) => {
          const next = new Map(prev);
          if ("docId" in msg && typeof msg.docId === "string") {
            next.set(msg.docId, { L0: true, L1: true, L2: true });
          }
          return next;
        });
        onDocCompleteRef.current?.();
        if ("docId" in msg && typeof msg.docId === "string") {
          onUploadCompleteRef.current?.(msg.docId);
        }
        break;
      }

      case "doc_level_ready": {
        const { docId, level } = msg as { docId: string; level: "L0" | "L1" | "L2" };
        setLevelReadiness((prev) => {
          const next = new Map(prev);
          const existing = next.get(docId) ?? { L0: false, L1: false, L2: false };
          next.set(docId, { ...existing, [level]: true });
          return next;
        });
        break;
      }
    }
  }, []);

  const { connected, subscribe, unsubscribe } = useWebSocket({
    onMessage: handleMessage,
  });

  // Subscribe to the KB when it changes or when connection is established
  useEffect(() => {
    if (!kbId) return;

    subscribe([kbId]);

    return () => {
      unsubscribe([kbId]);
      // Clear processing state when switching KB
      setProcessingDocs(new Map());
      setLevelReadiness(new Map());
    };
  }, [kbId, subscribe, unsubscribe]);

  return { processingDocs, levelReadiness, wsConnected: connected };
}
