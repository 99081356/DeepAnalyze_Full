// =============================================================================
// DeepAnalyze - WebSocket Handler Module
// Manages real-time communication for document processing status updates.
// Clients subscribe to knowledge base IDs and receive progress events.
// =============================================================================

import { EventEmitter } from "events";

// ---------------------------------------------------------------------------
// Global workflow event bus
// ---------------------------------------------------------------------------

declare global {
  var __workflowEvents: EventEmitter | undefined;
}

// Initialize global event bus for workflow events
if (!globalThis.__workflowEvents) {
  globalThis.__workflowEvents = new EventEmitter();
}

// ---------------------------------------------------------------------------
// Types — Server-to-client message variants
// ---------------------------------------------------------------------------

export type WsServerMessage =
  | { type: "doc_upload_progress"; kbId: string; docId: string; progress: number }
  | { type: "doc_processing_step"; kbId: string; docId: string; step: string; progress: number; subStep?: string; filename?: string; status?: string; message?: string }
  | { type: "doc_level_ready"; kbId: string; docId: string; level: "L0" | "L1" | "L2" }
  | { type: "doc_ready"; kbId: string; docId: string; filename: string }
  | { type: "doc_error"; kbId: string; docId: string; error: string }
  | { type: "workflow_start"; workflowId: string; teamName: string; mode: string; agentCount: number }
  | { type: "workflow_agent_start"; workflowId: string; agentId: string; role: string; task: string }
  | { type: "workflow_agent_tool_call"; workflowId: string; agentId: string; tool: string; args: Record<string, unknown> }
  | { type: "workflow_agent_tool_result"; workflowId: string; agentId: string; tool: string; result: string }
  | { type: "workflow_agent_chunk"; workflowId: string; agentId: string; chunk: string }
  | { type: "workflow_agent_complete"; workflowId: string; agentId: string; status: string; duration: number }
  | { type: "workflow_complete"; workflowId: string; status: string; totalDuration: number; resultCount: number }
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
// Client state
// ---------------------------------------------------------------------------

interface ClientState {
  /** Set of KB IDs this client is subscribed to. */
  subscriptions: Set<string>;
  /** Set of workflow IDs this client is subscribed to. */
  workflowSubscriptions: Set<string>;
}

// ---------------------------------------------------------------------------
// Connection tracking
// ---------------------------------------------------------------------------

/**
 * Map of connected WebSocket clients to their subscription state.
 * Keyed by the WebSocket instance itself.
 */
const clients = new Map<WebSocket, ClientState>();

/**
 * Map of WebSocket clients to their workflow event handlers.
 * Used to clean up event listeners when a client disconnects.
 */
const workflowHandlers = new Map<WebSocket, (event: any) => void>();

// ---------------------------------------------------------------------------
// WebSocket lifecycle handlers
// ---------------------------------------------------------------------------

/**
 * Called when a new WebSocket connection is opened.
 * Initializes empty subscription state for the client.
 */
export function handleOpen(ws: WebSocket): void {
  clients.set(ws, { subscriptions: new Set(), workflowSubscriptions: new Set() });
  console.log(`[WS] Client connected. Total clients: ${clients.size}`);

  // Subscribe to workflow events and forward only matching events to this client
  const workflowHandler = (event: any) => {
    const state = clients.get(ws);
    if (!state) return;
    // Only forward if client has explicitly subscribed to this workflow.
    // Empty workflowSubscriptions means no subscriptions — do NOT forward all events
    // (prevents cross-session event leakage where all tabs receive all workflow events).
    const wfId = event.workflowId as string | undefined;
    if (!wfId || state.workflowSubscriptions.size === 0 || !state.workflowSubscriptions.has(wfId)) {
      return;
    }
    console.log(
      `[WS] forward workflow event type=${event.type ?? "(none)"} wfId=${wfId} to 1 subscribed client (total clients: ${clients.size})`,
    );
    try { ws.send(JSON.stringify(event)); } catch { /* ignore */ }
  };
  globalThis.__workflowEvents?.on("workflow", workflowHandler);
  workflowHandlers.set(ws, workflowHandler);
}

