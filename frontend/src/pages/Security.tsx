/**
 * Security Gateway admin page — Phase 4.
 *
 * Features:
 *   - View gateway status (enabled, fail_open)
 *   - Test scanner with arbitrary text input
 *   - Test tool-call guard
 *   - Inspect matches by rule/category/severity
 */

import { useEffect, useState } from "react";
import { api, type ScanResult } from "../api/client";

export function Security() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [failOpen, setFailOpen] = useState<boolean | null>(null);
  const [scanInput, setScanInput] = useState("");
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [toolName, setToolName] = useState("bash");
  const [toolArgs, setToolArgs] = useState('{"command": "ls"}');
  const [toolResult, setToolResult] = useState<ScanResult | null>(null);

  async function loadStatus() {
    try {
      const data = await api.getSecurityStatus();
      setEnabled(data.enabled);
      setFailOpen(data.fail_open);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void loadStatus();
  }, []);

  async function scan() {
    setScanBusy(true);
    setError(null);
    try {
      const data = await api.scanText(scanInput);
      setScanResult(data.result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setScanBusy(false);
    }
  }

  async function checkTool() {
    setError(null);
    try {
      const parsed = JSON.parse(toolArgs);
      const data = await api.checkTool(toolName, parsed);
      setToolResult(data.result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const actionColor = (a: ScanResult["action"]): string => {
    if (a === "block") return "#ef4444";
    if (a === "sanitize") return "#f59e0b";
    return "#10b981";
  };

  return (
    <div style={{ padding: "24px" }}>
      <h1>Security Gateway</h1>
      <p style={{ color: "#6b7280", marginTop: "-8px" }}>
        Three-layer content filter: Word Engine + Regex Engine + Decision Engine.
      </p>

      {error && (
        <div style={{ padding: "8px 12px", background: "#fee", color: "#900", marginBottom: "12px", borderRadius: "4px" }}>
          {error}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "24px", marginTop: "16px" }}>
        {/* Status panel */}
        <div style={{ background: "#f9fafb", padding: "16px", borderRadius: "8px" }}>
          <h3 style={{ marginTop: 0 }}>Status</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <div>
              <strong>Enabled:</strong>{" "}
              <span style={{ color: enabled ? "#10b981" : "#6b7280" }}>
                {enabled === null ? "Loading..." : enabled ? "Yes" : "No"}
              </span>
            </div>
            <div>
              <strong>Fail-open:</strong>{" "}
              <span style={{ color: failOpen ? "#f59e0b" : "#6b7280" }}>
                {failOpen === null ? "Loading..." : failOpen ? "Yes (errors pass)" : "No (fail closed)"}
              </span>
            </div>
            <button onClick={() => void loadStatus()} style={{ marginTop: "8px", padding: "6px 12px" }}>
              Refresh
            </button>
          </div>
        </div>

        {/* Text scanner */}
        <div style={{ background: "#f9fafb", padding: "16px", borderRadius: "8px" }}>
          <h3 style={{ marginTop: 0 }}>Scan Text</h3>
          <textarea
            value={scanInput}
            onChange={(e) => setScanInput(e.target.value)}
            placeholder="Enter text to scan (try: 'DROP TABLE users' or '我的手机号 13812345678')"
            rows={4}
            style={{ width: "100%", padding: "8px", fontFamily: "monospace", fontSize: "13px" }}
          />
          <button
            onClick={() => void scan()}
            disabled={scanBusy || !scanInput}
            style={{ marginTop: "8px", padding: "6px 12px" }}
          >
            {scanBusy ? "Scanning..." : "Scan"}
          </button>
          {scanResult && (
            <div style={{ marginTop: "12px", fontSize: "13px" }}>
              <div>
                <strong>Action:</strong>{" "}
                <span style={{ color: actionColor(scanResult.action), fontWeight: "bold" }}>
                  {scanResult.action.toUpperCase()}
                </span>{" "}
                <span style={{ color: "#6b7280" }}>(severity {scanResult.severity})</span>
              </div>
              {scanResult.reason && (
                <div style={{ marginTop: "4px", color: "#6b7280" }}>{scanResult.reason}</div>
              )}
              {scanResult.matches.length > 0 && (
                <details style={{ marginTop: "8px" }}>
                  <summary>{scanResult.matches.length} match(es)</summary>
                  <ul style={{ fontSize: "12px", fontFamily: "monospace" }}>
                    {scanResult.matches.map((m, i) => (
                      <li key={i}>
                        <strong>[{m.severity}]</strong> {m.rule_id} —{" "}
                        <em>{m.category}</em>: {m.matched_text}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {scanResult.sanitized && (
                <details style={{ marginTop: "8px" }}>
                  <summary>Sanitized output</summary>
                  <pre style={{ fontSize: "12px", background: "white", padding: "8px", borderRadius: "4px", overflowX: "auto" }}>
                    {scanResult.sanitized}
                  </pre>
                </details>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Tool checker */}
      <div style={{ background: "#f9fafb", padding: "16px", borderRadius: "8px", marginTop: "24px" }}>
        <h3 style={{ marginTop: 0 }}>Check Tool Call</h3>
        <div style={{ display: "flex", gap: "8px", marginBottom: "8px" }}>
          <input
            value={toolName}
            onChange={(e) => setToolName(e.target.value)}
            placeholder="tool name"
            style={{ padding: "6px", width: "150px" }}
          />
          <input
            value={toolArgs}
            onChange={(e) => setToolArgs(e.target.value)}
            placeholder="JSON args"
            style={{ padding: "6px", flex: 1, fontFamily: "monospace" }}
          />
          <button onClick={() => void checkTool()} style={{ padding: "6px 12px" }}>
            Check
          </button>
        </div>
        {toolResult && (
          <div style={{ fontSize: "13px" }}>
            <strong>Action:</strong>{" "}
            <span style={{ color: actionColor(toolResult.action), fontWeight: "bold" }}>
              {toolResult.action.toUpperCase()}
            </span>
            {toolResult.reason && (
              <span style={{ color: "#6b7280", marginLeft: "8px" }}>{toolResult.reason}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
