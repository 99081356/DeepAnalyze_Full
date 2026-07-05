// =============================================================================
// DeepAnalyze - ReportPanel Component
// Reports (pushed content grouped by KB), Timeline, and Knowledge Graph
// =============================================================================

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { api } from "../../api/client";
import { useMarkdown } from "../../hooks/useMarkdown";
import { useUIStore } from "../../store/ui";
import { useEvidencePreviewStore } from "../../store/evidencePreview";
import { useChatStore } from "../../store/chat";
import type { ReportDetail, TimelineEvent, GraphNode, GraphEdge, PushedContentGroup } from "../../types/index";
import { ReportExport } from "./ReportExport";
import {
  Loader2,
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  FileText,
  Clock,
  Network,
  FileDown,
  ExternalLink,
} from "lucide-react";

type SubTab = "reports" | "timeline" | "graph";

export function ReportPanel() {
  // Get kbId from Zustand store (set when user selects a knowledge base)
  const kbId = useUIStore((s) => s.currentKbId) ?? "";
  const resolvedTheme = useUIStore((s) => s.resolvedTheme);
  const [activeSubTab, setActiveSubTab] = useState<SubTab>("reports");

  // Pushed content grouped by KB
  const [pushedGroups, setPushedGroups] = useState<PushedContentGroup[]>([]);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  // Timeline & Graph
  const [selectedReport, setSelectedReport] = useState<ReportDetail | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [graphNodes, setGraphNodes] = useState<GraphNode[]>([]);
  const [graphEdges, setGraphEdges] = useState<GraphEdge[]>([]);
  const [loading, setLoading] = useState(false);
  const [exportingReportId, setExportingReportId] = useState<string | null>(null);
  const [exportingReportTitle, setExportingReportTitle] = useState("");

  // Load data when kb changes
  useEffect(() => {
    setLoading(true);
    if (kbId) {
      // KB selected: load KB-specific data
      Promise.all([
        api.getPushedByKb(kbId).catch(() => ({ groups: [] })),
        api.getTimeline(kbId).catch(() => ({ events: [] })),
        api.getGraph(kbId).catch(() => ({ nodes: [], edges: [], stats: { nodeCount: 0, edgeCount: 0 } })),
      ]).then(([pushedData, timelineData, graphData]) => {
        setPushedGroups(pushedData.groups ?? []);
        // Auto-expand the selected KB's group
        if (kbId) {
          setExpandedGroups(new Set([kbId, "__none__"]));
        }
        setTimeline(timelineData.events ?? []);
        setGraphNodes(graphData.nodes ?? []);
        setGraphEdges(graphData.edges ?? []);
        setLoading(false);
      });
    } else {
      // No KB selected: load all pushed content
      api.getPushedByKb().then((pushedData) => {
        setPushedGroups(pushedData.groups ?? []);
        // Auto-expand all groups when no KB is selected
        const allGroupIds = (pushedData.groups ?? []).map((g: PushedContentGroup) => g.kbId);
        setExpandedGroups(new Set(allGroupIds));
        setTimeline([]);
        setGraphNodes([]);
        setGraphEdges([]);
        setLoading(false);
      }).catch(() => {
        setPushedGroups([]);
        setTimeline([]);
        setGraphNodes([]);
        setGraphEdges([]);
        setLoading(false);
      });
    }
  }, [kbId]);

  // Toggle group expand/collapse
  const toggleGroup = (groupId: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  };

  // Navigate to session
  const navigateToSession = (sessionId: string) => {
    useChatStore.getState().selectSession(sessionId);
    window.location.hash = "#/sessions/" + sessionId;
  };

  // Graph canvas rendering
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const nodePositionsRef = useRef<Map<string, { x: number; y: number; vx: number; vy: number }>>(new Map());
  const animFrameRef = useRef<number>(0);

  const initGraphPositions = useCallback((centerX: number, centerY: number) => {
    const positions = nodePositionsRef.current;
    graphNodes.forEach((node, i) => {
      if (!positions.has(node.id)) {
        const angle = (2 * Math.PI * i) / graphNodes.length;
        const r = 150 + Math.random() * 100;
        positions.set(node.id, {
          x: centerX + Math.cos(angle) * r,
          y: centerY + Math.sin(angle) * r,
          vx: 0,
          vy: 0,
        });
      }
    });
  }, [graphNodes]);

  useEffect(() => {
    if (activeSubTab !== "graph" || !canvasRef.current || !containerRef.current || graphNodes.length === 0) return;

    const container = containerRef.current;
    const canvas = canvasRef.current;
    const width = container.clientWidth;
    const height = container.clientHeight;
    canvas.width = width;
    canvas.height = height;

    const centerX = width / 2;
    const centerY = height / 2;

    initGraphPositions(centerX, centerY);

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const nodeTypeColors: Record<string, string> = {
      document: "#3b82f6",
      entity: "#34d399",
      concept: "#a78bfa",
      report: "#f59e0b",
    };

    const simulate = () => {
      const positions = nodePositionsRef.current;
      const damping = 0.85;
      const repulsion = 1500;
      const attraction = 0.005;

      // Repulsion between nodes
      const nodes = graphNodes;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = positions.get(nodes[i].id);
          const b = positions.get(nodes[j].id);
          if (!a || !b) continue;
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const force = repulsion / (dist * dist);
          a.vx += (dx / dist) * force;
          a.vy += (dy / dist) * force;
          b.vx -= (dx / dist) * force;
          b.vy -= (dy / dist) * force;
        }
      }

      // Attraction along edges
      graphEdges.forEach((edge) => {
        const a = positions.get(edge.source);
        const b = positions.get(edge.target);
        if (!a || !b) return;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        a.vx += dx * attraction;
        a.vy += dy * attraction;
        b.vx -= dx * attraction;
        b.vy -= dy * attraction;
      });

      // Center gravity
      positions.forEach((p) => {
        p.vx += (centerX - p.x) * 0.01;
        p.vy += (centerY - p.y) * 0.01;
        p.vx *= damping;
        p.vy *= damping;
        p.x += p.vx;
        p.y += p.vy;
      });

      // Draw
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const isDark = resolvedTheme === "dark";
      ctx.fillStyle = isDark ? "#0a0e1a" : "#f8fafc";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Edges
      ctx.strokeStyle = isDark ? "rgba(100, 116, 139, 0.3)" : "rgba(100, 116, 139, 0.2)";
      ctx.lineWidth = 1;
      graphEdges.forEach((edge) => {
        const a = positions.get(edge.source);
        const b = positions.get(edge.target);
        if (!a || !b) return;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();

        // Edge label
        if (edge.label) {
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2;
          ctx.fillStyle = isDark ? "#64748b" : "#94a3b8";
          ctx.font = "9px sans-serif";
          ctx.textAlign = "center";
          ctx.fillText(edge.label, mx, my - 4);
        }
      });

      // Nodes
      nodes.forEach((node) => {
        const p = positions.get(node.id);
        if (!p) return;
        const color = nodeTypeColors[node.type] ?? "#64748b";

        ctx.beginPath();
        ctx.arc(p.x, p.y, 8, 0, 2 * Math.PI);
        ctx.fillStyle = color;
        ctx.fill();

        ctx.fillStyle = isDark ? "#e2e8f0" : "#1e293b";
        ctx.font = "11px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(node.label, p.x, p.y + 20);
      });

      animFrameRef.current = requestAnimationFrame(simulate);
    };

    simulate();
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [activeSubTab, graphNodes, graphEdges, initGraphPositions, resolvedTheme]);

  // When no KB is selected and user is on timeline or graph tab, show a prompt
  const showKbPrompt = !kbId && (activeSubTab === "timeline" || activeSubTab === "graph");

  return (
    <div style={{
      height: "100%",
      display: "flex",
      flexDirection: "column",
      background: "var(--bg-primary)",
    }}>
      {/* Sub-tab navigation */}
      <div style={{
        flexShrink: 0,
        borderBottom: "1px solid var(--border-primary)",
        padding: "var(--space-2) var(--space-4)",
        background: "var(--bg-secondary)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-1)" }}>
          {[
            { id: "reports" as const, label: "推送内容", Icon: FileText },
            { id: "timeline" as const, label: "时间线", Icon: Clock },
            { id: "graph" as const, label: "关系图", Icon: Network },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveSubTab(tab.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-1)",
                padding: "6px 12px",
                fontSize: "var(--text-xs)",
                fontWeight: "var(--font-medium)",
                borderRadius: "var(--radius-md)",
                cursor: "pointer",
                transition: "all var(--transition-fast)",
                border: "none",
                background: activeSubTab === tab.id ? "var(--interactive)" : "transparent",
                color: activeSubTab === tab.id ? "#fff" : "var(--text-tertiary)",
              }}
              onMouseEnter={(e) => {
                if (activeSubTab !== tab.id) e.currentTarget.style.color = "var(--text-secondary)";
              }}
              onMouseLeave={(e) => {
                if (activeSubTab !== tab.id) e.currentTarget.style.color = "var(--text-tertiary)";
              }}
            >
              <tab.Icon size={14} />
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: "hidden" }}>
        {loading ? (
          <div style={{
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--text-tertiary)",
            gap: "var(--space-2)",
          }}>
            <Loader2 size={20} style={{ animation: "spin 1s linear infinite" }} />
            加载中...
          </div>
        ) : selectedReport ? (
          <ReportDetailPanel report={selectedReport} kbId={kbId} onBack={() => setSelectedReport(null)} onExport={(id, title) => { setExportingReportId(id); setExportingReportTitle(title); }} />
        ) : activeSubTab === "reports" ? (
          /* Pushed content grouped by KB */
          <div style={{
            height: "100%",
            overflowY: "auto",
            padding: "var(--space-4)",
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-2)",
          }}>
            {pushedGroups.length === 0 ? (
              <div style={{
                textAlign: "center",
                padding: "48px 0",
                color: "var(--text-tertiary)",
              }}>
                <p>暂无推送内容</p>
                <p style={{ fontSize: "var(--text-xs)", marginTop: "var(--space-1)" }}>
                  在对话中 Agent 推送的内容将按知识库分组显示在这里
                </p>
              </div>
            ) : (
              pushedGroups.map((group) => {
                const isExpanded = expandedGroups.has(group.kbId);
                const isCurrentKb = group.kbId === kbId;
                return (
                  <div key={group.kbId} style={{
                    border: "1px solid var(--border-primary)",
                    borderRadius: "var(--radius-lg)",
                    overflow: "hidden",
                    borderColor: isCurrentKb ? "var(--interactive-light)" : "var(--border-primary)",
                  }}>
                    {/* Group header */}
                    <div
                      onClick={() => toggleGroup(group.kbId)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "var(--space-2)",
                        padding: "var(--space-3) var(--space-4)",
                        background: "var(--bg-secondary)",
                        cursor: "pointer",
                        userSelect: "none",
                        transition: "background var(--transition-fast)",
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = "var(--bg-secondary)"; }}
                    >
                      {isExpanded ? (
                        <ChevronDown size={16} style={{ color: "var(--text-tertiary)", flexShrink: 0 }} />
                      ) : (
                        <ChevronRight size={16} style={{ color: "var(--text-tertiary)", flexShrink: 0 }} />
                      )}
                      <span style={{
                        fontSize: "var(--text-sm)",
                        fontWeight: "var(--font-semibold)",
                        color: "var(--text-primary)",
                        flex: 1,
                      }}>
                        {group.kbName}
                      </span>
                      <span style={{
                        fontSize: "var(--text-xs)",
                        color: "var(--text-tertiary)",
                        background: "var(--bg-primary)",
                        padding: "2px 8px",
                        borderRadius: "var(--radius-full)",
                      }}>
                        {group.items?.length ?? 0}
                      </span>
                    </div>

                    {/* Group items */}
                    {isExpanded && (
                      <div style={{
                        display: "flex",
                        flexDirection: "column",
                        borderTop: "1px solid var(--border-primary)",
                      }}>
                        {group.items.map((item, idx) => (
                          <div
                            key={`${item.messageId}-${idx}`}
                            onClick={() => navigateToSession(item.sessionId)}
                            style={{
                              display: "flex",
                              alignItems: "flex-start",
                              gap: "var(--space-3)",
                              padding: "var(--space-3) var(--space-4)",
                              cursor: "pointer",
                              borderBottom: idx < (group.items?.length ?? 0) - 1 ? "1px solid var(--border-primary)" : "none",
                              transition: "background var(--transition-fast)",
                            }}
                            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                          >
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <p style={{
                                fontSize: "var(--text-sm)",
                                color: "var(--text-primary)",
                                fontWeight: "var(--font-medium)",
                                margin: 0,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}>
                                {item.pushedContent.title}
                              </p>
                              <div style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "var(--space-2)",
                                marginTop: "var(--space-1)",
                                fontSize: "var(--text-xs)",
                                color: "var(--text-tertiary)",
                                flexWrap: "wrap",
                              }}>
                                <span>{new Date(item.createdAt).toLocaleDateString("zh-CN")}</span>
                                <span style={{ color: "var(--text-quaternary)" }}>|</span>
                                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 200 }}>
                                  {item.sessionTitle}
                                </span>
                                {item.pushedContent.dataLength != null && (
                                  <>
                                    <span style={{ color: "var(--text-quaternary)" }}>|</span>
                                    <span>{item.pushedContent.dataLength.toLocaleString()} chars</span>
                                  </>
                                )}
                                {item.pushedContent.format && (
                                  <>
                                    <span style={{ color: "var(--text-quaternary)" }}>|</span>
                                    <span>{item.pushedContent.format}</span>
                                  </>
                                )}
                              </div>
                            </div>
                            <ExternalLink size={14} style={{ color: "var(--text-quaternary)", flexShrink: 0, marginTop: 2 }} />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        ) : activeSubTab === "timeline" ? (
          <div style={{ height: "100%", overflowY: "auto", padding: "var(--space-4)" }}>
            {showKbPrompt ? (
              <div style={{
                height: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--text-tertiary)",
              }}>
                <p>请先在知识库标签页中选择一个知识库以查看时间线</p>
              </div>
            ) : timeline.length === 0 ? (
              <div style={{
                textAlign: "center",
                padding: "48px 0",
                color: "var(--text-tertiary)",
              }}>
                暂无时间线数据
              </div>
            ) : (
              <div style={{ position: "relative", paddingLeft: "var(--space-6)" }}>
                <div style={{
                  position: "absolute",
                  left: 8,
                  top: 0,
                  bottom: 0,
                  width: 1,
                  background: "var(--border-primary)",
                }} />
                {timeline.map((event) => (
                  <div key={event.date} style={{ position: "relative", paddingBottom: "var(--space-6)" }}>
                    <div style={{
                      position: "absolute",
                      left: -18,
                      width: 12,
                      height: 12,
                      borderRadius: "var(--radius-full)",
                      background: "var(--interactive)",
                      border: "2px solid var(--bg-primary)",
                    }} />
                    <div style={{
                      padding: "var(--space-3) var(--space-4)",
                      background: "var(--bg-secondary)",
                      border: "1px solid var(--border-primary)",
                      borderRadius: "var(--radius-lg)",
                    }}>
                      <div style={{
                        fontSize: "var(--text-xs)",
                        color: "var(--interactive)",
                        fontWeight: "var(--font-medium)",
                        marginBottom: "var(--space-1)",
                      }}>
                        {event.date}
                      </div>
                      <p style={{
                        fontSize: "var(--text-sm)",
                        color: "var(--text-primary)",
                        fontWeight: "var(--font-medium)",
                        margin: 0,
                      }}>
                        {event.title}
                      </p>
                      <p style={{
                        fontSize: "var(--text-sm)",
                        color: "var(--text-secondary)",
                        marginTop: "var(--space-1)",
                        margin: 0,
                      }}>
                        {event.description}
                      </p>
                      <p style={{
                        fontSize: "var(--text-xs)",
                        color: "var(--text-tertiary)",
                        marginTop: "var(--space-2)",
                        margin: 0,
                      }}>
                        来源: {event.sourceTitle}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : showKbPrompt ? (
          <div style={{
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--text-tertiary)",
          }}>
            <p>请先在知识库标签页中选择一个知识库以查看关系图</p>
          </div>
        ) : (
          /* Graph */
          <div ref={containerRef} style={{ height: "100%", position: "relative" }}>
            <canvas
              ref={canvasRef}
              style={{ width: "100%", height: "100%", display: "block" }}
            />
            <div style={{
              position: "absolute",
              top: "var(--space-3)",
              right: "var(--space-3)",
              display: "flex",
              alignItems: "center",
              gap: "var(--space-3)",
              fontSize: "var(--text-xs)",
              color: "var(--text-tertiary)",
              background: "color-mix(in srgb, var(--bg-primary) 80%, transparent)",
              padding: "var(--space-2) var(--space-3)",
              borderRadius: "var(--radius-lg)",
            }}>
              <span style={{ display: "flex", alignItems: "center", gap: "var(--space-1)" }}>
                <span style={{ width: 8, height: 8, borderRadius: "var(--radius-full)", background: "#3b82f6" }} />
                文档
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: "var(--space-1)" }}>
                <span style={{ width: 8, height: 8, borderRadius: "var(--radius-full)", background: "#34d399" }} />
                实体
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: "var(--space-1)" }}>
                <span style={{ width: 8, height: 8, borderRadius: "var(--radius-full)", background: "#a78bfa" }} />
                概念
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: "var(--space-1)" }}>
                <span style={{ width: 8, height: 8, borderRadius: "var(--radius-full)", background: "#f59e0b" }} />
                报告
              </span>
              <span>| {graphNodes.length} 节点 {graphEdges.length} 边</span>
            </div>
          </div>
        )}
      </div>

      {exportingReportId && (
        <ReportExport
          reportId={exportingReportId}
          reportTitle={exportingReportTitle}
          onClose={() => setExportingReportId(null)}
        />
      )}
    </div>
  );
}

