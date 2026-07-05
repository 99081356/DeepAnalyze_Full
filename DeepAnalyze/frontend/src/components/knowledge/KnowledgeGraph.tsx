// =============================================================================
// DeepAnalyze - KnowledgeGraph Component
// Canvas-based force-directed graph showing document-entity relationships
// =============================================================================

import React, { useState, useEffect, useRef, useCallback } from "react";
import { api } from "../../api/client";
import { useUIStore } from "../../store/ui";
import type { GraphNode, GraphEdge } from "../../types/index";
import { Spinner } from "../ui/Spinner";
import { AlertCircle, RefreshCw } from "lucide-react";

// =============================================================================
// Types
// =============================================================================

interface KnowledgeGraphProps {
  kbId: string;
}

/** Internal node representation with position and velocity for force simulation */
interface SimNode extends GraphNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
}

// =============================================================================
// Constants
// =============================================================================

const REPULSION_CONSTANT = 5000;
const ATTRACTION_CONSTANT = 0.01;
const DAMPING_FACTOR = 0.9;
const MIN_DISTANCE = 1;
const NODE_RADIUS = 20;
const MAX_LABEL_LENGTH = 16;
const SIMULATION_ALPHA_DECAY = 0.998;
const INITIAL_ALPHA = 1.0;
const ALPHA_THRESHOLD = 0.001;

const NODE_COLORS: Record<string, string> = {
  document: "#4A90D9",
  entity: "#2ECC71",
  concept: "#9B59B6",
};

const DEFAULT_NODE_COLOR = "#95A5A6";

const EDGE_OPACITY: Record<string, number> = {
  entity_ref: 0.6,
  concept_ref: 0.5,
  forward: 0.4,
  backward: 0.4,
};

const DEFAULT_EDGE_OPACITY = 0.3;

// =============================================================================
// Helpers
// =============================================================================

function getNodeColor(type: string): string {
  return NODE_COLORS[type] ?? DEFAULT_NODE_COLOR;
}

function getEdgeOpacity(type: string): number {
  return EDGE_OPACITY[type] ?? DEFAULT_EDGE_OPACITY;
}

function truncateLabel(label: string, maxLen: number = MAX_LABEL_LENGTH): string {
  if (label.length <= maxLen) return label;
  return label.slice(0, maxLen - 1) + "\u2026";
}

// =============================================================================
// Component
// =============================================================================

