/**
 * Security Gateway admin page — Phase 4.
 *
 * Features:
 *   - View gateway status (enabled, fail_open)
 *   - Test scanner with arbitrary text input
 *   - Test tool-call guard
 *   - Inspect matches by rule/category/severity
 */

import { useEffect, useState, type CSSProperties } from "react";
import { api, type ScanResult } from "../api/client.js";
import { Badge } from "../components/ui/Badge.js";
import { Button } from "../components/ui/Button.js";

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function ActionBadge({ action }: { action: ScanResult["action"] }) {
  if (action === "block") return <Badge variant="error">BLOCK</Badge>;
  if (action === "sanitize") return <Badge variant="warning">SANITIZE</Badge>;
  return <Badge variant="success">APPROVE</Badge>;
}

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

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

  /* -- styles -- */

  const pageStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-5)",
  };

  const titleStyle: CSSProperties = {
    fontSize: "var(--text-xl)",
    fontWeight: "var(--font-semibold)" as unknown as number,
    color: "var(--text-primary)",
    margin: 0,
  };

  const subtitleStyle: CSSProperties = {
    fontSize: "var(--text-sm)",
    color: "var(--text-secondary)",
    marginTop: "var(--space-1)",
  };

  const errorStyle: CSSProperties = {
    padding: "var(--space-4) var(--space-5)",
    background: "var(--error-light)",
    border: "1px solid var(--error)",
    borderRadius: "var(--radius-lg)",
    color: "var(--error-dark)",
    fontSize: "var(--text-sm)",
  };

  const gridStyle: CSSProperties = {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "var(--space-5)",
  };

  const panelStyle: CSSProperties = {
    background: "var(--bg-tertiary)",
    border: "1px solid var(--border-primary)",
    borderRadius: "var(--radius-xl)",
    padding: "var(--space-4)",
  };

  const panelTitleStyle: CSSProperties = {
    fontSize: "var(--text-base)",
    fontWeight: 600,
    color: "var(--text-primary)",
    marginTop: 0,
    marginBottom: "var(--space-3)",
  };

  const statusRowStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
    fontSize: "var(--text-sm)",
    color: "var(--text-primary)",
  };

  const statusColStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-2)",
  };

  const resultBlockStyle: CSSProperties = {
    marginTop: "var(--space-3)",
    fontSize: "var(--text-sm)",
  };

  const resultReasonStyle: CSSProperties = {
    marginTop: "var(--space-1)",
    color: "var(--text-secondary)",
  };

  const inputStyle: CSSProperties = {
    padding: "var(--space-2)",
    background: "var(--bg-card)",
    border: "1px solid var(--border-primary)",
    borderRadius: "var(--radius-md)",
    color: "var(--text-primary)",
    fontSize: "var(--text-sm)",
  };

  const toolRowStyle: CSSProperties = {
    display: "flex",
    gap: "var(--space-2)",
    marginBottom: "var(--space-2)",
    alignItems: "center",
  };

  const preStyle: CSSProperties = {
    fontSize: "var(--text-xs)",
    fontFamily: "var(--font-mono)",
    background: "var(--bg-card)",
    padding: "var(--space-2)",
    borderRadius: "var(--radius-md)",
    overflowX: "auto",
    color: "var(--text-primary)",
  };

  return (
    <div style={pageStyle}>
      <div>
        <h2 style={titleStyle}>Security Gateway</h2>
        <p style={subtitleStyle}>
          Three-layer content filter: Word Engine + Regex Engine + Decision Engine.
        </p>
      </div>

      {error && <div style={errorStyle}>{error}</div>}

      <div style={gridStyle}>
        {/* Status panel */}
        <div style={panelStyle}>
          <h3 style={panelTitleStyle}>Status</h3>
          <div style={statusColStyle}>
            <div style={statusRowStyle}>
              <strong>Enabled:</strong>{" "}
              {enabled === null ? (
                <span style={{ color: "var(--text-tertiary)" }}>Loading...</span>
              ) : enabled ? (
                <Badge variant="success">enabled</Badge>
              ) : (
                <Badge variant="default">disabled</Badge>
              )}
            </div>
            <div style={statusRowStyle}>
              <strong>Fail-open:</strong>{" "}
              {failOpen === null ? (
                <span style={{ color: "var(--text-tertiary)" }}>Loading...</span>
              ) : failOpen ? (
                <Badge variant="warning">fail-open</Badge>
              ) : (
                <Badge variant="default">fail-closed</Badge>
              )}
            </div>
            <div style={{ marginTop: "var(--space-2)" }}>
              <Button variant="secondary" size="sm" onClick={() => void loadStatus()}>
                Refresh
              </Button>
            </div>
          </div>
        </div>

        {/* Text scanner */}
        <div style={panelStyle}>
          <h3 style={panelTitleStyle}>Scan Text</h3>
          <textarea
            value={scanInput}
            onChange={(e) => setScanInput(e.target.value)}
            placeholder="Enter text to scan (try: 'DROP TABLE users' or '我的手机号 13812345678')"
            rows={4}
            style={{ ...inputStyle, width: "100%", fontFamily: "var(--font-mono)" }}
          />
          <div style={{ marginTop: "var(--space-2)" }}>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void scan()}
              disabled={scanBusy || !scanInput}
            >
              {scanBusy ? "Scanning..." : "Scan"}
            </Button>
          </div>
          {scanResult && (
            <div style={resultBlockStyle}>
              <div style={statusRowStyle}>
                <strong>Action:</strong>{" "}
                <ActionBadge action={scanResult.action} />
                <span style={{ color: "var(--text-tertiary)" }}>
                  (severity {scanResult.severity})
                </span>
              </div>
              {scanResult.reason && (
                <div style={resultReasonStyle}>{scanResult.reason}</div>
              )}
              {scanResult.matches.length > 0 && (
                <details style={{ marginTop: "var(--space-2)" }}>
                  <summary>{scanResult.matches.length} match(es)</summary>
                  <ul style={{ fontSize: "var(--text-xs)", fontFamily: "var(--font-mono)" }}>
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
                <details style={{ marginTop: "var(--space-2)" }}>
                  <summary>Sanitized output</summary>
                  <pre style={preStyle}>{scanResult.sanitized}</pre>
                </details>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Tool checker */}
      <div style={panelStyle}>
        <h3 style={panelTitleStyle}>Check Tool Call</h3>
        <div style={toolRowStyle}>
          <input
            value={toolName}
            onChange={(e) => setToolName(e.target.value)}
            placeholder="tool name"
            style={{ ...inputStyle, width: 150 }}
          />
          <input
            value={toolArgs}
            onChange={(e) => setToolArgs(e.target.value)}
            placeholder="JSON args"
            style={{ ...inputStyle, flex: 1, fontFamily: "var(--font-mono)" }}
          />
          <Button variant="primary" size="sm" onClick={() => void checkTool()}>
            Check
          </Button>
        </div>
        {toolResult && (
          <div style={resultBlockStyle}>
            <div style={statusRowStyle}>
              <strong>Action:</strong>{" "}
              <ActionBadge action={toolResult.action} />
              {toolResult.reason && (
                <span style={{ color: "var(--text-secondary)", marginLeft: "var(--space-2)" }}>
                  {toolResult.reason}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
