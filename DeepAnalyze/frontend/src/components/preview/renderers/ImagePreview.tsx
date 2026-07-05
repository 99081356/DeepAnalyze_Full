interface ImagePreviewProps {
  imageUrl: string;
  imageCaption?: string;
}

export function ImagePreview({ imageUrl, imageCaption }: ImagePreviewProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
      <img
        src={imageUrl}
        alt={imageCaption || "Evidence image"}
        loading="lazy"
        style={{
          maxWidth: "100%",
          maxHeight: 400,
          objectFit: "contain",
          borderRadius: "var(--radius-md)",
          border: "1px solid var(--border-primary)",
        }}
        onError={(e) => {
          (e.target as HTMLImageElement).style.display = "none";
          const parent = (e.target as HTMLImageElement).parentElement;
          if (parent) {
            const errorDiv = document.createElement("p");
            errorDiv.style.color = "var(--error)";
            errorDiv.style.fontSize = "var(--text-sm)";
            errorDiv.textContent = "Image failed to load";
            parent.appendChild(errorDiv);
          }
        }}
      />
      {imageCaption && (
        <p style={{
          fontSize: "var(--text-xs)",
          color: "var(--text-secondary)",
          textAlign: "center",
          margin: 0,
        }}>
          {imageCaption}
        </p>
      )}
    </div>
  );
}
