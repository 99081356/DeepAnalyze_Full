import { useState, useRef, useCallback, useEffect } from "react";
import { useChatStore } from "../../store/chat";
import { useVoiceInput } from "../../hooks/useVoiceInput";
import { useChatMedia } from "../../hooks/useChatMedia.js";
import { Send, Square, Paperclip, Mic, MicOff, Loader2, FileText } from "lucide-react";
import type { AnalysisScope } from "../../types/index";

export function MessageInput({ scope }: { scope?: AnalysisScope }) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const stopStreaming = useChatStore((s) => s.stopStreaming);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const { pendingMedia, addFiles: addMediaFiles, remove: removeMedia, uploadAll: uploadMediaAll, clearDone: clearMediaDone, hasPending: hasMediaPending } = useChatMedia();
  const voice = useVoiceInput();

  // Clear input text when switching sessions to prevent text leaking across sessions
  const prevSessionRef = useRef<string | null>(currentSessionId);
  useEffect(() => {
    if (currentSessionId !== prevSessionRef.current) {
      prevSessionRef.current = currentSessionId;
      setText("");
    }
  }, [currentSessionId]);

  // Handle voice transcription result
  const handleVoiceResult = useCallback((transcribedText: string | null) => {
    if (transcribedText) {
      setText((prev) => {
        const separator = prev.trim().length > 0 ? " " : "";
        return prev + separator + transcribedText;
      });
    }
  }, []);

  const canSend = (text.trim().length > 0 || pendingMedia.length > 0) && !!currentSessionId;

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
    }
  }, [text]);

  const handleSend = useCallback(async () => {
    const content = text.trim();
    if (!content && pendingMedia.length === 0) return;

    setText("");

    // Upload pending media first
    let uploadedMediaIds: string[] = [];
    if (pendingMedia.length > 0 && currentSessionId) {
      uploadedMediaIds = await uploadMediaAll(currentSessionId);
      if (uploadedMediaIds.length === 0 && pendingMedia.some(m => m.status === "error")) {
        setText(content);
        return;
      }
    }

    clearMediaDone();

    // Always send as a new message — parallel execution is supported.
    // Each sendMessage call gets its own SSE stream and assistant message.
    const mediaAttachments = uploadedMediaIds.length > 0
      ? uploadedMediaIds.map(id => {
          const item = pendingMedia.find(m => m.mediaId === id);
          return {
            mediaId: id,
            fileName: item?.file.name ?? "unknown",
            mimeType: item?.file.type ?? "application/octet-stream",
            size: item?.file.size ?? 0,
          };
        })
      : undefined;
    sendMessage(content, scope, uploadedMediaIds.length > 0 ? uploadedMediaIds : undefined, mediaAttachments);
    textareaRef.current?.focus();
  }, [text, pendingMedia, currentSessionId, scope, sendMessage, uploadMediaAll, clearMediaDone]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer.files.length > 0) {
          addMediaFiles(e.dataTransfer.files);
        }
      }}
      style={{
        flexShrink: 0,
        borderTop: "1px solid var(--border-primary)",
        background: "var(--bg-secondary)",
        padding: "var(--space-4) var(--space-5)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          gap: "var(--space-3)",
          maxWidth: 800,
          margin: "0 auto",
        }}
      >
        {/* Attach button */}
        <button
          title="添加附件"
          onClick={() => {
            const input = document.createElement("input");
            input.type = "file";
            input.multiple = true;
            input.accept = "*/*";
            input.onchange = (e) => {
              const files = (e.target as HTMLInputElement).files;
              if (files) addMediaFiles(files);
            };
            input.click();
          }}
          style={{
            width: 36,
            height: 36,
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "1px solid var(--border-primary)",
            borderRadius: "var(--radius-xl)",
            background: "var(--surface-primary)",
            color: "var(--text-tertiary)",
            cursor: "pointer",
            transition: "all var(--transition-fast)",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = "var(--interactive)";
            e.currentTarget.style.color = "var(--interactive)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = "var(--border-primary)";
            e.currentTarget.style.color = "var(--text-tertiary)";
          }}
        >
          <Paperclip size={16} />
        </button>

        {/* Textarea */}
        <div style={{ flex: 1, position: "relative" }}>
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={voice.state === "recording" ? "正在录音..." : voice.state === "transcribing" ? "正在转写..." : "输入消息... (Enter 发送, Shift+Enter 换行)"}
            rows={1}
            disabled={voice.state === "transcribing"}
            style={{
              width: "100%",
              padding: "8px 14px",
              background: voice.state === "recording" ? "rgba(239, 68, 68, 0.04)" : "var(--surface-primary)",
              border: voice.state === "recording" ? "1px solid rgba(239, 68, 68, 0.3)" : "1px solid var(--border-primary)",
              borderRadius: "var(--radius-xl)",
              fontSize: "var(--text-sm)",
              color: "var(--text-primary)",
              lineHeight: "var(--leading-normal)",
              resize: "none",
              outline: "none",
              transition: "border-color var(--transition-fast), box-shadow var(--transition-fast)",
              fontFamily: "inherit",
            }}
            onFocus={(e) => {
              if (voice.state !== "recording") {
                e.currentTarget.style.borderColor = "var(--border-focus)";
                e.currentTarget.style.boxShadow = "0 0 0 3px rgba(51, 65, 85, 0.08)";
              }
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = voice.state === "recording" ? "rgba(239, 68, 68, 0.3)" : "var(--border-primary)";
              e.currentTarget.style.boxShadow = "none";
            }}
          />
        </div>

        {/* Microphone button */}
        <button
          onClick={async () => {
            if (voice.state === "idle") {
              voice.start();
            } else if (voice.state === "recording") {
              const result = await voice.stop();
              handleVoiceResult(result);
            }
          }}
          title={voice.state === "idle" ? "语音输入" : voice.state === "recording" ? "停止录音" : "转写中..."}
          disabled={voice.state === "transcribing"}
          style={{
            width: 36,
            height: 36,
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: voice.state === "recording" ? "none" : "1px solid var(--border-primary)",
            borderRadius: "var(--radius-xl)",
            background: voice.state === "recording"
              ? "var(--error)"
              : voice.state === "transcribing"
                ? "var(--surface-primary)"
                : "var(--surface-primary)",
            color: voice.state === "recording"
              ? "#fff"
              : voice.state === "transcribing"
                ? "var(--interactive)"
                : "var(--text-tertiary)",
            cursor: voice.state !== "transcribing" ? "pointer" : "default",
            transition: "all var(--transition-fast)",
            animation: voice.state === "recording" ? "pulse-recording 1.5s ease-in-out infinite" : undefined,
          }}
        >
          {voice.state === "transcribing" ? <Loader2 size={16} className="animate-spin" /> : voice.state === "recording" ? <MicOff size={16} /> : <Mic size={16} />}
        </button>

        {/* Send button — always enabled when there's text or media.
            Parallel sends are supported: each message gets its own SSE stream. */}
        <button
          onClick={handleSend}
          disabled={!canSend}
          title="发送消息"
          style={{
            width: 36,
            height: 36,
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: canSend ? "none" : "1px solid var(--border-primary)",
            borderRadius: "var(--radius-xl)",
            background: canSend ? "var(--brand-primary)" : "var(--surface-primary)",
            color: canSend ? "var(--brand-foreground)" : "var(--text-tertiary)",
            cursor: canSend ? "pointer" : "default",
            transition: "all var(--transition-fast)",
          }}
        >
          <Send size={16} />
        </button>

        {/* Stop button — shown when any task is streaming */}
        {isStreaming && (
          <button
            onClick={stopStreaming}
            title="停止所有任务"
            style={{
              width: 36,
              height: 36,
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              border: "none",
              borderRadius: "var(--radius-xl)",
              background: "var(--error)",
              color: "#fff",
              cursor: "pointer",
              transition: "all var(--transition-fast)",
            }}
          >
            <Square size={14} />
          </button>
        )}
      </div>
      {pendingMedia.length > 0 && (
        <div style={{ display: "flex", gap: "var(--space-2)", padding: "var(--space-2) var(--space-3)", overflowX: "auto", maxWidth: 800, marginLeft: "auto", marginRight: "auto" }}>
          {pendingMedia.map((media) => (
            <div key={media.id} style={{ position: "relative", flexShrink: 0 }} className="group">
              {media.file.type.startsWith("image/") ? (
                <img
                  src={media.previewUrl}
                  alt={media.file.name}
                  style={{ height: 64, width: 64, objectFit: "cover", borderRadius: "var(--radius-md)", border: "1px solid var(--border-primary)" }}
                />
              ) : (
                <div style={{ height: 64, width: 64, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", borderRadius: "var(--radius-md)", border: "1px solid var(--border-primary)", background: "var(--surface-secondary)", padding: 4, overflow: "hidden" }}>
                  <FileText size={18} style={{ color: "var(--text-tertiary)", marginBottom: 2 }} />
                  <span style={{ fontSize: 8, color: "var(--text-tertiary)", textAlign: "center", lineHeight: 1.2, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", wordBreak: "break-all" }}>
                    {media.file.name}
                  </span>
                  <span style={{ fontSize: 7, color: "var(--text-quaternary)" }}>
                    {media.file.size >= 1_000_000 ? `${(media.file.size / 1_000_000).toFixed(1)}M` : `${(media.file.size / 1_000).toFixed(0)}K`}
                  </span>
                </div>
              )}
              {media.status === "uploading" && (
                <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.3)", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "var(--radius-md)" }}>
                  <span style={{ color: "#fff", fontSize: 12 }}>...</span>
                </div>
              )}
              {media.status === "error" && (
                <div style={{ position: "absolute", inset: 0, background: "rgba(239,68,68,0.3)", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "var(--radius-md)" }}>
                  <span style={{ color: "#fff", fontSize: 12 }}>!</span>
                </div>
              )}
              <button
                onClick={() => removeMedia(media.id)}
                style={{
                  position: "absolute",
                  top: -4,
                  right: -4,
                  width: 16,
                  height: 16,
                  borderRadius: "50%",
                  background: "var(--error)",
                  color: "#fff",
                  fontSize: 12,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  border: "none",
                  cursor: "pointer",
                  opacity: 0,
                  transition: "opacity var(--transition-fast)",
                }}
                className="group-hover:!opacity-100"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
