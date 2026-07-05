import { useState } from "react";
import { FileDown, FileText, FileCode, X, Loader2 } from "lucide-react";
import { useToast } from "../../hooks/useToast";

interface ReportExportProps {
  reportId: string;
  reportTitle: string;
  onClose: () => void;
}

type ExportFormat = "markdown" | "pdf" | "html";

export function ReportExport({ reportId, reportTitle, onClose }: ReportExportProps) {
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const { success, error: toastError } = useToast();

  const formats: { key: ExportFormat; label: string; icon: React.ReactNode; ext: string }[] = [
    { key: "markdown", label: "Markdown", icon: <FileCode size={16} />, ext: "md" },
    { key: "html", label: "HTML", icon: <FileText size={16} />, ext: "html" },
    { key: "pdf", label: "PDF", icon: <FileDown size={16} />, ext: "pdf" },
  ];

  const handleExport = async (format: ExportFormat, ext: string) => {
    setExporting(format);
    try {
      const resp = await fetch(`/api/reports/reports/${reportId}/export?format=${format}`);
      if (!resp.ok) throw new Error("导出失败");
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${reportTitle}.${ext}`;
      a.click();
      URL.revokeObjectURL(url);
      success("报告导出成功");
      onClose();
    } catch (err) {
      toastError("导出失败: " + String(err));
    } finally {
      setExporting(null);
    }
  };

  return (
    <div
      style={{ position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.3)", zIndex: "var(--z-modal)" }}
      onClick={onClose}
    >
      <div
        style={{ background: "var(--bg-primary)", borderRadius: "var(--radius-xl)", boxShadow: "var(--shadow-2xl)", padding: "var(--space-6)", minWidth: 320 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--space-4)" }}>
          <h3 style={{ fontSize: "var(--text-base)", fontWeight: 600, color: "var(--text-primary)", margin: 0 }}>
            导出报告
          </h3>
          <button onClick={onClose} style={{ display: "flex", padding: 4, border: "none", background: "transparent", color: "var(--text-tertiary)", cursor: "pointer", borderRadius: "var(--radius-sm)" }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-primary)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-tertiary)"; }}
          >
            <X size={16} />
          </button>
        </div>
        <p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: "0 0 var(--space-4)" }}>
          选择导出格式
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
          {formats.map(({ key, label, icon, ext }) => (
            <button
              key={key}
              onClick={() => handleExport(key, ext)}
              disabled={exporting !== null}
              style={{
                display: "flex", alignItems: "center", gap: "var(--space-3)",
                padding: "var(--space-3) var(--space-4)", width: "100%",
                border: "1px solid var(--border-primary)", borderRadius: "var(--radius-lg)",
                background: "var(--surface-primary)", color: "var(--text-primary)",
                fontSize: "var(--text-sm)", cursor: exporting ? "wait" : "pointer",
                transition: "all var(--transition-fast)", opacity: exporting && exporting !== key ? 0.5 : 1,
              }}
              onMouseEnter={(e) => { if (!exporting) e.currentTarget.style.borderColor = "var(--interactive)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border-primary)"; }}
            >
              {exporting === key ? <Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} /> : icon}
              {exporting === key ? "导出中..." : label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
