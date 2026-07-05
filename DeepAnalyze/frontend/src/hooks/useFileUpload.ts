// =============================================================================
// DeepAnalyze - File Upload Hook & Utilities
// Manages file uploads with real XHR progress tracking, parallel uploads with
// concurrency limit, and folder selection support.
// =============================================================================

import { useState, useCallback } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UploadingFile {
  id: string;
  file: File;
  progress: number;
  status: "pending" | "uploading" | "done" | "error";
  error?: string;
  documentId?: string;
}

export interface UploadResult {
  documentId: string;
  filename: string;
}

// ---------------------------------------------------------------------------
// Low-level: upload a single file via XHR with real progress
// ---------------------------------------------------------------------------

function uploadSingleFile(
  kbId: string,
  file: File,
  onProgress: (pct: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const formData = new FormData();
    formData.append("file", file);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };

    xhr.onload = () => {
      if (xhr.status === 201) {
        try {
          const data = JSON.parse(xhr.responseText);
          resolve(data.id || data.documentId);
        } catch {
          reject(new Error(`Failed to parse upload response`));
        }
      } else {
        reject(new Error(`Upload failed: ${xhr.status}`));
      }
    };

    xhr.onerror = () => reject(new Error("Network error"));
    xhr.open("POST", `/api/knowledge/kbs/${kbId}/upload`);
    xhr.send(formData);
  });
}

// ---------------------------------------------------------------------------
// Concurrency-limited parallel runner
// ---------------------------------------------------------------------------

const MAX_CONCURRENCY = 3;

/**
 * Run an async task factory over items with a concurrency limit.
 * Returns results in the same order as the input items.
 */
async function parallelLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const idx = nextIndex++;
      results[idx] = await fn(items[idx], idx);
    }
  }

  const workers: Promise<void>[] = [];
  const count = Math.min(limit, items.length);
  for (let i = 0; i < count; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Standalone upload function (can be used outside the hook)
// ---------------------------------------------------------------------------

/**
 * Upload an array of files to a knowledge base with real progress tracking
 * per file. Uploads run in parallel with a concurrency limit of 3.
 * Returns an array of { documentId, filename } results.
 */
export async function uploadToKb(
  kbId: string,
  files: FileList | File[],
  onFileProgress?: (filename: string, pct: number) => void,
): Promise<UploadResult[]> {
  const fileArray = Array.from(files);

  return parallelLimit(fileArray, MAX_CONCURRENCY, async (file) => {
    const documentId = await uploadSingleFile(kbId, file, (pct) => {
      onFileProgress?.(file.name, pct);
    });
    return { documentId, filename: file.name };
  });
}

// ---------------------------------------------------------------------------
// Standalone file selection (no state management)
// ---------------------------------------------------------------------------

/**
 * Opens a native file picker dialog and returns the selected files,
 * or null if the user cancels. Unlike the hook's selectFiles, this does
 * NOT add files to any upload state.
 */
export function openFileDialog(
  accept?: string,
  multiple = true,
): Promise<FileList | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = multiple;
    if (accept) input.accept = accept;
    input.onchange = () => resolve(input.files);
    input.click();
  });
}

// ---------------------------------------------------------------------------
// Folder selection utility
// ---------------------------------------------------------------------------

/**
 * Opens a native folder picker dialog and returns the selected files
 * (including files in subdirectories), or null if the user cancels.
 */
export function selectFolder(): Promise<FileList | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    (input as any).webkitdirectory = true;
    input.onchange = () => resolve(input.files);
    input.click();
  });
}

// ---------------------------------------------------------------------------
// Hook: useFileUpload
// Preserves the existing interface used by KnowledgePanel.
// ---------------------------------------------------------------------------

/**
 * Hook to manage file uploads with real XHR progress tracking.
 *
 * Returns the same interface as the previous version so that KnowledgePanel
 * and other consumers continue to work without changes.
 */
export function useFileUpload() {
  const [uploads, setUploads] = useState<UploadingFile[]>([]);

  const addFiles = useCallback((files: FileList | File[]) => {
    const newUploads: UploadingFile[] = Array.from(files).map((file) => ({
      id: `upload-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      file,
      progress: 0,
      status: "pending" as const,
    }));
    setUploads((prev) => [...prev, ...newUploads]);
    return newUploads;
  }, []);

  const updateUpload = useCallback((id: string, patch: Partial<UploadingFile>) => {
    setUploads((prev) =>
      prev.map((u) => (u.id === id ? { ...u, ...patch } : u)),
    );
  }, []);

  const removeUpload = useCallback((id: string) => {
    setUploads((prev) => prev.filter((u) => u.id !== id));
  }, []);

  const uploadToKbFromHook = useCallback(
    async (kbId: string, fileIds?: string[]) => {
      // Read current uploads via functional updater to avoid stale closure
      let targets: UploadingFile[] = [];
      setUploads((prev) => {
        targets = prev.filter(
          (u) =>
            (fileIds ? fileIds.includes(u.id) : u.status === "pending") &&
            u.status !== "done",
        );
        return prev; // Don't mutate, just read
      });

      if (targets.length === 0) return [];

      // Upload all target files with concurrency limit, tracking per-file progress
      const results = await parallelLimit(targets, MAX_CONCURRENCY, async (target) => {
        updateUpload(target.id, { status: "uploading", progress: 0 });
        try {
          const documentId = await uploadSingleFile(kbId, target.file, (pct) => {
            updateUpload(target.id, { progress: pct });
          });
          updateUpload(target.id, {
            status: "done",
            progress: 100,
            documentId,
          });
          return documentId;
        } catch (err) {
          updateUpload(target.id, {
            status: "error",
            error: String(err),
          });
          return null;
        }
      });

      // Filter out failed uploads
      return results.filter((id): id is string => id !== null);
    },
    [updateUpload],
  );

  const clearDone = useCallback(() => {
    setUploads((prev) => prev.filter((u) => u.status !== "done"));
  }, []);

  const selectFiles = useCallback(
    (accept?: string, multiple = true) => {
      return new Promise<FileList | null>((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.multiple = multiple;
        if (accept) input.accept = accept;
        input.onchange = () => {
          const files = input.files;
          if (files && files.length > 0) {
            addFiles(files);
            resolve(files);
          } else {
            resolve(null);
          }
        };
        input.click();
      });
    },
    [addFiles],
  );

  return {
    uploads,
    addFiles,
    selectFiles,
    uploadToKb: uploadToKbFromHook,
    removeUpload,
    clearDone,
    hasPending: uploads.some((u) => u.status === "pending" || u.status === "uploading"),
  };
}
