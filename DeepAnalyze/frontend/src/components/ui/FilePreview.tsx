import { X, FileText, Image, FileSpreadsheet, File as FileIcon } from "lucide-react";

interface FilePreviewProps {
  filename: string;
  fileType: string;
  fileSize: number;
  onRemove?: () => void;
}

function getFileIcon(filename: string) {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return Image;
  if (["xlsx", "xls", "csv"].includes(ext)) return FileSpreadsheet;
  if (["pdf", "doc", "docx", "md", "txt"].includes(ext)) return FileText;
  return FileIcon;
}

function formatSize(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function FilePreview({ filename, fileSize, onRemove }: FilePreviewProps) {
  const Icon = getFileIcon(filename);
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-2)",
        padding: "4px 8px 4px 6px",
        background: "var(--bg-tertiary)",
        borderRadius: "var(--radius-md)",
        fontSize: "var(--text-xs)",
        color: "var(--text-secondary)",
        maxWidth: 220,
      }}
    >
      <Icon size={14} style={{ flexShrink: 0, color: "var(--text-tertiary)" }} />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
        {filename}
      </span>
      <span style={{ flexShrink: 0, color: "var(--text-tertiary)" }}>
        {formatSize(fileSize)}
      </span>
      {onRemove && (
        <button
          onClick={onRemove}
          style={{
            display: "flex",
            padding: 0,
            border: "none",
            background: "transparent",
            color: "var(--text-tertiary)",
            cursor: "pointer",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--error)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-tertiary)"; }}
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}
