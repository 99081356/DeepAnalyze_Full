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
  const [loadError, setLoadError] = useState(false);

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
          {loadError ? (
            <div style={{
              width: 120,
              height: 90,
              borderRadius: "var(--radius-md)",
              border: "1px solid var(--border-primary)",
              backgroundColor: "var(--bg-tertiary)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--text-tertiary)",
              fontSize: "var(--text-xs)",
            }}>
              加载失败
            </div>
          ) : (
          <img
            src={thumbnailUrl}
            alt="thumbnail"
            onError={() => setLoadError(true)}
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
          )}
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