/**
 * Called when a message is received from a connected client.
 * Parses JSON and dispatches to subscribe / unsubscribe / ping handlers.
 */
export function handleMessage(ws: WebSocket, raw: string | Buffer): void {
  let msg: WsClientMessage;
  try {
    msg = JSON.parse(typeof raw === "string" ? raw : raw.toString()) as WsClientMessage;
  } catch {
    console.warn("[WS] Received non-JSON message, ignoring");
    return;
  }

  const state = clients.get(ws);
  if (!state) {
    console.warn("[WS] Message from unknown client, closing");
    ws.close(4003, "Unknown client");
    return;
  }

  switch (msg.type) {
    case "subscribe": {
      if (!Array.isArray(msg.kbIds) || msg.kbIds.length === 0) {
        console.warn("[WS] Subscribe message missing kbIds array");
        return;
      }
      for (const kbId of msg.kbIds) {
        state.subscriptions.add(kbId);
      }
      console.log(`[WS] Client subscribed to ${msg.kbIds.length} KB(s). Subscriptions: ${state.subscriptions.size}`);
      break;
    }

    case "unsubscribe": {
      if (!Array.isArray(msg.kbIds)) {
        return;
      }
      for (const kbId of msg.kbIds) {
        state.subscriptions.delete(kbId);
      }
      console.log(`[WS] Client unsubscribed from ${msg.kbIds.length} KB(s). Subscriptions: ${state.subscriptions.size}`);
      break;
    }

    case "subscribe_workflow": {
      if (!Array.isArray(msg.workflowIds) || msg.workflowIds.length === 0) {
        return;
      }
      for (const wfId of msg.workflowIds) {
        state.workflowSubscriptions.add(wfId);
      }
      console.log(`[WS] Client subscribed to ${msg.workflowIds.length} workflow(s)`);
      break;
    }

    case "unsubscribe_workflow": {
      if (!Array.isArray(msg.workflowIds)) {
        return;
      }
      for (const wfId of msg.workflowIds) {
        state.workflowSubscriptions.delete(wfId);
      }
      break;
    }

    case "ping": {
      ws.send(JSON.stringify({ type: "pong" } satisfies WsServerMessage));
      break;
    }

    default: {
      console.warn(`[WS] Unknown message type: ${(msg as Record<string, unknown>).type}`);
      break;
    }
  }
}

/**
 * Called when a WebSocket connection is closed.
 * Cleans up client state from the connection map.
 */
export function handleClose(ws: WebSocket): void {
  const state = clients.get(ws);
  if (state) {
    console.log(
      `[WS] Client disconnected. Had ${state.subscriptions.size} KB subscription(s). Total clients: ${clients.size - 1}`,
    );
  }
  // Clean up workflow event listener
  const workflowHandler = workflowHandlers.get(ws);
  if (workflowHandler) {
    globalThis.__workflowEvents?.off("workflow", workflowHandler);
    workflowHandlers.delete(ws);
  }
  clients.delete(ws);
}

// ---------------------------------------------------------------------------
// Broadcast helper
// ---------------------------------------------------------------------------

/**
 * Sends a JSON-encoded message to every client currently subscribed to the
 * given knowledge base ID.
 */
export function broadcastToKb(kbId: string, message: WsServerMessage): void {
  const payload = JSON.stringify(message);
  let recipientCount = 0;

  for (const [ws, state] of clients) {
    if (state.subscriptions.has(kbId)) {
      try {
        ws.send(payload);
        recipientCount++;
      } catch (err) {
        console.error("[WS] Failed to send to client, removing", err);
        // Clean up workflow handler too
        const workflowHandler = workflowHandlers.get(ws);
        if (workflowHandler) {
          globalThis.__workflowEvents?.off("workflow", workflowHandler);
          workflowHandlers.delete(ws);
        }
        clients.delete(ws);
      }
    }
  }

  if (recipientCount > 0) {
    console.log(`[WS] Broadcast "${message.type}" to ${recipientCount} client(s) for KB ${kbId}`);
  }
}

// ---------------------------------------------------------------------------
// Utility — get count of connected clients (useful for health checks)
// ---------------------------------------------------------------------------

export function getConnectedClientCount(): number {
  return clients.size;
}
