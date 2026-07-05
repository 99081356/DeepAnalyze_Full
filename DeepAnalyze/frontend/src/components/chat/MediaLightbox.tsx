import { useState, useEffect } from "react";
import type { MediaAttachment } from "../../types/index.js";

interface MediaLightboxProps {
  media: MediaAttachment[];
  sessionId: string;
  initialIndex: number;
  onClose: () => void;
}

export function MediaLightbox({ media, sessionId, initialIndex, onClose }: MediaLightboxProps) {
  const [index, setIndex] = useState(initialIndex);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft" && index > 0) setIndex(index - 1);
      if (e.key === "ArrowRight" && index < media.length - 1) setIndex(index + 1);
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [index, media.length, onClose]);

  const item = media[index];
  if (!item) return null;

  const originalUrl = `/api/sessions/${sessionId}/media/${item.mediaId}?type=original`;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center"
      onClick={onClose}
    >
      <div className="relative max-w-[90vw] max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={onClose}
          className="absolute -top-10 right-0 text-white text-2xl hover:text-gray-300"
        >
          ×
        </button>

        {item.mimeType.startsWith("image/") ? (
          <img
            src={originalUrl}
            alt={item.fileName}
            className="max-w-full max-h-[85vh] object-contain"
          />
        ) : item.mimeType.startsWith("video/") ? (
          <video
            src={originalUrl}
            controls
            autoPlay
            className="max-w-full max-h-[85vh]"
          />
        ) : null}

        {media.length > 1 && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-2 items-center">
            <button
              onClick={() => setIndex(Math.max(0, index - 1))}
              disabled={index === 0}
              className="px-3 py-1 bg-white/20 text-white rounded disabled:opacity-30"
            >
              ←
            </button>
            <span className="text-white text-sm">{index + 1} / {media.length}</span>
            <button
              onClick={() => setIndex(Math.min(media.length - 1, index + 1))}
              disabled={index === media.length - 1}
              className="px-3 py-1 bg-white/20 text-white rounded disabled:opacity-30"
            >
              →
            </button>
          </div>
        )}

        <div className="absolute bottom-4 right-4 text-white/70 text-sm">
          {item.fileName}
        </div>
      </div>
    </div>
  );
}
