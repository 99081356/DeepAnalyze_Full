// =============================================================================
// DeepAnalyze - CronManager Component
// Full cron job management: list, create, edit, delete, execute
// =============================================================================

import { useState, useEffect, useCallback } from "react";
import { api } from "../../api/client";
import type { CronJob, CreateCronJobRequest, UpdateCronJobRequest, CronValidateResult } from "../../types/index";
import { useToast } from "../../hooks/useToast";
import { useUIStore } from "../../store/ui";
import {
  Plus,
  Play,
  Trash2,
  Edit3,
  RefreshCw,
  Clock,
  CheckCircle2,
  XCircle,
  AlertCircle,
  ToggleLeft,
  ToggleRight,
  ChevronDown,
  ChevronUp,
  Copy,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Shared styles
// ---------------------------------------------------------------------------

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "var(--space-2) var(--space-3)",
  border: "1px solid var(--border-primary)",
  borderRadius: "var(--radius-lg)",
  fontSize: "var(--text-sm)",
  background: "var(--bg-primary)",
  color: "var(--text-primary)",
  outline: "none",
  boxSizing: "border-box",
  transition: "border-color var(--transition-fast)",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--font-medium)",
  color: "var(--text-secondary)",
  marginBottom: "var(--space-1)",
};

// ---------------------------------------------------------------------------
// Simple cron schedule presets
// ---------------------------------------------------------------------------

interface SchedulePreset {
  label: string;
  schedule: string;
  description: string;
}

const SCHEDULE_PRESETS: SchedulePreset[] = [
  { label: "每小时", schedule: "0 * * * *", description: "每小时整点" },
  { label: "每6小时", schedule: "0 */6 * * *", description: "每6小时执行" },
  { label: "每天 9:00", schedule: "0 9 * * *", description: "每天上午 9 点" },
  { label: "每天 0:00", schedule: "0 0 * * *", description: "每天午夜" },
  { label: "每周一 9:00", schedule: "0 9 * * 1", description: "每周一上午 9 点" },
  { label: "每月1日 9:00", schedule: "0 9 1 * *", description: "每月1日上午 9 点" },
  { label: "每15分钟", schedule: "*/15 * * * *", description: "每15分钟" },
  { label: "每30分钟", schedule: "*/30 * * * *", description: "每30分钟" },
];

// ---------------------------------------------------------------------------
// CronBuilder — simple GUI + raw expression input
// ---------------------------------------------------------------------------

