// =============================================================================
// DeepAnalyze - Knowledge Base WebSocket Hook
// Manages a WebSocket connection for document processing status updates.
// Auto-connects, auto-reconnects with exponential backoff, sends heartbeats.
// =============================================================================

import { useRef, useCallback, useEffect, useState } from "react";
import { useWorkflowStore } from "../store/workflow.js";

// ---------------------------------------------------------------------------
// Types — Server-to-client message variants
// ---------------------------------------------------------------------------

export type WsServerMessage =
  | { type: "doc_upload_progress"; kbId: string; docId: string; progress: number }
  | { type: "doc_processing_step"; kbId: string; docId: string; step: string; progress: number; subStep?: string; filename?: string; status?: string; message?: string }
  | { type: "doc_ready"; kbId: string; docId: string; filename: string }
  | { type: "doc_level_ready"; kbId: string; docId: string; level: "L0" | "L1" | "L2" }
  | { type: "doc_error"; kbId: string; docId: string; error: string }
  | { type: "workflow_start"; workflowId: string; teamName: string; mode: string; agentCount: number; goal?: string; sessionId?: string; parentTaskId?: string }
  | { type: "workflow_agent_start"; workflowId: string; agentId: string; role: string; task: string }
  | { type: "workflow_agent_tool_call"; workflowId: string; agentId: string; tool: string; args: Record<string, unknown> }
  | { type: "workflow_agent_tool_result"; workflowId: string; agentId: string; tool: string; result: string }
  | { type: "workflow_agent_chunk"; workflowId: string; agentId: string; chunk: string }
  | { type: "workflow_agent_complete"; workflowId: string; agentId: string; status: string; duration: number }
  | { type: "workflow_complete"; workflowId: string; status: string; totalDuration: number; resultCount: number; sessionId?: string; parentTaskId?: string }
  | { type: "pong" };

// ---------------------------------------------------------------------------
// Types — Client-to-server message variants
// ---------------------------------------------------------------------------

type WsClientMessage =
  | { type: "subscribe"; kbIds: string[] }
  | { type: "unsubscribe"; kbIds: string[] }
  | { type: "subscribe_workflow"; workflowIds: string[] }
  | { type: "unsubscribe_workflow"; workflowIds: string[] }
  | { type: "ping" };

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

interface UseWebSocketOptions {
  /** Called when a server message arrives (except pong). */
  onMessage?: (msg: WsServerMessage) => void;
  /** Override the default WebSocket URL. */
  url?: string;
}

// ---------------------------------------------------------------------------
// Return type
// ---------------------------------------------------------------------------

