import { useState } from "react";
import type { MediaAttachment } from "../../types/index.js";
import { MediaLightbox } from "./MediaLightbox.js";

interface MediaPreviewProps {
  media: MediaAttachment[];
  sessionId: string;
}

export function MediaPreview({ media, sessionId }: MediaPreviewProps) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  if (!media || media.length === 0) return null;

  return (
    <>
      <div className="flex flex-wrap gap-2 mt-2">
        {media.map((item, index) => {
          const thumbnailUrl = `/api/sessions/${sessionId}/media/${item.mediaId}?type=thumbnail`;
          const originalUrl = `/api/sessions/${sessionId}/media/${item.mediaId}?type=original`;

          if (item.mimeType.startsWith("image/")) {
            return (
              <img
                key={item.mediaId}
                src={thumbnailUrl}
                alt={item.fileName}
                className="max-w-[200px] max-h-[150px] object-cover rounded cursor-pointer hover:opacity-80 transition-opacity border border-border"
                onClick={() => setLightboxIndex(index)}
                loading="lazy"
              />
            );
          }

          if (item.mimeType.startsWith("video/")) {
            return (
              <video
                key={item.mediaId}
                src={originalUrl}
                controls
                className="max-w-[300px] max-h-[200px] rounded border border-border"
                preload="metadata"
              />
            );
          }

          if (item.mimeType.startsWith("audio/")) {
            return (
              <audio
                key={item.mediaId}
                src={originalUrl}
                controls
                className="max-w-[300px] rounded"
              />
            );
          }

          // Non-media file: render as downloadable file card
          const ext = item.fileName.includes(".") ? item.fileName.split(".").pop()!.toUpperCase() : "FILE";
          return (
            <a
              key={item.mediaId}
              href={originalUrl}
              download={item.fileName}
              className="flex items-center gap-2 px-3 py-2 rounded border border-border bg-muted text-sm no-underline text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
            >
              <span className="px-1.5 py-0.5 bg-[var(--bg-tertiary)] rounded text-[10px] font-medium text-[var(--text-tertiary)]">
                {ext}
              </span>
              <span className="max-w-[150px] truncate">{item.fileName}</span>
            </a>
          );
        })}
      </div>

      {lightboxIndex !== null && (
        <MediaLightbox
          media={media}
          sessionId={sessionId}
          initialIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </>
  );
}
