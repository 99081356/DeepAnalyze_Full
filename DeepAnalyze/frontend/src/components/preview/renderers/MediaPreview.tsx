interface MediaPreviewProps {
  mediaUrl: string;
  previewType: "audio" | "video";
}

export function MediaPreview({ mediaUrl, previewType }: MediaPreviewProps) {
  if (previewType === "audio") {
    return (
      <div style={{ padding: "var(--space-3)" }}>
        <audio controls src={mediaUrl} style={{ width: "100%" }}>
          Your browser does not support audio playback.
        </audio>
      </div>
    );
  }

  return (
    <div style={{ padding: "var(--space-3)", textAlign: "center" }}>
      <video
        controls
        src={mediaUrl}
        style={{
          maxWidth: "100%",
          maxHeight: 400,
          borderRadius: "var(--radius-md)",
        }}
      >
        Your browser does not support video playback.
      </video>
    </div>
  );
}
