import { useEffect, useState, useCallback, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { api, type AdminSkill } from "../api/client.js";
import { useUIStore } from "../store/ui.js";
import { Tabs } from "../components/ui/Tabs.js";
import { SearchBar } from "../components/ui/SearchBar.js";
import { DropZone } from "../components/ui/DropZone.js";
import { EmptyState } from "../components/ui/EmptyState.js";
import { Button } from "../components/ui/Button.js";
import { StatusBadge } from "../components/hub/StatusBadge.js";

/* -------------------------------------------------------------------------- */
/*  Constants & Styles                                                        */
/* -------------------------------------------------------------------------- */

type ReviewStatus = "pending" | "approved" | "rejected" | "deprecated" | "all";

const STATUS_TABS: { key: ReviewStatus; label: string }[] = [
  { key: "pending", label: "待审核" },
  { key: "approved", label: "已批准" },
  { key: "rejected", label: "已拒绝" },
  { key: "deprecated", label: "已弃用" },
  { key: "all", label: "全部" },
];

const pageStyle: CSSProperties = {
  padding: "var(--space-6)",
  maxWidth: 1200,
  margin: "0 auto",
};

const bannerStyle: CSSProperties = {
  padding: "var(--space-4) var(--space-5)",
  marginBottom: "var(--space-4)",
  background: "var(--info-light, #e7f1ff)",
  borderLeft: "3px solid var(--info, #2196f3)",
  borderRadius: "var(--radius-md)",
  fontSize: "var(--text-sm)",
  color: "var(--text-primary)",
};

const errorStyle: CSSProperties = {
  padding: "var(--space-4) var(--space-5)",
  background: "var(--error-light)",
  border: "1px solid var(--error)",
  borderRadius: "var(--radius-lg)",
  color: "var(--error-dark)",
  fontSize: "var(--text-sm)",
  margin: "var(--space-3) 0",
};

const cardStyle: CSSProperties = {
  padding: "var(--space-4)",
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-lg)",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
};

const cardTitleStyle: CSSProperties = {
  fontSize: "var(--text-lg)",
  fontWeight: 600,
  color: "var(--text-primary)",
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
};

const metaStyle: CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--text-secondary)",
};

const promptPreviewStyle: CSSProperties = {
  fontFamily: "var(--font-mono, monospace)",
  fontSize: "var(--text-xs)",
  background: "var(--bg-secondary)",
  padding: "var(--space-2) var(--space-3)",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--border)",
  maxHeight: 100,
  overflow: "hidden" as const,
  whiteSpace: "pre-wrap" as const,
};

const actionRowStyle: CSSProperties = {
  display: "flex",
  gap: "var(--space-2)",
  flexWrap: "wrap" as const,
  marginTop: "var(--space-2)",
};

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