export function KnowledgeGraph({ kbId }: KnowledgeGraphProps) {
  // --- State ---
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<{ nodeCount: number; edgeCount: number } | null>(null);
  const [activeTypes, setActiveTypes] = useState<Set<string>>(new Set(["document", "entity", "concept"]));

  // --- Refs ---
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const simNodesRef = useRef<SimNode[]>([]);
  const edgesRef = useRef<GraphEdge[]>([]);
  const alphaRef = useRef(INITIAL_ALPHA);
  const animFrameRef = useRef<number>(0);
  const dragNodeRef = useRef<SimNode | null>(null);
  const isDraggingRef = useRef(false);
  const isPanningRef = useRef(false);
  const hasMovedRef = useRef(false);
  const hoveredNodeRef = useRef<SimNode | null>(null);
  const panStartRef = useRef<{ x: number; y: number } | null>(null);
  // Zoom / pan transform
  const scaleRef = useRef(1.0);
  const offsetRef = useRef({ x: 0, y: 0 });

  // --- Store ---
  const navigateToWikiPage = useUIStore((s) => s.navigateToWikiPage);

  // --- Fetch graph data ---
  const fetchGraph = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const resp = await api.getGraph(kbId);
      setStats(resp.stats);

      const canvas = canvasRef.current;
      const width = canvas?.width ?? 800;
      const height = canvas?.height ?? 600;

      // Initialize simulation nodes with random positions around center
      const centerX = width / 2;
      const centerY = height / 2;
      const spread = Math.min(width, height) * 0.35;

      simNodesRef.current = resp.nodes.map((node) => ({
        ...node,
        x: centerX + (Math.random() - 0.5) * spread * 2,
        y: centerY + (Math.random() - 0.5) * spread * 2,
        vx: 0,
        vy: 0,
        radius: NODE_RADIUS,
      }));

      edgesRef.current = resp.edges;
      alphaRef.current = INITIAL_ALPHA;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load graph data");
    } finally {
      setIsLoading(false);
    }
  }, [kbId]);

  useEffect(() => {
    fetchGraph();
  }, [fetchGraph]);

  // --- Resize canvas to fit container ---
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;

        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
      }
    });

    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, []);

  // --- Find node at canvas position ---
  const findNodeAt = useCallback(
    (canvasX: number, canvasY: number): SimNode | null => {
      const nodes = simNodesRef.current;
      for (let i = nodes.length - 1; i >= 0; i--) {
        const node = nodes[i];
        const dx = canvasX - node.x;
        const dy = canvasY - node.y;
        if (dx * dx + dy * dy <= (node.radius + 4) * (node.radius + 4)) {
          return node;
        }
      }
      return null;
    },
    [],
  );

  // --- Get canvas coordinates from mouse event (accounting for zoom/pan) ---
  const getCanvasCoords = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>): { x: number; y: number } => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      const rect = canvas.getBoundingClientRect();
      const screenX = e.clientX - rect.left;
      const screenY = e.clientY - rect.top;
      // Convert screen coords to world coords (inverse transform)
      return {
        x: (screenX - offsetRef.current.x) / scaleRef.current,
        y: (screenY - offsetRef.current.y) / scaleRef.current,
      };
    },
    [],
  );

  // --- Mouse handlers ---
  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const coords = getCanvasCoords(e);
      const node = findNodeAt(coords.x, coords.y);
      if (node) {
        dragNodeRef.current = node;
        isDraggingRef.current = true;
        hasMovedRef.current = false;
      } else {
        // Start panning
        isPanningRef.current = true;
        panStartRef.current = { x: e.clientX, y: e.clientY };
        hasMovedRef.current = false;
      }
    },
    [getCanvasCoords, findNodeAt],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const coords = getCanvasCoords(e);

      if (isDraggingRef.current && dragNodeRef.current) {
        hasMovedRef.current = true;
        dragNodeRef.current.x = coords.x;
        dragNodeRef.current.y = coords.y;
        dragNodeRef.current.vx = 0;
        dragNodeRef.current.vy = 0;
        // Reheat simulation slightly during drag
        alphaRef.current = Math.max(alphaRef.current, 0.3);
      } else if (isPanningRef.current && panStartRef.current) {
        hasMovedRef.current = true;
        const dx = e.clientX - panStartRef.current.x;
        const dy = e.clientY - panStartRef.current.y;
        offsetRef.current = {
          x: offsetRef.current.x + dx,
          y: offsetRef.current.y + dy,
        };
        panStartRef.current = { x: e.clientX, y: e.clientY };
      } else {
        // Hover detection
        const node = findNodeAt(coords.x, coords.y);
        hoveredNodeRef.current = node;
        const canvas = canvasRef.current;
        if (canvas) {
          canvas.style.cursor = node ? "pointer" : "grab";
        }
      }
    },
    [getCanvasCoords, findNodeAt],
  );

  const handleMouseUp = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (dragNodeRef.current && !hasMovedRef.current) {
        // It was a click (no movement), not a drag -- navigate
        const node = dragNodeRef.current;
        navigateToWikiPage(kbId, node.id);
      }
      dragNodeRef.current = null;
      isDraggingRef.current = false;
      isPanningRef.current = false;
      panStartRef.current = null;
      hasMovedRef.current = false;
    },
    [kbId, navigateToWikiPage],
  );

  const handleMouseLeave = useCallback(() => {
    dragNodeRef.current = null;
    isDraggingRef.current = false;
    isPanningRef.current = false;
    panStartRef.current = null;
    hasMovedRef.current = false;
    hoveredNodeRef.current = null;
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.style.cursor = "default";
    }
  }, []);

  // --- Wheel handler for zoom ---
  const handleWheel = useCallback(
    (e: React.WheelEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();

      // Mouse position in screen coordinates
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      // Calculate new scale
      const delta = -e.deltaY * 0.001;
      const oldScale = scaleRef.current;
      const newScale = Math.min(Math.max(oldScale * (1 + delta), 0.1), 5.0);

      // Adjust offset to zoom toward mouse position
      offsetRef.current = {
        x: mouseX - (mouseX - offsetRef.current.x) * (newScale / oldScale),
        y: mouseY - (mouseY - offsetRef.current.y) * (newScale / oldScale),
      };

      scaleRef.current = newScale;
    },
    [],
  );

  // --- Force simulation step ---
  const simulateStep = useCallback(() => {
    const nodes = simNodesRef.current;
    const edges = edgesRef.current;
    const alpha = alphaRef.current;

    if (alpha < ALPHA_THRESHOLD) return;

    const nodeCount = nodes.length;
    if (nodeCount === 0) return;

    // Build a quick lookup for node index by id
    const nodeIndex = new Map<string, number>();
    for (let i = 0; i < nodeCount; i++) {
      nodeIndex.set(nodes[i].id, i);
    }

    // --- Repulsion (all pairs) ---
    for (let i = 0; i < nodeCount; i++) {
      for (let j = i + 1; j < nodeCount; j++) {
        const ni = nodes[i];
        const nj = nodes[j];
        let dx = nj.x - ni.x;
        let dy = nj.y - ni.y;
        let distSq = dx * dx + dy * dy;
        if (distSq < MIN_DISTANCE) distSq = MIN_DISTANCE;

        const force = (REPULSION_CONSTANT * alpha) / distSq;
        const dist = Math.sqrt(distSq);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;

        ni.vx -= fx;
        ni.vy -= fy;
        nj.vx += fx;
        nj.vy += fy;
      }
    }

    // --- Attraction (along edges) ---
    for (const edge of edges) {
      const srcIdx = nodeIndex.get(edge.source);
      const tgtIdx = nodeIndex.get(edge.target);
      if (srcIdx === undefined || tgtIdx === undefined) continue;

      const src = nodes[srcIdx];
      const tgt = nodes[tgtIdx];
      const dx = tgt.x - src.x;
      const dy = tgt.y - src.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < MIN_DISTANCE) continue;

      const weight = (edge as GraphEdge & { weight?: number }).weight ?? 1;
      const force = ATTRACTION_CONSTANT * dist * weight * alpha;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;

      src.vx += fx;
      src.vy += fy;
      tgt.vx -= fx;
      tgt.vy -= fy;
    }

    // --- Apply velocities with damping ---
    const canvas = canvasRef.current;
    const dpr = window.devicePixelRatio || 1;
    const canvasW = (canvas?.width ?? 800) / dpr;
    const canvasH = (canvas?.height ?? 600) / dpr;

    for (const node of nodes) {
      // Skip the dragged node
      if (isDraggingRef.current && node === dragNodeRef.current) continue;

      node.vx *= DAMPING_FACTOR;
      node.vy *= DAMPING_FACTOR;
      node.x += node.vx;
      node.y += node.vy;

      // Keep nodes within canvas bounds with padding
      const pad = node.radius + 10;
      if (node.x < pad) { node.x = pad; node.vx *= -0.5; }
      if (node.x > canvasW - pad) { node.x = canvasW - pad; node.vx *= -0.5; }
      if (node.y < pad) { node.y = pad; node.vy *= -0.5; }
      if (node.y > canvasH - pad) { node.y = canvasH - pad; node.vy *= -0.5; }
    }

    // Decay alpha
    alphaRef.current *= SIMULATION_ALPHA_DECAY;
  }, []);

  // --- Render loop ---
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let running = true;

    const render = () => {
      if (!running) return;

      const dpr = window.devicePixelRatio || 1;
      const width = canvas.width / dpr;
      const height = canvas.height / dpr;

      // Clear
      ctx.clearRect(0, 0, width, height);

      const allNodes = simNodesRef.current;
      const allEdges = edgesRef.current;
      const types = activeTypes;

      // Filter nodes and edges by active types
      const nodes = allNodes.filter((n) => types.has(n.type));
      const visibleNodeIds = new Set(nodes.map((n) => n.id));
      const edges = allEdges.filter(
        (e) => visibleNodeIds.has(e.source) && visibleNodeIds.has(e.target),
      );

      // Show empty state
      if (!isLoading && allNodes.length === 0) {
        ctx.font = "14px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "#999";
        ctx.fillText("\u6682\u65E0\u56FE\u8C31\u6570\u636E", width / 2, height / 2);
        animFrameRef.current = requestAnimationFrame(render);
        return;
      }

      // Run force simulation step (on all nodes, not just visible)
      simulateStep();

      // Apply zoom/pan transform
      ctx.save();
      ctx.translate(offsetRef.current.x, offsetRef.current.y);
      ctx.scale(scaleRef.current, scaleRef.current);

      // Build node index for edge rendering
      const nodeMap = new Map<string, SimNode>();
      for (const node of nodes) {
        nodeMap.set(node.id, node);
      }

      // --- Draw edges ---
      ctx.lineWidth = 1 / scaleRef.current;
      for (const edge of edges) {
        const src = nodeMap.get(edge.source);
        const tgt = nodeMap.get(edge.target);
        if (!src || !tgt) continue;

        const opacity = getEdgeOpacity(edge.type);
        ctx.strokeStyle = `rgba(150, 150, 150, ${opacity})`;
        ctx.beginPath();
        ctx.moveTo(src.x, src.y);
        ctx.lineTo(tgt.x, tgt.y);
        ctx.stroke();
      }

      // --- Draw nodes ---
      for (const node of nodes) {
        const color = getNodeColor(node.type);
        const isHovered = hoveredNodeRef.current === node;

        // Node circle
        ctx.beginPath();
        ctx.arc(node.x, node.y, isHovered ? node.radius + 3 : node.radius, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.globalAlpha = isHovered ? 1.0 : 0.85;
        ctx.fill();
        ctx.globalAlpha = 1.0;

        // Border
        if (isHovered) {
          ctx.strokeStyle = "#fff";
          ctx.lineWidth = 2 / scaleRef.current;
          ctx.stroke();
        } else {
          ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
          ctx.lineWidth = 1 / scaleRef.current;
          ctx.stroke();
        }

        // Label
        const label = truncateLabel(node.label);
        ctx.font = `${11 / scaleRef.current}px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillStyle = "#ddd";
        ctx.fillText(label, node.x, node.y + node.radius + 4 / scaleRef.current);
      }

      ctx.restore();

      // --- Draw stats overlay ---
      if (stats) {
        ctx.font = "11px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.fillStyle = "#888";
        ctx.fillText(
          `\u8282\u70B9: ${stats.nodeCount}  \u8FB9: ${stats.edgeCount}`,
          12,
          12,
        );
      }

      animFrameRef.current = requestAnimationFrame(render);
    };

    animFrameRef.current = requestAnimationFrame(render);

    return () => {
      running = false;
      cancelAnimationFrame(animFrameRef.current);
    };
  }, [isLoading, stats, simulateStep, activeTypes]);

  // =====================================================================
  // Render
  // =====================================================================

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        height: "100%",
        position: "relative",
        backgroundColor: "var(--bg-primary)",
        overflow: "hidden",
      }}
    >
      {/* Loading state */}
      {isLoading && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            backgroundColor: "rgba(0, 0, 0, 0.3)",
            zIndex: 2,
          }}
        >
          <Spinner size="lg" />
        </div>
      )}

      {/* Error state */}
      {error && !isLoading && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            alignItems: "center",
            gap: "var(--space-3)",
            color: "var(--text-tertiary)",
            zIndex: 2,
          }}
        >
          <AlertCircle size={40} style={{ opacity: 0.4, color: "var(--error)" }} />
          <p
            style={{
              fontSize: "var(--text-sm)",
              color: "var(--text-tertiary)",
              margin: 0,
            }}
          >
            {"\u52A0\u8F7D\u56FE\u8C31\u5931\u8D25"}
          </p>
          <p
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--text-tertiary)",
              margin: 0,
            }}
          >
            {error}
          </p>
          <button
            onClick={fetchGraph}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "var(--space-1)",
              padding: "var(--space-2) var(--space-3)",
              fontSize: "var(--text-sm)",
              border: "1px solid var(--border-primary)",
              borderRadius: "var(--radius-md)",
              background: "var(--surface-primary)",
              color: "var(--text-secondary)",
              cursor: "pointer",
              transition:
                "background-color var(--transition-fast), color var(--transition-fast)",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = "var(--bg-hover)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = "var(--surface-primary)";
            }}
          >
            <RefreshCw size={14} />
            {"\u91CD\u8BD5"}
          </button>
        </div>
      )}

      {/* Canvas */}
      <canvas
        ref={canvasRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onWheel={handleWheel}
        style={{
          display: "block",
          width: "100%",
          height: "100%",
          cursor: "grab",
        }}
      />

      {/* Node type filter controls */}
      <div
        style={{
          position: "absolute",
          top: 8,
          right: 8,
          display: "flex",
          gap: 4,
          zIndex: 3,
        }}
      >
        {Object.entries(NODE_COLORS).map(([type, color]) => (
          <button
            key={type}
            onClick={() => {
              setActiveTypes((prev) => {
                const next = new Set(prev);
                if (next.has(type)) {
                  // Don't allow deselecting all
                  if (next.size > 1) next.delete(type);
                } else {
                  next.add(type);
                }
                return next;
              });
            }}
            style={{
              padding: "4px 8px",
              fontSize: 11,
              borderRadius: 4,
              border: `1px solid ${activeTypes.has(type) ? color : "var(--border-primary)"}`,
              background: activeTypes.has(type) ? `${color}22` : "var(--surface-primary)",
              color: activeTypes.has(type) ? color : "var(--text-tertiary)",
              cursor: "pointer",
              transition: "all 0.15s",
              fontWeight: activeTypes.has(type) ? 600 : 400,
            }}
          >
            {type === "document" ? "文档" : type === "entity" ? "实体" : "概念"}
          </button>
        ))}
      </div>

      {/* Zoom controls */}
      <div
        style={{
          position: "absolute",
          bottom: 8,
          right: 8,
          display: "flex",
          flexDirection: "column",
          gap: 2,
          zIndex: 3,
        }}
      >
        <button
          onClick={() => { scaleRef.current = Math.min(scaleRef.current * 1.2, 5.0); }}
          style={{
            width: 28, height: 28, borderRadius: 4, border: "1px solid var(--border-primary)",
            background: "var(--surface-primary)", color: "var(--text-secondary)",
            cursor: "pointer", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          +
        </button>
        <button
          onClick={() => {
            scaleRef.current = 1.0;
            offsetRef.current = { x: 0, y: 0 };
          }}
          style={{
            width: 28, height: 28, borderRadius: 4, border: "1px solid var(--border-primary)",
            background: "var(--surface-primary)", color: "var(--text-secondary)",
            cursor: "pointer", fontSize: 9, display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          FIT
        </button>
        <button
          onClick={() => { scaleRef.current = Math.max(scaleRef.current / 1.2, 0.1); }}
          style={{
            width: 28, height: 28, borderRadius: 4, border: "1px solid var(--border-primary)",
            background: "var(--surface-primary)", color: "var(--text-secondary)",
            cursor: "pointer", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          -
        </button>
      </div>
    </div>
  );
}

export default KnowledgeGraph;