interface UseWebSocketReturn {
  /** True when the WebSocket is open and ready. */
  connected: boolean;
  /** Subscribe to processing events for the given KB IDs. */
  subscribe: (kbIds: string[]) => void;
  /** Unsubscribe from processing events for the given KB IDs. */
  unsubscribe: (kbIds: string[]) => void;
  /** Subscribe to workflow events for the given workflow IDs. */
  subscribeWorkflow: (workflowIds: string[]) => void;
  /** Unsubscribe from workflow events for the given workflow IDs. */
  unsubscribeWorkflow: (workflowIds: string[]) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HEARTBEAT_INTERVAL_MS = 30_000;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

// ---------------------------------------------------------------------------
// Module-level singleton: prevents duplicate connections across React
// StrictMode double-mounting and across hook instances.
// ---------------------------------------------------------------------------

let activeSocket: WebSocket | null = null;
let activeRefCount = 0;

// Module-level workflow subscription set — shared between the hook and
// standalone functions so that non-hook code (e.g. chat store) can
// subscribe/unsubscribe to workflow events without a React context.
const workflowSubscriptionIds = new Set<string>();

/**
 * Check if the WebSocket singleton is currently connected.
 * Safe to call from any component without creating a new connection.
 */
export function isWsConnected(): boolean {
  return activeSocket?.readyState === WebSocket.OPEN;
}

/**
 * Subscribe to workflow events for the given workflow IDs via the singleton WS.
 * Safe to call from outside React components (e.g. Zustand stores).
 */
export function wsSubscribeWorkflow(workflowIds: string[]): void {
  for (const wfId of workflowIds) {
    workflowSubscriptionIds.add(wfId);
  }
  if (activeSocket?.readyState === WebSocket.OPEN) {
    activeSocket.send(JSON.stringify({ type: "subscribe_workflow", workflowIds } satisfies WsClientMessage));
  }
}

/**
 * Unsubscribe from workflow events for the given workflow IDs via the singleton WS.
 * Safe to call from outside React components (e.g. Zustand stores).
 */
export function wsUnsubscribeWorkflow(workflowIds: string[]): void {
  for (const wfId of workflowIds) {
    workflowSubscriptionIds.delete(wfId);
  }
  if (activeSocket?.readyState === WebSocket.OPEN) {
    activeSocket.send(JSON.stringify({ type: "unsubscribe_workflow", workflowIds } satisfies WsClientMessage));
  }
}

// ---------------------------------------------------------------------------
// Workflow event dispatcher
// ---------------------------------------------------------------------------

/**
 * Dispatches workflow_* WebSocket events to the workflow store.
 * Called from the WebSocket onmessage handler so that workflow events
 * received on the same connection as doc events are automatically routed.
 */
function handleWorkflowWsEvent(msg: WsServerMessage): void {
  const wfStore = useWorkflowStore.getState();

  switch (msg.type) {
    case "workflow_start":
      wfStore.handleWorkflowStart(msg);
      break;
    case "workflow_agent_start":
      wfStore.handleAgentStart(msg);
      break;
    case "workflow_agent_tool_call":
      wfStore.handleAgentToolCall({
        workflowId: msg.workflowId,
        agentId: msg.agentId,
        toolName: msg.tool,
        input: msg.args,
      });
      break;
    case "workflow_agent_tool_result":
      wfStore.handleAgentToolResult({
        workflowId: msg.workflowId,
        agentId: msg.agentId,
        toolName: msg.tool,
        output: msg.result,
      });
      break;
    case "workflow_agent_chunk":
      wfStore.handleAgentChunk({
        workflowId: msg.workflowId,
        agentId: msg.agentId,
        content: msg.chunk,
      });
      break;
    case "workflow_agent_complete":
      wfStore.handleAgentComplete({
        workflowId: msg.workflowId,
        agentId: msg.agentId,
        duration: msg.duration,
        ...(msg.status === "error" || msg.status === "failed" ? { error: msg.status } : {}),
      });
      break;
    case "workflow_complete":
      wfStore.handleWorkflowComplete({
        workflowId: msg.workflowId,
        status: msg.status,
        duration: msg.totalDuration,
      });
      break;
    default:
      // Not a workflow event — ignore
      break;
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useWebSocket(options: UseWebSocketOptions = {}): UseWebSocketReturn {
  const { onMessage, url } = options;

  const wsRef = useRef<WebSocket | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptsRef = useRef(0);
  const mountedRef = useRef(true);
  const subscriptionsRef = useRef<Set<string>>(new Set());

  const [connected, setConnected] = useState(false);

  // Keep onMessage ref current without triggering reconnects
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  // Resolve the WebSocket URL
  const wsUrl = useRef(url);
  if (url !== undefined && wsUrl.current !== url) {
    wsUrl.current = url;
  }
  if (!wsUrl.current) {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    wsUrl.current = `${proto}//${window.location.host}/ws`;
  }

  // ----- helpers -----

  const clearHeartbeat = useCallback(() => {
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
  }, []);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  // ----- connect -----

  const connect = useCallback(() => {
    // Prevent duplicate connections — reuse the module-level singleton if active
    if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
      wsRef.current = activeSocket;
      return;
    }

    // Clean up any existing socket
    if (wsRef.current) {
      wsRef.current.onopen = null;
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      wsRef.current.onmessage = null;
      wsRef.current.close();
      wsRef.current = null;
    }

    clearHeartbeat();
    clearReconnectTimer();

    const ws = new WebSocket(wsUrl.current!);
    wsRef.current = ws;
    activeSocket = ws;

    ws.onopen = () => {
      if (!mountedRef.current) return;
      setConnected(true);
      attemptsRef.current = 0;

      // Re-subscribe to any previously tracked KB IDs
      if (subscriptionsRef.current.size > 0) {
        const ids = Array.from(subscriptionsRef.current);
        ws.send(JSON.stringify({ type: "subscribe", kbIds: ids } satisfies WsClientMessage));
      }

      // Re-subscribe to any previously tracked workflow IDs
      if (workflowSubscriptionIds.size > 0) {
        const wfIds = Array.from(workflowSubscriptionIds);
        ws.send(JSON.stringify({ type: "subscribe_workflow", workflowIds: wfIds } satisfies WsClientMessage));
      }

      // Start heartbeat
      heartbeatRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" } satisfies WsClientMessage));
        }
      }, HEARTBEAT_INTERVAL_MS);
    };

    ws.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data) as WsServerMessage;
        if (msg.type !== "pong") {
          onMessageRef.current?.(msg);
        }
        // Dispatch workflow events to the workflow store
        handleWorkflowWsEvent(msg);
      } catch (err) {
        console.error("[KnowledgeWS] Failed to parse message:", err);
      }
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      setConnected(false);
      clearHeartbeat();

      // Exponential backoff: 1s -> 2s -> 4s -> ... -> max 30s
      const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attemptsRef.current), MAX_DELAY_MS);
      attemptsRef.current += 1;

      reconnectTimerRef.current = setTimeout(() => {
        if (mountedRef.current) {
          connect();
        }
      }, delay);
    };

    ws.onerror = () => {
      console.error("[KnowledgeWS] Connection error");
    };
  }, [clearHeartbeat, clearReconnectTimer]);

  // ----- subscribe / unsubscribe -----

  const subscribe = useCallback((kbIds: string[]) => {
    for (const kbId of kbIds) {
      subscriptionsRef.current.add(kbId);
    }
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "subscribe", kbIds } satisfies WsClientMessage));
    }
  }, []);

  const unsubscribe = useCallback((kbIds: string[]) => {
    for (const kbId of kbIds) {
      subscriptionsRef.current.delete(kbId);
    }
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "unsubscribe", kbIds } satisfies WsClientMessage));
    }
  }, []);

  const subscribeWorkflow = useCallback((workflowIds: string[]) => {
    wsSubscribeWorkflow(workflowIds);
  }, []);

  const unsubscribeWorkflow = useCallback((workflowIds: string[]) => {
    wsUnsubscribeWorkflow(workflowIds);
  }, []);

  // ----- lifecycle -----

  useEffect(() => {
    mountedRef.current = true;
    activeRefCount++;
    connect();
    return () => {
      mountedRef.current = false;
      activeRefCount--;
      clearHeartbeat();
      clearReconnectTimer();
      // Only close the socket when the last consumer unmounts
      if (activeRefCount <= 0 && wsRef.current) {
        wsRef.current.onopen = null;
        wsRef.current.onclose = null;
        wsRef.current.onerror = null;
        wsRef.current.onmessage = null;
        wsRef.current.close();
        wsRef.current = null;
        activeSocket = null;
      }
    };
  }, [connect, clearHeartbeat, clearReconnectTimer]);

  return { connected, subscribe, unsubscribe, subscribeWorkflow, unsubscribeWorkflow };
}