// Report Detail View (kept for evidence link rendering used elsewhere)
function escapeHtmlAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function processReportEvidenceLinks(html: string): string {
  // Pattern 1: da-evidence:// protocol (raw markdown)
  let result = html.replace(
    /\[([^\]]+)\]\(da-evidence:\/\/([^/]+)\/([^?)]+)\?anchor=([^)]+)\)/g,
    (_match, text: string, kbId: string, docId: string, anchorId: string) =>
      `<a href="#" class="evidence-link" data-evidence-kb="${escapeHtmlAttr(kbId)}" data-evidence-doc="${escapeHtmlAttr(docId)}" data-evidence-anchor="${escapeHtmlAttr(anchorId)}">${escapeHtmlAttr(text)}</a>`,
  );
  // Pattern 2: da-evidence:// protocol (HTML <a> tag)
  result = result.replace(
    /<a\s+href="da-evidence:\/\/([^/]+)\/([^?"]+)\?anchor=([^"]+)"[^>]*>([\s\S]*?)<\/a>/g,
    (_match, kbId: string, docId: string, anchorId: string, text: string) =>
      `<a href="#" class="evidence-link" data-evidence-kb="${escapeHtmlAttr(kbId)}" data-evidence-doc="${escapeHtmlAttr(docId)}" data-evidence-anchor="${escapeHtmlAttr(anchorId)}">${text}</a>`,
  );
  // Pattern 3: da-evidence:// without anchor (raw markdown)
  result = result.replace(
    /\[([^\]]+)\]\(da-evidence:\/\/([^/]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/gi,
    (_match, text: string, kbId: string, docId: string) =>
      `<a href="#" class="evidence-link" data-evidence-kb="${escapeHtmlAttr(kbId)}" data-evidence-doc="${escapeHtmlAttr(docId)}">${escapeHtmlAttr(text)}</a>`,
  );
  // Pattern 4: da-evidence:// without anchor (HTML <a> tag)
  result = result.replace(
    /<a\s+href="da-evidence:\/\/([^/]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"[^>]*>([\s\S]*?)<\/a>/gi,
    (_match, kbId: string, docId: string, text: string) =>
      `<a href="#" class="evidence-link" data-evidence-kb="${escapeHtmlAttr(kbId)}" data-evidence-doc="${escapeHtmlAttr(docId)}">${text}</a>`,
  );
  // Pattern 5: Plain UUID docId (raw markdown)
  result = result.replace(
    /\[([^\]]+)\]\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/gi,
    (_match, text: string, docId: string) =>
      `<a href="#" class="evidence-link" data-evidence-doc="${escapeHtmlAttr(docId)}">${escapeHtmlAttr(text)}</a>`,
  );
  // Pattern 6: Plain UUID docId (HTML <a> tag)
  result = result.replace(
    /<a\s+href="([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"([^>]*)>([\s\S]*?)<\/a>/gi,
    (_match, docId: string, attrs: string, text: string) =>
      `<a href="#" class="evidence-link" data-evidence-doc="${escapeHtmlAttr(docId)}"${attrs}>${text}</a>`,
  );
  // Pattern 7: Bare bracket [da-evidence://kbId/docId] or [da-evidence://kbId/docId?anchor=anchorId]
  // (report generates this format instead of proper markdown [text](url) links)
  result = result.replace(
    /\[da-evidence:\/\/([^/\]]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\?anchor=([^\]]+))?\]/gi,
    (_match, kbId: string, docId: string, anchorId?: string) => {
      const anchorAttr = anchorId ? ` data-evidence-anchor="${escapeHtmlAttr(anchorId)}"` : "";
      return `<sup><a href="#" class="evidence-link" data-evidence-kb="${escapeHtmlAttr(kbId)}" data-evidence-doc="${escapeHtmlAttr(docId)}"${anchorAttr}>📎</a></sup>`;
    },
  );
  // Pattern 9: kb:// protocol [text](kb://docId) — LLM sometimes generates this instead of da-evidence://
  result = result.replace(
    /\[([^\]]+)\]\(kb:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/gi,
    (_match, text: string, docId: string) =>
      `<a href="#" class="evidence-link" data-evidence-doc="${escapeHtmlAttr(docId)}">${escapeHtmlAttr(text)}</a>`,
  );
  // Pattern 9b: HTML <a href="kb://docId">text</a>
  result = result.replace(
    /<a\s+href="kb:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"[^>]*>([\s\S]*?)<\/a>/gi,
    (_match, docId: string, text: string) =>
      `<a href="#" class="evidence-link" data-evidence-doc="${escapeHtmlAttr(docId)}">${text}</a>`,
  );
  // Pattern 10: Backtick-wrapped file references [`filename.ext`]
  // These are NOT evidence links (no docId), but styled as inline file tags for readability.
  result = result.replace(
    /\[\x60([^\x60]+)\x60\]/g,
    (_match, filename: string) =>
      `<span class="file-ref">${escapeHtmlAttr(filename)}</span>`,
  );
  // Pattern 11: Bare-text da-evidence:// URLs — LLM sometimes writes these as plain text
  // instead of proper [text](url) markdown links. Convert to clickable 📎 evidence links.
  // Handles: da-evidence://{docId}#{anchor} and da-evidence://{docId} (no anchor).
  // When no anchor is specified, defaults to {docId}:paragraph:0 for better precision.
  // The EvidencePreviewPanel gracefully falls back to document preview if the anchor 404s.
  result = result.replace(
    /da-evidence:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:#([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[a-z]+:\d+))?/gi,
    (_match, docId: string, anchorId?: string) => {
      const effectiveAnchor = anchorId || `${docId}:paragraph:0`;
      return `<sup><a href="#" class="evidence-link" data-evidence-doc="${escapeHtmlAttr(docId)}" data-evidence-anchor="${escapeHtmlAttr(effectiveAnchor)}">📎</a></sup>`;
    },
  );
  return result;
}

