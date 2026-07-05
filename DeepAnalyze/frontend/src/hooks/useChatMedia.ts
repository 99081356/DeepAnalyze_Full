import { useState, useCallback } from "react";
import { api } from "../api/client.js";

export interface PendingMedia {
  id: string;
  file: File;
  previewUrl: string;
  status: "pending" | "uploading" | "done" | "error";
  mediaId?: string;
  error?: string;
}

let nextId = 0;

export function useChatMedia() {
  const [pendingMedia, setPendingMedia] = useState<PendingMedia[]>([]);

  const addFiles = useCallback((files: FileList | File[]) => {
    const newMedia: PendingMedia[] = Array.from(files).map((file) => ({
      id: `pending-${nextId++}`,
      file,
      previewUrl: URL.createObjectURL(file),
      status: "pending" as const,
    }));
    setPendingMedia((prev) => [...prev, ...newMedia]);
  }, []);

  const remove = useCallback((id: string) => {
    setPendingMedia((prev) => {
      const item = prev.find((m) => m.id === id);
      if (item) URL.revokeObjectURL(item.previewUrl);
      return prev.filter((m) => m.id !== id);
    });
  }, []);

  const uploadAll = useCallback(async (sessionId: string): Promise<string[]> => {
    const toUpload = pendingMedia.filter(
      (m) => m.status === "pending" || m.status === "error"
    );

    const uploadedIds: string[] = [];

    for (const media of toUpload) {
      setPendingMedia((prev) =>
        prev.map((m) =>
          m.id === media.id ? { ...m, status: "uploading" as const } : m
        )
      );
      try {
        const result = await api.uploadSessionMedia(sessionId, media.file);
        uploadedIds.push(result.mediaId);
        setPendingMedia((prev) =>
          prev.map((m) =>
            m.id === media.id
              ? { ...m, status: "done" as const, mediaId: result.mediaId }
              : m
          )
        );
      } catch (err) {
        setPendingMedia((prev) =>
          prev.map((m) =>
            m.id === media.id
              ? { ...m, status: "error" as const, error: String(err) }
              : m
          )
        );
      }
    }

    // Also include mediaIds of items that were already done before this call
    const previouslyDone = pendingMedia.filter(
      (m) => m.status === "done" && m.mediaId
    );
    return [...previouslyDone.map((m) => m.mediaId!), ...uploadedIds];
  }, [pendingMedia]);

  const clearDone = useCallback(() => {
    setPendingMedia((prev) => {
      const done = prev.filter((m) => m.status === "done");
      done.forEach((m) => URL.revokeObjectURL(m.previewUrl));
      return prev.filter((m) => m.status !== "done");
    });
  }, []);

  const clearAll = useCallback(() => {
    setPendingMedia((prev) => {
      prev.forEach((m) => URL.revokeObjectURL(m.previewUrl));
      return [];
    });
  }, []);

  const hasPending = pendingMedia.some(
    (m) => m.status === "pending" || m.status === "uploading"
  );

  return {
    pendingMedia,
    addFiles,
    remove,
    uploadAll,
    clearDone,
    clearAll,
    hasPending,
  };
}