export function WorkerSkills() {
  const showConfirm = useUIStore((s) => s.showConfirm);
  const addToast = useUIStore((s) => s.addToast);

  const [tab, setTab] = useState<ReviewStatus>("pending");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [skills, setSkills] = useState<AdminSkill[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reasonDialog, setReasonDialog] = useState<{
    kind: "reject" | "deprecate";
    skill: AdminSkill;
  } | null>(null);
  const [importDialog, setImportDialog] = useState<{
    importing: boolean;
    error: string | null;
    conflict: Array<{ slug: string; name: string }> | null;
  } | null>(null);

  /* -- debounce search 300ms -- */
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  /* -- load -- */
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listMarketplaceAdminSkills({
        status: tab,
        search: debouncedSearch,
        limit: 100,
      });
      setSkills(res.skills);
      setTotal(res.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [tab, debouncedSearch]);

  useEffect(() => {
    load();
  }, [load]);

  /* -- actions -- */
  const handleApprove = async (skill: AdminSkill) => {
    const ok = await showConfirm({
      title: "批准 Skill",
      message: `确认批准 "${skill.name}"？批准后所有连接的 DA Worker 都能下载安装。`,
      confirmLabel: "批准",
    });
    if (!ok) return;
    try {
      await api.approveMarketplaceSkill(skill.id);
      addToast("success", `已批准 ${skill.name}`);
      await load();
    } catch (e) {
      addToast("error", e instanceof Error ? e.message : "批准失败");
    }
  };

  const handleSubmitReason = async (reason: string) => {
    if (!reasonDialog) return;
    const { kind, skill } = reasonDialog;
    try {
      if (kind === "reject") {
        await api.rejectMarketplaceSkill(skill.id, reason);
        addToast("success", `已拒绝 ${skill.name}`);
      } else {
        await api.deprecateMarketplaceSkill(skill.id, reason);
        addToast("warning", `已下架 ${skill.name}`);
      }
      setReasonDialog(null);
      await load();
    } catch (e) {
      addToast("error", e instanceof Error ? e.message : "操作失败");
    }
  };

  const handleRemove = async (skill: AdminSkill) => {
    const ok = await showConfirm({
      title: "永久删除 Skill",
      message: `确认永久删除 "${skill.name}"？此操作不可恢复。仅建议对 spam 或测试垃圾使用。`,
      confirmLabel: "删除",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await api.removeMarketplaceSkill(skill.id);
      addToast("success", `已删除 ${skill.name}`);
      await load();
    } catch (e) {
      addToast("error", e instanceof Error ? e.message : "删除失败");
    }
  };

  const handleImportFiles = async (files: File[], overwrite = false) => {
    if (files.length === 0) return;

    // Detect folder upload (any file has webkitRelativePath with "/").
    const isFolder = files.some(
      (f) => (f as File & { webkitRelativePath?: string }).webkitRelativePath?.includes("/"),
    );

    setImportDialog({ importing: true, error: null, conflict: null });
    try {
      let result;
      if (isFolder) {
        // Folder: serialize to JSON bundle.
        const bundle = {
          type: "folder" as const,
          files: await Promise.all(
            files.map(async (f) => ({
              path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name,
              content: await f.text(),
            })),
          ),
          reviewStatus: "approved",
          overwrite,
        };
        result = await api.importMarketplaceSkills(bundle);
      } else {
        // Single file: FormData.
        const fd = new FormData();
        fd.append("file", files[0]!);
        fd.append("reviewStatus", "approved");
        if (overwrite) fd.append("overwrite", "true");
        result = await api.importMarketplaceSkills(fd);
      }
      if (result.conflict && result.conflicts?.length) {
        setImportDialog({
          importing: false,
          error: null,
          conflict: result.conflicts,
        });
        return;
      }
      const count = result.imported?.length ?? 0;
      addToast("success", `成功导入 ${count} 个技能`);
      setImportDialog({ importing: false, error: null, conflict: null });
      await load();
    } catch (e) {
      setImportDialog({
        importing: false,
        error: e instanceof Error ? e.message : "导入失败",
        conflict: null,
      });
    }
  };

  /* -- render -- */
  return (
    <div style={pageStyle}>
      <div style={bannerStyle}>
        管理 DA Worker 可下载安装的 Skill。批准后，所有连接的 DA Worker 都能在
        "资源市场"面板看到并安装。与{" "}
        <Link to="/skills">企业技能包</Link>（多租户订阅制）不同。
      </div>

      <h1 style={{ fontSize: "var(--text-2xl)", marginBottom: "var(--space-4)" }}>
        Worker 技能市场
      </h1>

      <Tabs
        items={STATUS_TABS.map((t) => ({
          key: t.key,
          label: `${t.label}${t.key === tab && total > 0 ? ` (${total})` : ""}`,
        }))}
        activeKey={tab}
        onChange={(k) => setTab(k as ReviewStatus)}
      />

      <div style={{ margin: "var(--space-4) 0", display: "flex", gap: "var(--space-3)", alignItems: "center" }}>
        <SearchBar
          value={search}
          onChange={setSearch}
          placeholder="搜索 name / slug / description"
        />
        <Button
          variant="secondary"
          onClick={() => setImportDialog({ importing: false, error: null, conflict: null })}
        >
          导入技能
        </Button>
      </div>

      {error && <div style={errorStyle}>{error}</div>}

      {loading ? (
        <div style={{ padding: "var(--space-8)", textAlign: "center" }}>
          加载中...
        </div>
      ) : skills.length === 0 ? (
        <EmptyState
          title="暂无 skill"
          description={
            debouncedSearch
              ? `未找到匹配 "${debouncedSearch}" 的 skill`
              : `当前 Tab（${tab}）下没有 skill`
          }
        />
      ) : (
        <div style={{ display: "grid", gap: "var(--space-3)" }}>
          {skills.map((s) => (
            <SkillAdminCard
              key={s.id}
              skill={s}
              onApprove={handleApprove}
              onReject={(skill) => setReasonDialog({ kind: "reject", skill })}
              onDeprecate={(skill) => setReasonDialog({ kind: "deprecate", skill })}
              onRemove={handleRemove}
            />
          ))}
        </div>
      )}

      {reasonDialog && (
        <ReasonDialog
          kind={reasonDialog.kind}
          skillName={reasonDialog.skill.name}
          onSubmit={handleSubmitReason}
          onCancel={() => setReasonDialog(null)}
        />
      )}

      {importDialog && (
        <ImportSkillDialog
          importing={importDialog.importing}
          error={importDialog.error}
          conflict={importDialog.conflict}
          onFiles={(files) => handleImportFiles(files, !!importDialog.conflict)}
          onClose={() => setImportDialog(null)}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  SkillAdminCard                                                            */
/* -------------------------------------------------------------------------- */

interface SkillAdminCardProps {
  skill: AdminSkill;
  onApprove: (s: AdminSkill) => void;
  onReject: (s: AdminSkill) => void;
  onDeprecate: (s: AdminSkill) => void;
  onRemove: (s: AdminSkill) => void;
}

function SkillAdminCard({ skill, onApprove, onReject, onDeprecate, onRemove }: SkillAdminCardProps) {
  return (
    <div style={cardStyle}>
      <div style={cardTitleStyle}>
        <span>{skill.name}</span>
        <StatusBadge status={skill.review_status} />
        {skill.source_package_id && (
          <span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>
            🔗 源自企业包
          </span>
        )}
      </div>
      <div style={metaStyle}>
        by {skill.submitter_id} · v{skill.version} · 提交于{" "}
        {new Date(skill.created_at).toLocaleString("zh-CN")}
        {skill.published_at && ` · 发布于 ${new Date(skill.published_at).toLocaleString("zh-CN")}`}
      </div>
      {skill.description && (
        <div style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>
          {skill.description}
        </div>
      )}
      <pre style={promptPreviewStyle}>{skill.prompt}</pre>
      {skill.tags && skill.tags.length > 0 && (
        <div style={{ display: "flex", gap: "var(--space-1)", flexWrap: "wrap" }}>
          {skill.tags.map((t) => (
            <span
              key={t}
              style={{
                fontSize: "var(--text-xs)",
                padding: "2px 8px",
                background: "var(--bg-secondary)",
                borderRadius: "var(--radius-sm)",
              }}
            >
              {t}
            </span>
          ))}
        </div>
      )}
      {skill.review_notes && (
        <div style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>
          审核备注：{skill.review_notes}
        </div>
      )}
      <div style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>
        下载 {skill.download_count} · 评分 {Number(skill.rating_avg).toFixed(1)} (
        {skill.review_count} 评)
      </div>
      <div style={actionRowStyle}>
        {skill.review_status === "pending" && (
          <>
            <Button size="sm" variant="primary" onClick={() => onApprove(skill)}>
              批准
            </Button>
            <Button size="sm" variant="danger" onClick={() => onReject(skill)}>
              拒绝
            </Button>
          </>
        )}
        {skill.review_status === "approved" && (
          <>
            <Button size="sm" variant="danger" onClick={() => onDeprecate(skill)}>
              下架
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onRemove(skill)}>
              删除
            </Button>
          </>
        )}
        {skill.review_status === "rejected" && (
          <Button size="sm" variant="ghost" onClick={() => onRemove(skill)}>
            删除
          </Button>
        )}
        {skill.review_status === "deprecated" && (
          <>
            <Button size="sm" variant="primary" onClick={() => onApprove(skill)}>
              上架
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onRemove(skill)}>
              删除
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  ReasonDialog (Modal-based, 输入审核原因)                                  */
/* -------------------------------------------------------------------------- */

interface ReasonDialogProps {
  kind: "reject" | "deprecate";
  skillName: string;
  onSubmit: (reason: string) => void;
  onCancel: () => void;
}

function ReasonDialog({ kind, skillName, onSubmit, onCancel }: ReasonDialogProps) {
  const [reason, setReason] = useState("");
  const verb = kind === "reject" ? "拒绝" : "下架";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-card)",
          padding: "var(--space-6)",
          borderRadius: "var(--radius-lg)",
          minWidth: 400,
          maxWidth: 600,
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-3)",
        }}
      >
        <h3 style={{ margin: 0 }}>
          {verb} "{skillName}"
        </h3>
        <p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: 0 }}>
          请输入{verb}原因（可选，但建议填写）：
        </p>
        <textarea
          autoFocus
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={`${verb}原因...`}
          style={{
            minHeight: 80,
            padding: "var(--space-2) var(--space-3)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            fontFamily: "inherit",
            fontSize: "var(--text-sm)",
            resize: "vertical",
          }}
        />
        <div style={{ display: "flex", gap: "var(--space-2)", justifyContent: "flex-end" }}>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            取消
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() => onSubmit(reason)}
          >
            确认{verb}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  ImportSkillDialog (上传 .md/.json/.zip 直接导入到 Worker 市场)            */
/* -------------------------------------------------------------------------- */

interface ImportSkillDialogProps {
  importing: boolean;
  error: string | null;
  conflict: Array<{ slug: string; name: string }> | null;
  onFiles: (files: File[]) => void;
  onClose: () => void;
}

function ImportSkillDialog({
  importing,
  error,
  conflict,
  onFiles,
  onClose,
}: ImportSkillDialogProps) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-card)",
          padding: "var(--space-6)",
          borderRadius: "var(--radius-lg)",
          minWidth: 400,
          maxWidth: 600,
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-3)",
        }}
      >
        <h3 style={{ margin: 0 }}>导入技能到 Worker 市场</h3>
        <p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: 0 }}>
          上传技能文件直接导入到市场（默认审核通过即上架）。支持 <code>.md</code> / <code>.json</code> / <code>.zip</code>。
        </p>

        {conflict && conflict.length > 0 && (
          <div style={{ fontSize: "var(--text-sm)", color: "var(--warning-dark, #b8860b)", background: "var(--warning-light, #fff8e1)", padding: "var(--space-3)", borderRadius: "var(--radius-sm)" }}>
            以下技能 slug 已存在：{conflict.map((c) => c.name).join("、")}。
            重新选择文件将<strong>覆盖</strong>同名技能。
          </div>
        )}

        {error && (
          <div style={errorStyle}>{error}</div>
        )}

        <div style={{ opacity: importing ? 0.5 : 1, pointerEvents: importing ? "none" : "auto" }}>
          <DropZone
            onFiles={onFiles}
            accept=".md,.json,.zip"
            multiple={false}
            label="拖拽技能文件到此处"
            hint={conflict ? "重新上传将覆盖同名技能" : "或点击选择文件"}
          />
        </div>

        {/* Folder upload */}
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              const input = document.createElement("input");
              input.type = "file";
              input.multiple = true;
              input.style.display = "none";
              (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
              input.onchange = () => {
                if (input.files && input.files.length > 0) {
                  onFiles(Array.from(input.files));
                }
                input.remove();
              };
              document.body.appendChild(input);
              input.click();
            }}
            disabled={importing}
          >
            选择文件夹
          </Button>
          <span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>
            上传整个技能文件夹（含 SKILL.md）
          </span>
        </div>

        <div style={{ display: "flex", gap: "var(--space-2)", justifyContent: "flex-end" }}>
          <Button size="sm" variant="ghost" onClick={onClose} disabled={importing}>
            关闭
          </Button>
        </div>
      </div>
    </div>
  );
}
