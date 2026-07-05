// =============================================================================
// DeepAnalyze - SessionsPanel Component
// Session list for the right-side panel
// =============================================================================

import React, { useState, useEffect, useCallback, useMemo, useDeferredValue } from "react";
import { useChatStore } from "../../store/chat";
import { useUIStore } from "../../store/ui";
import { useToast } from "../../hooks/useToast";
import { useConfirm } from "../../hooks/useConfirm";
import { api } from "../../api/client";
import { Spinner } from "../ui/Spinner";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import type { SessionInfo } from "../../types/index";
import {
  MessageSquare,
  Plus,
  Trash2,
  RefreshCw,
  Search,
  Inbox,
} from "lucide-react";

function SessionsPanelInner() {
  const { success, error: toastError } = useToast();
  const confirm = useConfirm();
  const selectSession = useChatStore((s) => s.selectSession);
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const closeRightPanel = useUIStore((s) => s.closeRightPanel);

  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadSessions = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const data = await api.listSessions();
      setSessions(data);
    } catch {
      toastError("加载会话失败");
    } finally {
      if (showLoading) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadSessions(true);
  }, [loadSessions]);

  const handleNewChat = async () => {
    try {
      const session = await api.createSession();
      selectSession(session.id);
      window.location.hash = "#/chat";
      closeRightPanel();
      success("已创建新对话");
    } catch {
      toastError("创建会话失败");
    }
  };

  const handleSelectSession = (id: string) => {
    selectSession(id);
    window.location.hash = "#/sessions/" + id;
    closeRightPanel();
  };

  const handleDelete = async (id: string, title: string) => {
    const ok = await confirm({
      title: "删除会话",
      message: `确定要删除「${title || "未命名会话"}」吗？`,
      variant: "danger",
    });
    if (!ok) return;
    setDeletingId(id);
    try {
      await api.deleteSession(id);
      setSessions((prev) => prev.filter((s) => s.id !== id));
      success("会话已删除");
    } catch {
      toastError("删除失败");
    } finally {
      setDeletingId(null);
    }
  };

  // Filter sessions by search query (deferred for performance)
  const deferredQuery = useDeferredValue(searchQuery);
  const filteredSessions = useMemo(() => {
    if (!deferredQuery.trim()) return sessions;
    const q = deferredQuery.toLowerCase();
    return sessions.filter((s) =>
      (s.title || "新对话").toLowerCase().includes(q)
    );
  }, [sessions, deferredQuery]);

  // --- Loading state ---
  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "var(--space-8)" }}>
        <Spinner size="md" />
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: "var(--space-3)" }}>
      {/* Toolbar */}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flexShrink: 0 }}>
        {/* Search */}
        <div style={{ flex: 1, position: "relative" }}>
          <Search
            size={14}
            style={{
              position: "absolute",
              left: 10,
              top: "50%",
              transform: "translateY(-50%)",
              color: "var(--text-tertiary)",
              pointerEvents: "none",
            }}
          />
          <input
            type="text"
            placeholder="搜索会话..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              width: "100%",
              height: 32,
              padding: "0 var(--space-3) 0 30px",
              background: "var(--bg-tertiary)",
              border: "1px solid var(--border-primary)",
              borderRadius: "var(--radius-md)",
              color: "var(--text-primary)",
              fontSize: "var(--text-sm)",
              outline: "none",
            }}
          />
        </div>
        <Button variant="secondary" size="sm" icon={<RefreshCw size={14} />} onClick={() => loadSessions()}>
          刷新
        </Button>
        <Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={handleNewChat}>
          新建
        </Button>
      </div>

      {/* Stats */}
      <div style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)", flexShrink: 0 }}>
        共 {sessions.length} 个会话
        {searchQuery && ` · 匹配 ${filteredSessions.length} 个`}
      </div>

      {/* Session list */}
      <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden" }}>
        {filteredSessions.length === 0 ? (
          <EmptyState
            icon={<Inbox size={24} />}
            title={searchQuery ? "没有匹配的会话" : "暂无会话"}
            description={searchQuery ? "尝试其他关键词" : "点击上方「新建」按钮开始"}
          />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {filteredSessions.map((session) => {
              const isActive = session.id === currentSessionId;
              const isDeleting = session.id === deletingId;
              return (
                <div
                  key={session.id}
                  onClick={() => handleSelectSession(session.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--space-2)",
                    padding: "8px 10px",
                    borderRadius: "var(--radius-md)",
                    cursor: "pointer",
                    fontSize: "var(--text-sm)",
                    color: isActive ? "var(--brand-primary)" : "var(--text-secondary)",
                    background: isActive ? "var(--brand-light)" : "transparent",
                    transition: "all var(--transition-fast)",
                    position: "relative",
                  }}
                  onMouseEnter={(e) => {
                    if (!isActive) {
                      e.currentTarget.style.background = "var(--bg-hover)";
                      e.currentTarget.style.color = "var(--text-primary)";
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive) {
                      e.currentTarget.style.background = "transparent";
                      e.currentTarget.style.color = "var(--text-secondary)";
                    }
                  }}
                >
                  {/* Active indicator */}
                  {isActive && (
                    <div style={{
                      position: "absolute",
                      left: 0, top: 4, bottom: 4, width: 2,
                      borderRadius: "0 2px 2px 0",
                      background: "var(--brand-primary)",
                    }} />
                  )}
                  <MessageSquare size={14} style={{ flexShrink: 0, opacity: 0.6 }} />
                  <span style={{
                    flex: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    minWidth: 0,
                  }}>
                    {session.title || "新对话"}
                  </span>
                  {/* Delete button */}
                  {!isDeleting && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(session.id, session.title || "");
                      }}
                      title="删除会话"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        padding: 2,
                        border: "none",
                        borderRadius: "var(--radius-sm)",
                        background: "transparent",
                        color: "var(--text-tertiary)",
                        cursor: "pointer",
                        flexShrink: 0,
                        opacity: 0,
                        transition: "all var(--transition-fast)",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.color = "var(--error)";
                        e.currentTarget.style.opacity = "1";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.color = "var(--text-tertiary)";
                        e.currentTarget.style.opacity = "0";
                      }}
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                  {isDeleting && <Spinner size="sm" />}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export const SessionsPanel = React.memo(SessionsPanelInner);
