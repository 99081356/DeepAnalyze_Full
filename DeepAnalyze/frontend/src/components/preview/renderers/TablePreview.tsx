interface TablePreviewProps {
  tableData: {
    headers: string[];
    rows: string[][];
    highlightRowIndex?: number;
    caption?: string;
  };
}

export function TablePreview({ tableData }: TablePreviewProps) {
  const { headers, rows, highlightRowIndex, caption } = tableData;

  if (!headers.length && !rows.length) {
    return (
      <p style={{ color: "var(--text-tertiary)", fontSize: "var(--text-sm)", padding: "var(--space-3)" }}>
        No table data available
      </p>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
      {caption && (
        <p style={{
          fontSize: "var(--text-xs)",
          color: "var(--text-secondary)",
          margin: 0,
          padding: "0 var(--space-3)",
        }}>
          {caption}
        </p>
      )}
      <div style={{ overflow: "auto", maxHeight: 400 }}>
        <table style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: "var(--text-xs)",
        }}>
          <thead>
            <tr>
              {headers.map((h, i) => (
                <th key={i} style={{
                  padding: "6px 10px",
                  borderBottom: "2px solid var(--border-primary)",
                  textAlign: "left",
                  fontWeight: "var(--font-semibold)",
                  color: "var(--text-primary)",
                  whiteSpace: "nowrap",
                  backgroundColor: "var(--bg-secondary)",
                  position: "sticky",
                  top: 0,
                }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr
                key={ri}
                style={{
                  backgroundColor: ri === highlightRowIndex
                    ? "rgba(59, 130, 246, 0.15)"
                    : "transparent",
                }}
              >
                {headers.map((_, ci) => (
                  <td key={ci} style={{
                    padding: "5px 10px",
                    borderBottom: "1px solid var(--border-secondary)",
                    color: "var(--text-secondary)",
                    whiteSpace: "nowrap",
                    maxWidth: 250,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}>
                    {(row[ci] || "").trim()}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
