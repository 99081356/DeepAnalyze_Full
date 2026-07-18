import { useEffect, useState, useCallback, type CSSProperties } from "react";
import { Plus, Copy, Trash2 } from "lucide-react";
import { Link } from "react-router-dom";
import {
  api,
  type PendingWorker,
  type MeResponse,
  type JoinToken,
  type CreateJoinTokenResponse,
  type OrgNode,
} from "../api/client.js";
import { Badge } from "../components/ui/Badge.js";
import { Button } from "../components/ui/Button.js";
import { Input } from "../components/ui/Input.js";
import { Select } from "../components/ui/Select.js";
import { StatusBadge } from "../components/hub/StatusBadge.js";
import { DeployWorkerModal } from "../components/hub/DeployWorkerModal.js";
import { useUIStore } from "../store/ui.js";

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

interface WorkerApprovalProps {
  user: MeResponse;
}

export function WorkerApproval({ user }: WorkerApprovalProps) {
  const showConfirm = useUIStore((s) => s.showConfirm);
  const addToast = useUIStore((s) => s.addToast);

  const [pending, setPending] = useState<PendingWorker[]>([]);
  const [all, setAll] = useState<PendingWorker[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [approvedToken, setApprovedToken] = useState<{ id: string; token: string } | null>(null);
  const [deployOpen, setDeployOpen] = useState(false);

  // ── Join Token 管理 state ──
  const canManageJoinTokens = user.permissions.includes("worker:approve");
  const [joinTokens, setJoinTokens] = useState<JoinToken[]>([]);
  const [joinTokensLoading, setJoinTokensLoading] = useState(false);
  const [jtForm, setJtForm] = useState({
    // super_admin 必须显式选组织；org_admin 会被锁定为本组织（见下方默认值逻辑）
    organization_id: "",
    expires_in_hours: 24,
    max_uses: 1,
    count: 1,
    notes: "",
  });
  const [jtCreating, setJtCreating] = useState(false);
  // 最近生成的 token（高亮 + 一键复制）。POST 返回的是精简响应（id/token/
  // expires_at），不含 use_count 等字段，所以用 CreateJoinTokenResponse 类型。
  const [newlyCreated, setNewlyCreated] = useState<CreateJoinTokenResponse[] | null>(null);
  const [orgs, setOrgs] = useState<OrgNode[]>([]);

  // org_admin 默认锁定本组织；super_admin 留空需选择
  useEffect(() => {
    if (!user.is_super_admin && user.organization_id && !jtForm.organization_id) {
      setJtForm((prev) => ({ ...prev, organization_id: user.organization_id! }));
    }
  }, [user.is_super_admin, user.organization_id, jtForm.organization_id]);

  // 加载组织列表（供 super_admin 选择目标组织）
  useEffect(() => {
    if (!canManageJoinTokens || !user.is_super_admin) return;
    let cancelled = false;
    (async () => {
      try {
        const resp = await api.getOrgs();
        if (!cancelled) setOrgs(resp.organizations);
      } catch {
        // 静默忽略，选择器降级为空
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canManageJoinTokens, user.is_super_admin]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [p, a] = await Promise.all([api.getPendingWorkers(), api.getAllWorkers()]);
      setPending(p.workers);
      setAll(a.workers);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load workers");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleApprove = async (id: string) => {
    const confirmed = await showConfirm({
      title: "批准 Worker",
      message: "确定要批准此 Worker 的接入请求吗？",
      confirmLabel: "确认批准",
      variant: "default",
    });
    if (!confirmed) return;

    try {
      const resp = await api.approveWorker(id);
      setApprovedToken({ id, token: resp.worker_token });
      addToast("success", "Worker 已批准");
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to approve worker";
      setError(msg);
      addToast("error", msg);
    }
  };

  const handleReject = async (id: string) => {
    const confirmed = await showConfirm({
      title: "拒绝 Worker",
      message: "确定要拒绝此 Worker 的接入请求吗？",
      confirmLabel: "确认拒绝",
      variant: "danger",
    });
    if (!confirmed) return;

    try {
      await api.rejectWorker(id, "Rejected via admin UI");
      addToast("success", "Worker 已拒绝");
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to reject worker";
      setError(msg);
      addToast("error", msg);
    }
  };

  // ── Join Token: load / create / delete / copy ───────────────────────────
  const loadJoinTokens = useCallback(async () => {
    if (!canManageJoinTokens) return;
    setJoinTokensLoading(true);
    try {
      // super_admin 可看全部；org_admin 只看本组织
      const orgFilter = user.is_super_admin ? undefined : user.organization_id ?? undefined;
      const resp = await api.listJoinTokens(orgFilter);
      setJoinTokens(resp.tokens);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "加载 Join Token 失败";
      addToast("error", msg);
    } finally {
      setJoinTokensLoading(false);
    }
  }, [canManageJoinTokens, user.is_super_admin, user.organization_id, addToast]);

  useEffect(() => {
    void loadJoinTokens();
  }, [loadJoinTokens]);

  const handleCreateJoinToken = async () => {
    const targetOrg = user.is_super_admin
      ? jtForm.organization_id
      : user.organization_id;
    if (!targetOrg) {
      addToast("error", "请先选择目标组织");
      return;
    }
    setJtCreating(true);
    try {
      const resp = await api.createJoinToken({
        organization_id: targetOrg,
        expires_in_hours: jtForm.expires_in_hours || 24,
        max_uses: jtForm.max_uses || 1,
        count: jtForm.count || 1,
        notes: jtForm.notes.trim() || undefined,
      });
      setNewlyCreated(resp.tokens);
      addToast("success", `已生成 ${resp.tokens.length} 个 Join Token`);
      await loadJoinTokens();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "生成 Join Token 失败";
      addToast("error", msg);
    } finally {
      setJtCreating(false);
    }
  };

  const handleDeleteJoinToken = async (id: string) => {
    const confirmed = await showConfirm({
      title: "撤销 Join Token",
      message: "撤销后已发给员工的 token 将立即失效，无法再用它加入。确定？",
      confirmLabel: "确认撤销",
      variant: "danger",
    });
    if (!confirmed) return;
    try {
      await api.deleteJoinToken(id);
      addToast("success", "Join Token 已撤销");
      await loadJoinTokens();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "撤销失败";
      addToast("error", msg);
    }
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      addToast("success", "已复制到剪贴板");
    } catch {
      addToast("error", "复制失败，请手动选择文本复制");
    }
  };

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

  const headerRowStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "var(--space-3)",
  };

  const sectionTitleStyle: CSSProperties = {
    fontSize: "var(--text-base)",
    fontWeight: "var(--font-semibold)" as unknown as number,
    color: "var(--text-primary)",
    margin: 0,
  };

  const errorStyle: CSSProperties = {
    padding: "var(--space-4) var(--space-5)",
    background: "var(--error-light)",
    border: "1px solid var(--error)",
    borderRadius: "var(--radius-lg)",
    color: "var(--error-dark)",
    fontSize: "var(--text-sm)",
  };

  const tokenBannerStyle: CSSProperties = {
    padding: "var(--space-4)",
    background: "var(--success-light)",
    border: "1px solid var(--success)",
    borderRadius: "var(--radius-xl)",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-2)",
  };

  const tokenTitleStyle: CSSProperties = {
    fontWeight: 600,
    color: "var(--success-dark)",
    fontSize: "var(--text-sm)",
  };

  const tokenValueStyle: CSSProperties = {
    fontSize: "var(--text-xs)",
    color: "var(--success-dark)",
    fontFamily: "var(--font-mono)",
    wordBreak: "break-all",
  };

  const loadingStyle: CSSProperties = {
    padding: "var(--space-10)",
    textAlign: "center",
    color: "var(--text-tertiary)",
    fontSize: "var(--text-sm)",
  };

  const emptyStyle: CSSProperties = {
    padding: "var(--space-5)",
    background: "var(--bg-card)",
    border: "1px solid var(--border-primary)",
    borderRadius: "var(--radius-xl)",
    textAlign: "center",
    color: "var(--text-tertiary)",
    fontSize: "var(--text-sm)",
  };

  const pendingCardStyle: CSSProperties = {
    background: "var(--bg-card)",
    border: "1px solid var(--border-primary)",
    borderLeft: "4px solid var(--warning)",
    borderRadius: "var(--radius-xl)",
    padding: "var(--space-4)",
  };

  const cardRowStyle: CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "var(--space-3)",
    flexWrap: "wrap",
  };

  const workerNameStyle: CSSProperties = {
    fontSize: "var(--text-sm)",
    fontWeight: 600,
    color: "var(--text-primary)",
  };

  const workerMetaStyle: CSSProperties = {
    fontSize: "var(--text-xs)",
    color: "var(--text-secondary)",
    marginTop: "var(--space-1)",
  };

  const workerIdStyle: CSSProperties = {
    fontSize: 11,
    color: "var(--text-tertiary)",
    marginTop: "var(--space-1)",
    fontFamily: "var(--font-mono)",
  };

  const actionRowStyle: CSSProperties = {
    display: "flex",
    gap: "var(--space-2)",
  };

  const tableCardStyle: CSSProperties = {
    background: "var(--bg-card)",
    border: "1px solid var(--border-primary)",
    borderRadius: "var(--radius-xl)",
    overflow: "hidden",
  };

  const thStyle: CSSProperties = {
    textAlign: "left",
    padding: "var(--space-3)",
    fontWeight: 500,
    color: "var(--text-primary)",
    fontSize: "var(--text-sm)",
    background: "var(--bg-tertiary)",
  };

  const tdStyle: CSSProperties = {
    padding: "var(--space-3)",
    color: "var(--text-primary)",
    fontSize: "var(--text-sm)",
    borderTop: "1px solid var(--border-primary)",
  };

  const sectionHeaderStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
  };

  return (
    <div style={pageStyle}>
      <div style={headerRowStyle}>
        <h2 style={titleStyle}>Worker 审批</h2>
        <Button
          variant="primary"
          size="sm"
          icon={<Plus size={14} />}
          onClick={() => setDeployOpen(true)}
        >
          添加 Worker
        </Button>
      </div>

      <DeployWorkerModal
        open={deployOpen}
        onClose={() => setDeployOpen(false)}
        onDeployed={load}
      />

      {error && <div style={errorStyle}>{error}</div>}

      {approvedToken && (
        <div style={tokenBannerStyle}>
          <div style={tokenTitleStyle}>
            Worker {approvedToken.id.slice(0, 12)} 已批准
          </div>
          <div style={tokenValueStyle}>
            Token: {approvedToken.token}
          </div>
          <div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setApprovedToken(null)}
            >
              关闭
            </Button>
          </div>
        </div>
      )}

      {/* Pending section */}
      <div style={sectionHeaderStyle}>
        <h3 style={sectionTitleStyle}>待审批</h3>
        <Badge variant="warning">{pending.length}</Badge>
      </div>

      {loading ? (
        <div style={loadingStyle}>加载中...</div>
      ) : pending.length === 0 ? (
        <div style={emptyStyle}>无待审批 Worker</div>
      ) : (
        <div style={{ display: "grid", gap: "var(--space-3)" }}>
          {pending.map((w) => (
            <div key={w.id} style={pendingCardStyle}>
              <div style={cardRowStyle}>
                <div>
                  <div style={workerNameStyle}>{w.name}</div>
                  <div style={workerMetaStyle}>
                    hostname: {w.hostname} · protocol: v{w.protocol_version} · applied: {w.applied_at ? new Date(w.applied_at).toLocaleString("zh-CN") : "-"}
                  </div>
                  <div style={workerIdStyle}>{w.id}</div>
                </div>
                <div style={actionRowStyle}>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => handleApprove(w.id)}
                  >
                    批准
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => handleReject(w.id)}
                  >
                    拒绝
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* All workers section */}
      <div style={sectionHeaderStyle}>
        <h3 style={sectionTitleStyle}>所有 Worker</h3>
        <Badge variant="default">{all.length}</Badge>
      </div>

      <div style={tableCardStyle}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={thStyle}>名称</th>
              <th style={thStyle}>Hostname</th>
              <th style={thStyle}>协议</th>
              <th style={thStyle}>状态</th>
            </tr>
          </thead>
          <tbody>
            {all.map((w) => (
              <tr key={w.id}>
                <td style={tdStyle}>
                  <Link to={`/workers/${w.id}`} style={{ color: "var(--brand-primary)", textDecoration: "none" }}>
                    {w.name}
                  </Link>
                </td>
                <td style={tdStyle}>{w.hostname}</td>
                <td style={tdStyle}>v{w.protocol_version}</td>
                <td style={tdStyle}>
                  <StatusBadge status={w.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ─── Join Token 管理（自助加入） ─── */}
      {canManageJoinTokens && (
        <JoinTokenSection
          tokens={joinTokens}
          loading={joinTokensLoading}
          form={jtForm}
          onFormChange={(patch) => setJtForm((prev) => ({ ...prev, ...patch }))}
          onCreate={handleCreateJoinToken}
          onDelete={handleDeleteJoinToken}
          onCopy={copyToClipboard}
          creating={jtCreating}
          newlyCreated={newlyCreated}
          onDismissNewlyCreated={() => setNewlyCreated(null)}
          orgs={orgs}
          isSuperAdmin={user.is_super_admin}
          lockedOrgId={user.organization_id}
          sectionTitleStyle={sectionTitleStyle}
          sectionHeaderStyle={sectionHeaderStyle}
          tableCardStyle={tableCardStyle}
          thStyle={thStyle}
          tdStyle={tdStyle}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Join Token section                                                        */
/* -------------------------------------------------------------------------- */

interface JoinTokenSectionProps {
  tokens: JoinToken[];
  loading: boolean;
  form: {
    organization_id: string;
    expires_in_hours: number;
    max_uses: number;
    count: number;
    notes: string;
  };
  onFormChange: (patch: Partial<JoinTokenSectionProps["form"]>) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onCopy: (text: string) => void;
  creating: boolean;
  newlyCreated: CreateJoinTokenResponse[] | null;
  onDismissNewlyCreated: () => void;
  /** Org list for super_admin to pick the target org. */
  orgs: OrgNode[];
  /** If true, show an org picker (super_admin has no home org). */
  isSuperAdmin: boolean;
  /** org_admin's home org (locked target). */
  lockedOrgId: string | null;
  sectionTitleStyle: CSSProperties;
  sectionHeaderStyle: CSSProperties;
  tableCardStyle: CSSProperties;
  thStyle: CSSProperties;
  tdStyle: CSSProperties;
}

function JoinTokenSection({
  tokens,
  loading,
  form,
  onFormChange,
  onCreate,
  onDelete,
  onCopy,
  creating,
  newlyCreated,
  onDismissNewlyCreated,
  orgs,
  isSuperAdmin,
  lockedOrgId,
  sectionTitleStyle,
  sectionHeaderStyle,
  tableCardStyle,
  thStyle,
  tdStyle,
}: JoinTokenSectionProps) {
  const formRowStyle: CSSProperties = {
    display: "grid",
    gridTemplateColumns: isSuperAdmin
      ? "1.5fr 1fr 1fr 1fr 1.5fr auto"
      : "1fr 1fr 1fr 2fr auto",
    gap: "var(--space-2)",
    alignItems: "end",
  };
  const tokenMonoStyle: CSSProperties = {
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    color: "var(--text-secondary)",
    wordBreak: "break-all",
  };
  const newBannerStyle: CSSProperties = {
    padding: "var(--space-3)",
    background: "var(--success-light)",
    border: "1px solid var(--success)",
    borderRadius: "var(--radius-lg)",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-2)",
  };

  return (
    <>
      <div style={sectionHeaderStyle}>
        <h3 style={sectionTitleStyle}>Join Token（自助加入）</h3>
        <Badge variant="default">{tokens.length}</Badge>
      </div>

      {/* 生成表单 */}
      <div
        style={{
          padding: "var(--space-3)",
          background: "var(--bg-card)",
          border: "1px solid var(--border-primary)",
          borderRadius: "var(--radius-lg)",
        }}
      >
        <div style={formRowStyle}>
          {isSuperAdmin ? (
            <div>
              <div style={{ fontSize: "var(--text-sm)", fontWeight: 500, color: "var(--text-primary)", marginBottom: "var(--space-1)" }}>
                目标组织 *
              </div>
              <Select
                value={form.organization_id}
                onChange={(v) => onFormChange({ organization_id: v })}
                options={orgs.map((o) => ({
                  value: o.id,
                  label: `${o.name} (${o.code})`,
                }))}
                placeholder="选择组织..."
                searchable
                aria-label="目标组织"
              />
            </div>
          ) : (
            <Input
              label="目标组织"
              value={lockedOrgId ?? ""}
              onChange={() => {
                /* org_admin 锁定本组织，不可改 */
              }}
              disabled
            />
          )}
          <Input
            label="有效期(小时)"
            type="number"
            value={String(form.expires_in_hours)}
            onChange={(e) => onFormChange({ expires_in_hours: parseInt(e.target.value, 10) || 0 })}
          />
          <Input
            label="最大使用次数"
            type="number"
            value={String(form.max_uses)}
            onChange={(e) => onFormChange({ max_uses: parseInt(e.target.value, 10) || 0 })}
          />
          <Input
            label="批量生成数"
            type="number"
            value={String(form.count)}
            onChange={(e) => onFormChange({ count: parseInt(e.target.value, 10) || 0 })}
          />
          <Input
            label="备注（可选）"
            value={form.notes}
            onChange={(e) => onFormChange({ notes: e.target.value })}
            placeholder="例如：发给张三"
          />
          <Button variant="primary" onClick={onCreate} loading={creating}>
            生成
          </Button>
        </div>
        <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: "var(--space-2)" }}>
          生成后把 token 发给员工，员工在自己 DA 的「设置 → Hub 连接」填入即可自动加入对应组织。
        </div>
      </div>

      {/* 最近生成的高亮区（含完整 token，方便复制） */}
      {newlyCreated && newlyCreated.length > 0 && (
        <div style={newBannerStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <b style={{ fontSize: 13, color: "var(--success-dark)" }}>
              已生成 {newlyCreated.length} 个 token（请立即复制，列表中仅显示前缀）
            </b>
            <Button variant="secondary" size="sm" onClick={onDismissNewlyCreated}>
              知道了
            </Button>
          </div>
          {newlyCreated.map((t) => (
            <div key={t.id} style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
              <code style={tokenMonoStyle}>{t.token}</code>
              <Button
                variant="secondary"
                size="sm"
                icon={<Copy size={12} />}
                onClick={() => onCopy(t.token)}
              >
                复制
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* token 列表 */}
      {loading ? (
        <div style={{ color: "var(--text-tertiary)", fontSize: 13, padding: "var(--space-3)" }}>
          加载中...
        </div>
      ) : tokens.length === 0 ? (
        <div
          style={{
            padding: "var(--space-3)",
            background: "var(--bg-card)",
            border: "1px solid var(--border-primary)",
            borderRadius: "var(--radius-lg)",
            color: "var(--text-tertiary)",
            fontSize: 13,
          }}
        >
          暂无 Join Token
        </div>
      ) : (
        <div style={tableCardStyle}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={thStyle}>Token（前缀）</th>
                <th style={thStyle}>过期时间</th>
                <th style={thStyle}>使用次数</th>
                <th style={thStyle}>状态</th>
                <th style={thStyle}>操作</th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => {
                const expired = new Date(t.expires_at).getTime() < Date.now();
                const exhausted = t.use_count >= t.max_uses;
                const active = !expired && !exhausted;
                return (
                  <tr key={t.id}>
                    <td style={tdStyle}>
                      <code style={tokenMonoStyle}>
                        {t.token.slice(0, 16)}…{t.token.slice(-6)}
                      </code>
                    </td>
                    <td style={tdStyle}>
                      {new Date(t.expires_at).toLocaleString("zh-CN")}
                    </td>
                    <td style={tdStyle}>
                      {t.use_count} / {t.max_uses}
                    </td>
                    <td style={tdStyle}>
                      <Badge variant={active ? "success" : "default"}>
                        {active ? "可用" : expired ? "已过期" : "已用尽"}
                      </Badge>
                    </td>
                    <td style={tdStyle}>
                      <Button
                        variant="danger"
                        size="sm"
                        icon={<Trash2 size={12} />}
                        onClick={() => onDelete(t.id)}
                      >
                        撤销
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