function CronBuilder({
  value,
  onChange,
  validation,
}: {
  value: string;
  onChange: (v: string) => void;
  validation: CronValidateResult | null;
}) {
  const [mode, setMode] = useState<"simple" | "advanced">("simple");
  const [minute, setMinute] = useState("0");
  const [hour, setHour] = useState("9");
  const [day, setDay] = useState("*");
  const [month, setMonth] = useState("*");
  const [weekday, setWeekday] = useState("*");

  const buildExpression = useCallback(
    (m: string, h: string, d: string, mo: string, w: string) => {
      return `${m} ${h} ${d} ${mo} ${w}`;
    },
    [],
  );

  const handlePartChange = (
    part: "minute" | "hour" | "day" | "month" | "weekday",
    v: string,
  ) => {
    const updates = { minute, hour, day, month, weekday, [part]: v };
    const expr = buildExpression(updates.minute, updates.hour, updates.day, updates.month, updates.weekday);
    switch (part) {
      case "minute": setMinute(v); break;
      case "hour": setHour(v); break;
      case "day": setDay(v); break;
      case "month": setMonth(v); break;
      case "weekday": setWeekday(v); break;
    }
    onChange(expr);
  };

  const handlePreset = (preset: SchedulePreset) => {
    const parts = preset.schedule.split(/\s+/);
    setMinute(parts[0] ?? "*");
    setHour(parts[1] ?? "*");
    setDay(parts[2] ?? "*");
    setMonth(parts[3] ?? "*");
    setWeekday(parts[4] ?? "*");
    onChange(preset.schedule);
  };

  // Sync from value when switching to advanced
  const handleModeSwitch = (m: "simple" | "advanced") => {
    if (m === "simple") {
      const parts = value.trim().split(/\s+/);
      if (parts.length === 5) {
        setMinute(parts[0]);
        setHour(parts[1]);
        setDay(parts[2]);
        setMonth(parts[3]);
        setWeekday(parts[4]);
      }
    }
    setMode(m);
  };

  const partInput = (label: string, val: string, onChangeFn: (v: string) => void) => (
    <div style={{ flex: 1, minWidth: 60 }}>
      <label style={{ ...labelStyle, fontSize: "var(--text-xs)", textAlign: "center" }}>{label}</label>
      <input
        type="text"
        value={val}
        onChange={(e) => onChangeFn(e.target.value)}
        style={{ ...inputStyle, textAlign: "center", padding: "var(--space-1) var(--space-2)" }}
      />
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      {/* Mode toggle */}
      <div style={{ display: "flex", gap: 2, background: "var(--bg-secondary)", borderRadius: "var(--radius-lg)", padding: 2 }}>
        {(["simple", "advanced"] as const).map((m) => (
          <button
            key={m}
            onClick={() => handleModeSwitch(m)}
            style={{
              flex: 1,
              padding: "var(--space-1) var(--space-2)",
              border: "none",
              borderRadius: "var(--radius-md)",
              background: mode === m ? "var(--interactive-light)" : "transparent",
              color: mode === m ? "var(--interactive)" : "var(--text-secondary)",
              fontSize: "var(--text-xs)",
              fontWeight: mode === m ? 500 : 400,
              cursor: "pointer",
              transition: "all var(--transition-fast)",
            }}
          >
            {m === "simple" ? "快捷" : "高级"}
          </button>
        ))}
      </div>

      {mode === "simple" ? (
        <>
          {/* Preset buttons */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-1)" }}>
            {SCHEDULE_PRESETS.map((p) => (
              <button
                key={p.schedule}
                onClick={() => handlePreset(p)}
                title={p.description}
                style={{
                  padding: "var(--space-1) var(--space-2)",
                  border: "1px solid",
                  borderColor: value === p.schedule ? "var(--interactive)" : "var(--border-primary)",
                  borderRadius: "var(--radius-md)",
                  background: value === p.schedule ? "var(--interactive-light)" : "var(--bg-primary)",
                  color: value === p.schedule ? "var(--interactive)" : "var(--text-secondary)",
                  fontSize: "var(--text-xs)",
                  cursor: "pointer",
                  transition: "all var(--transition-fast)",
                }}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* Individual part editors */}
          <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "flex-end" }}>
            {partInput("分钟", minute, (v) => handlePartChange("minute", v))}
            {partInput("小时", hour, (v) => handlePartChange("hour", v))}
            {partInput("日", day, (v) => handlePartChange("day", v))}
            {partInput("月", month, (v) => handlePartChange("month", v))}
            {partInput("周", weekday, (v) => handlePartChange("weekday", v))}
          </div>
        </>
      ) : (
        /* Raw cron expression input */
        <div>
          <label style={labelStyle}>Cron 表达式 (分 时 日 月 周)</label>
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="0 9 * * *"
            style={inputStyle}
          />
        </div>
      )}

      {/* Validation result */}
      {validation && (
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          padding: "var(--space-1) var(--space-3)",
          borderRadius: "var(--radius-lg)",
          fontSize: "var(--text-xs)",
          background: validation.valid ? "var(--success-light)" : "var(--error-light)",
          border: `1px solid ${validation.valid ? "var(--success)" : "var(--error)"}`,
          color: validation.valid ? "var(--success)" : "var(--error)",
        }}>
          {validation.valid ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
          <span>
            {validation.valid
              ? `${validation.description}${validation.nextRun ? ` — 下次: ${formatTime(validation.nextRun)}` : ""}`
              : "无效的 cron 表达式"}
          </span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// JobEditor modal form
// ---------------------------------------------------------------------------

function JobEditor({
  job,
  onSave,
  onCancel,
}: {
  job: CronJob | null; // null = create new
  onSave: (data: CreateCronJobRequest | (UpdateCronJobRequest & { id: string })) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(job?.name ?? "");
  const [schedule, setSchedule] = useState(job?.schedule ?? "0 9 * * *");
  const [message, setMessage] = useState(job?.message ?? "");
  const [enabled, setEnabled] = useState(job?.enabled ?? true);
  const [validation, setValidation] = useState<CronValidateResult | null>(null);

  // Validate on schedule change
  useEffect(() => {
    if (!schedule.trim()) {
      setValidation(null);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const result = await api.validateCron(schedule);
        setValidation(result);
      } catch {
        setValidation(null);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [schedule]);

  const handleSave = () => {
    if (!name.trim() || !schedule.trim() || !message.trim()) return;
    if (validation && !validation.valid) return;

    if (job) {
      onSave({ id: job.id, name, schedule, message, enabled });
    } else {
      onSave({ name, schedule, message, enabled });
    }
  };

  const isValid = name.trim() && schedule.trim() && message.trim() && (!validation || validation.valid);

  return (
    <div style={{
      display: "flex", flexDirection: "column", gap: "var(--space-4)",
      background: "var(--bg-secondary)", border: "1px solid var(--border-primary)",
      borderRadius: "var(--radius-xl)", padding: "var(--space-4)",
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h3 style={{ margin: 0, fontSize: "var(--text-base)", fontWeight: "var(--font-semibold)", color: "var(--text-primary)" }}>
          {job ? "编辑任务" : "新建定时任务"}
        </h3>
        <button onClick={onCancel} style={{
          padding: "var(--space-1)", border: "none", background: "transparent",
          color: "var(--text-tertiary)", cursor: "pointer", borderRadius: "var(--radius-md)",
        }} onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-primary)"; }} onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-tertiary)"; }}>
          ✕
        </button>
      </div>

      <div>
        <label style={labelStyle}>任务名称 *</label>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="例: 每日数据摘要" style={inputStyle} />
      </div>

      <div>
        <label style={labelStyle}>执行计划 *</label>
        <CronBuilder value={schedule} onChange={setSchedule} validation={validation} />
      </div>

      <div>
        <label style={labelStyle}>执行消息 *</label>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Agent 将接收并执行的消息内容..."
          rows={4}
          style={{ ...inputStyle, resize: "vertical", minHeight: 80, fontFamily: "inherit" }}
        />
      </div>

      <label style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", cursor: "pointer" }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} style={{ width: 16, height: 16 }} />
        <span style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>立即启用</span>
      </label>

      <div style={{ display: "flex", gap: "var(--space-2)", justifyContent: "flex-end" }}>
        <button onClick={onCancel} style={{
          padding: "var(--space-2) var(--space-4)", border: "1px solid var(--border-primary)",
          borderRadius: "var(--radius-lg)", background: "var(--bg-primary)", color: "var(--text-secondary)",
          fontSize: "var(--text-sm)", cursor: "pointer",
        }}>
          取消
        </button>
        <button onClick={handleSave} disabled={!isValid} style={{
          display: "flex", alignItems: "center", gap: "var(--space-1)",
          padding: "var(--space-2) var(--space-4)", border: "none",
          borderRadius: "var(--radius-lg)", fontSize: "var(--text-sm)", fontWeight: 500,
          background: isValid ? "var(--interactive)" : "var(--bg-hover)",
          color: isValid ? "#fff" : "var(--text-tertiary)",
          cursor: isValid ? "pointer" : "not-allowed",
          transition: "all var(--transition-fast)",
        }}>
          {job ? "更新" : "创建"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// JobCard — displays a single job with actions
// ---------------------------------------------------------------------------

function JobCard({
  job,
  onEdit,
  onDelete,
  onToggle,
  onRun,
}: {
  job: CronJob;
  onEdit: (job: CronJob) => void;
  onDelete: (id: string) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onRun: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const statusIcon = job.lastStatus === "success"
    ? <CheckCircle2 size={12} style={{ color: "var(--success)" }} />
    : job.lastStatus === "failed"
      ? <XCircle size={12} style={{ color: "var(--error)" }} />
      : <Clock size={12} style={{ color: "var(--text-tertiary)" }} />;

  return (
    <div style={{
      border: "1px solid var(--border-primary)",
      borderRadius: "var(--radius-xl)",
      background: "var(--bg-primary)",
      overflow: "hidden",
      transition: "border-color var(--transition-fast)",
      opacity: job.enabled ? 1 : 0.6,
    }}>
      {/* Header row */}
      <div style={{
        display: "flex", alignItems: "center", gap: "var(--space-2)",
        padding: "var(--space-3)",
      }}>
        {/* Toggle */}
        <button
          onClick={() => onToggle(job.id, !job.enabled)}
          title={job.enabled ? "点击禁用" : "点击启用"}
          style={{
            padding: 0, border: "none", background: "transparent",
            cursor: "pointer", color: job.enabled ? "var(--success)" : "var(--text-tertiary)",
            display: "flex", alignItems: "center",
          }}
        >
          {job.enabled ? <ToggleRight size={22} /> : <ToggleLeft size={22} />}
        </button>

        {/* Name + schedule */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: "var(--text-sm)", fontWeight: 500, color: "var(--text-primary)",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {job.name}
          </div>
          <div style={{
            fontSize: "var(--text-xs)", color: "var(--text-tertiary)",
            display: "flex", alignItems: "center", gap: "var(--space-1)", marginTop: 2,
          }}>
            <code style={{
              background: "var(--bg-secondary)", padding: "0 var(--space-1)",
              borderRadius: "var(--radius-sm)", fontSize: "var(--text-xs)",
            }}>
              {job.schedule}
            </code>
            {statusIcon}
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
          <button onClick={() => onRun(job.id)} title="立即执行" style={actionBtnStyle} onMouseEnter={(e) => { e.currentTarget.style.color = "var(--interactive)"; }} onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-tertiary)"; }}>
            <Play size={14} />
          </button>
          <button onClick={() => onEdit(job)} title="编辑" style={actionBtnStyle} onMouseEnter={(e) => { e.currentTarget.style.color = "var(--interactive)"; }} onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-tertiary)"; }}>
            <Edit3 size={14} />
          </button>
          <button onClick={() => setExpanded(!expanded)} title="详情" style={actionBtnStyle} onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-primary)"; }} onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-tertiary)"; }}>
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
          <button onClick={() => onDelete(job.id)} title="删除" style={actionBtnStyle} onMouseEnter={(e) => { e.currentTarget.style.color = "var(--error)"; }} onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-tertiary)"; }}>
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div style={{
          padding: "0 var(--space-3) var(--space-3)",
          borderTop: "1px solid var(--border-primary)",
          display: "flex", flexDirection: "column", gap: "var(--space-2)",
        }}>
          <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)", background: "var(--bg-secondary)", padding: "var(--space-2) var(--space-3)", borderRadius: "var(--radius-md)" }}>
            {job.message}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-2)", fontSize: "var(--text-xs)" }}>
            <div>
              <span style={{ color: "var(--text-tertiary)" }}>上次运行: </span>
              <span style={{ color: "var(--text-secondary)" }}>{job.lastRun ? formatTime(job.lastRun) : "—"}</span>
            </div>
            <div>
              <span style={{ color: "var(--text-tertiary)" }}>下次运行: </span>
              <span style={{ color: "var(--text-secondary)" }}>{job.nextRun ? formatTime(job.nextRun) : "—"}</span>
            </div>
            <div>
              <span style={{ color: "var(--text-tertiary)" }}>运行次数: </span>
              <span style={{ color: "var(--text-secondary)" }}>{job.runCount}</span>
            </div>
            <div>
              <span style={{ color: "var(--text-tertiary)" }}>错误次数: </span>
              <span style={{ color: job.errorCount > 0 ? "var(--error)" : "var(--text-secondary)" }}>{job.errorCount}</span>
            </div>
          </div>
          {job.lastError && (
            <div style={{
              fontSize: "var(--text-xs)", color: "var(--error)",
              background: "var(--error-light)", padding: "var(--space-2) var(--space-3)",
              borderRadius: "var(--radius-md)", display: "flex", alignItems: "flex-start", gap: "var(--space-1)",
            }}>
              <AlertCircle size={12} style={{ flexShrink: 0, marginTop: 2 }} />
              <span style={{ wordBreak: "break-word" }}>{job.lastError}</span>
            </div>
          )}
          <div style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>
            创建于 {formatTime(job.createdAt)}
          </div>
        </div>
      )}
    </div>
  );
}

const actionBtnStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 28,
  height: 28,
  borderRadius: "var(--radius-md)",
  border: "none",
  background: "transparent",
  color: "var(--text-tertiary)",
  cursor: "pointer",
  transition: "color var(--transition-fast)",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);

    if (diffMin < 1) return "刚刚";
    if (diffMin < 60) return `${diffMin} 分钟前`;
    const diffHour = Math.floor(diffMin / 60);
    if (diffHour < 24) return `${diffHour} 小时前`;
    const diffDay = Math.floor(diffHour / 24);
    if (diffDay < 7) return `${diffDay} 天前`;

    return d.toLocaleDateString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// CronManager — main component
// ---------------------------------------------------------------------------

export function CronManager() {
  const { success, error: showError, warning } = useToast();
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingJob, setEditingJob] = useState<CronJob | null>(null);
  const [creating, setCreating] = useState(false);
  const [running, setRunning] = useState<string | null>(null);

  const loadJobs = useCallback(async () => {
    try {
      const data = await api.listCronJobs();
      setJobs(data);
    } catch (err) {
      console.error("Failed to load cron jobs:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadJobs();
  }, [loadJobs]);

  const handleCreate = async (data: CreateCronJobRequest | (UpdateCronJobRequest & { id: string })) => {
    try {
      if ("id" in data) {
        // Update
        const { id, ...update } = data;
        await api.updateCronJob(id, update);
        success("任务已更新");
      } else {
        await api.createCronJob(data);
        success("任务已创建");
      }
      setCreating(false);
      setEditingJob(null);
      await loadJobs();
    } catch (err) {
      showError(err instanceof Error ? err.message : "操作失败");
    }
  };

  const handleDelete = async (id: string) => {
    const confirmed = await useUIStore.getState().showConfirm({
      title: "删除确认",
      message: "确定要删除此任务吗？此操作不可恢复。",
      variant: "danger",
    });
    if (!confirmed) return;

    try {
      await api.deleteCronJob(id);
      success("任务已删除");
      await loadJobs();
    } catch (err) {
      showError("删除失败");
    }
  };

  const handleToggle = async (id: string, enabled: boolean) => {
    try {
      await api.updateCronJob(id, { enabled });
      success(enabled ? "任务已启用" : "任务已禁用");
      await loadJobs();
    } catch (err) {
      showError("操作失败");
    }
  };

  const handleRun = async (id: string) => {
    if (running) return;
    setRunning(id);
    try {
      await api.runCronJob(id);
      success("任务已触发");
      // Refresh after a delay to see status change
      setTimeout(loadJobs, 2000);
    } catch (err) {
      showError("触发失败");
    } finally {
      setRunning(null);
    }
  };

  // =====================================================================
  // Render
  // =====================================================================

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)", padding: "var(--space-4)" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h3 style={{ margin: 0, fontSize: "var(--text-base)", fontWeight: "var(--font-semibold)", color: "var(--text-primary)", display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
          <Clock size={16} />
          定时任务
        </h3>
        <div style={{ display: "flex", gap: "var(--space-2)" }}>
          <button onClick={loadJobs} title="刷新" style={{
            ...actionBtnStyle, width: 32, height: 32,
            border: "1px solid var(--border-primary)",
          }} onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }} onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
            <RefreshCw size={14} />
          </button>
          <button onClick={() => { setEditingJob(null); setCreating(true); }} style={{
            display: "flex", alignItems: "center", gap: "var(--space-1)",
            padding: "var(--space-1) var(--space-3)",
            background: "var(--interactive)", color: "#fff",
            fontSize: "var(--text-sm)", fontWeight: 500,
            borderRadius: "var(--radius-lg)", border: "none", cursor: "pointer",
            transition: "opacity var(--transition-fast)",
          }} onMouseEnter={(e) => { e.currentTarget.style.opacity = "0.85"; }} onMouseLeave={(e) => { e.currentTarget.style.opacity = "1"; }}>
            <Plus size={14} /> 新建
          </button>
        </div>
      </div>

      {/* Editor (create or edit) */}
      {creating && (
        <JobEditor
          job={null}
          onSave={handleCreate}
          onCancel={() => setCreating(false)}
        />
      )}
      {editingJob && !creating && (
        <JobEditor
          job={editingJob}
          onSave={handleCreate}
          onCancel={() => setEditingJob(null)}
        />
      )}

      {/* Job list */}
      {loading ? (
        <div style={{ textAlign: "center", padding: "var(--space-8)", color: "var(--text-tertiary)", fontSize: "var(--text-sm)" }}>
          加载中...
        </div>
      ) : jobs.length === 0 ? (
        <div style={{ textAlign: "center", padding: "var(--space-8)", color: "var(--text-tertiary)" }}>
          <Clock size={32} style={{ marginBottom: "var(--space-3)", opacity: 0.4 }} />
          <p style={{ fontSize: "var(--text-sm)", margin: 0 }}>暂无定时任务</p>
          <p style={{ fontSize: "var(--text-xs)", margin: 0, marginTop: "var(--space-1)" }}>
            点击「新建」创建第一个定时任务
          </p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
          {/* Stats bar */}
          <div style={{
            display: "flex", gap: "var(--space-4)", padding: "var(--space-2) var(--space-3)",
            background: "var(--bg-secondary)", borderRadius: "var(--radius-lg)",
            fontSize: "var(--text-xs)", color: "var(--text-tertiary)",
          }}>
            <span>共 {jobs.length} 个任务</span>
            <span style={{ color: "var(--success)" }}>{jobs.filter((j) => j.enabled).length} 启用</span>
            <span style={{ color: "var(--text-tertiary)" }}>{jobs.filter((j) => !j.enabled).length} 禁用</span>
          </div>

          {jobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              onEdit={setEditingJob}
              onDelete={handleDelete}
              onToggle={handleToggle}
              onRun={handleRun}
            />
          ))}
        </div>
      )}
    </div>
  );
}