function ReportDetailPanel({ report, kbId, onBack, onExport }: { report: ReportDetail; kbId: string; onBack: () => void; onExport: (id: string, title: string) => void }) {
  const rawHtml = useMarkdown(report.content);
  const htmlContent = useMemo(() => processReportEvidenceLinks(rawHtml), [rawHtml]);
  const navigateToWikiPage = useUIStore((s) => s.navigateToWikiPage);

  return (
    <div style={{ height: "100%", overflowY: "auto" }}>
      <div style={{
        position: "sticky",
        top: 0,
        background: "var(--bg-secondary)",
        borderBottom: "1px solid var(--border-primary)",
        padding: "var(--space-3) var(--space-6)",
        display: "flex",
        alignItems: "center",
        gap: "var(--space-3)",
        zIndex: 10,
      }}>
        <button
          onClick={onBack}
          style={{
            background: "transparent",
            border: "none",
            cursor: "pointer",
            color: "var(--text-tertiary)",
            padding: 0,
            display: "flex",
            transition: "color var(--transition-fast)",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-primary)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-tertiary)"; }}
        >
          <ChevronLeft size={20} />
        </button>
        <button
          onClick={() => onExport(report.id, report.title)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-1)",
            padding: "4px 10px",
            fontSize: "var(--text-xs)",
            fontWeight: "var(--font-medium)",
            borderRadius: "var(--radius-md)",
            cursor: "pointer",
            border: "1px solid var(--border-primary)",
            background: "transparent",
            color: "var(--text-secondary)",
            transition: "all var(--transition-fast)",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--interactive)"; e.currentTarget.style.color = "var(--interactive)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border-primary)"; e.currentTarget.style.color = "var(--text-secondary)"; }}
        >
          <FileDown size={14} />
          导出
        </button>
        {kbId && (
          <button
            onClick={() => navigateToWikiPage(kbId, report.id)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-1)",
              padding: "4px 10px",
              fontSize: "var(--text-xs)",
              fontWeight: "var(--font-medium)",
              borderRadius: "var(--radius-md)",
              cursor: "pointer",
              border: "1px solid var(--border-primary)",
              background: "transparent",
              color: "var(--text-secondary)",
              transition: "all var(--transition-fast)",
              marginLeft: "auto",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--interactive)"; e.currentTarget.style.color = "var(--interactive)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border-primary)"; e.currentTarget.style.color = "var(--text-secondary)"; }}
          >
            <ExternalLink size={14} />
            在知识库中查看
          </button>
        )}
        <div>
          <h3 style={{
            fontSize: "var(--text-sm)",
            fontWeight: "var(--font-medium)",
            color: "var(--text-primary)",
            margin: 0,
          }}>
            {report.title}
          </h3>
          <p style={{
            fontSize: 10,
            color: "var(--text-tertiary)",
            margin: 0,
          }}>
            {new Date(report.createdAt).toLocaleString("zh-CN")} | {report.tokenCount} tokens
          </p>
        </div>
      </div>
      <div style={{ padding: "var(--space-4) var(--space-6)", maxWidth: 900, margin: "0 auto" }}>
        <div
          className="markdown-content"
          dangerouslySetInnerHTML={{ __html: htmlContent }}
          onClick={(e) => {
            const target = e.target as HTMLElement;
            // Handle evidence preview links (with anchor)
            const evidenceEl = target.closest<HTMLElement>('[data-evidence-anchor]');
            if (evidenceEl) {
              e.preventDefault();
              const { evidenceKb, evidenceDoc, evidenceAnchor } = evidenceEl.dataset;
              useEvidencePreviewStore.getState().openPreview(evidenceAnchor!, evidenceKb!, evidenceDoc!);
              return;
            }
            // Handle docId-only evidence links (no anchor/kbId)
            const docEl = target.closest<HTMLElement>('[data-evidence-doc]:not([data-evidence-anchor])');
            if (docEl) {
              e.preventDefault();
              const docId = docEl.dataset.evidenceDoc!;
              const resolvedKbId = docEl.dataset.evidenceKb || kbId;
              if (resolvedKbId) {
                useEvidencePreviewStore.getState().openDocumentPreview(resolvedKbId, docId);
              }
            }
          }}
        />
      </div>
    </div>
  );
}
