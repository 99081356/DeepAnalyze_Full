import { useEffect, useRef, useCallback } from "react";
import { useChatStore } from "../../store/chat";
import { MessageItem } from "./MessageItem";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { Skeleton } from "../ui/Skeleton";
import { MessageSquare } from "lucide-react";

export function MessageList() {
  const messages = useChatStore((s) => s.messages);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const isSessionLoading = useChatStore((s) => s.isSessionLoading);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);

  // Track scroll position
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el) {
      isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    }
  }, []);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (isAtBottomRef.current && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, isStreaming]);

  // Loading skeleton — shown when session is loading and no messages cached yet
  if (isSessionLoading && messages.length === 0) {
    return <MessageSkeleton />;
  }

  if (messages.length === 0) {
    return (
      <div
        style={{
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div style={{ textAlign: "center", color: "var(--text-tertiary)" }}>
          <MessageSquare size={48} strokeWidth={1} style={{ margin: "0 auto var(--space-3)", opacity: 0.3, display: "block" }} />
          <p style={{ fontSize: "var(--text-sm)", margin: 0 }}>发送一条消息开始对话</p>
          <p style={{ fontSize: "var(--text-xs)", marginTop: 4 }}>
            支持上传文档、检索知识库、生成报告
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      style={{
        height: "100%",
        overflowY: "auto",
        padding: "var(--space-4)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-4)",
      }}
    >
      {messages.map((message) => (
        <MessageItem key={message.id} message={message} />
      ))}
      {isStreaming && <ThinkingIndicator />}
      <div ref={bottomRef} />
    </div>
  );
}

/** Skeleton placeholder shown while session messages are loading */
function MessageSkeleton() {
  const rows = [
    { align: "flex-end", widths: ["60%"] },
    { align: "flex-start", widths: ["80%", "70%", "50%"] },
    { align: "flex-end", widths: ["45%"] },
    { align: "flex-start", widths: ["75%", "60%"] },
  ];

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        padding: "var(--space-4)",
        gap: "var(--space-5)",
      }}
    >
      {rows.map((row, i) => (
        <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: row.align, gap: 6 }}>
          <div
            style={{
              display: "inline-flex",
              flexDirection: "column",
              gap: 6,
              maxWidth: "80%",
              padding: "var(--space-3)",
              borderRadius: "var(--radius-lg)",
              background: "var(--surface-secondary)",
            }}
          >
            {row.widths.map((w, j) => (
              <Skeleton key={j} variant="text" width={w} height={14} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
