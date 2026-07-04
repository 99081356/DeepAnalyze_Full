import { useState, useEffect, useCallback, type CSSProperties } from "react";
import {
  api,
  type OrgNode,
  type HostServer,
  type PortUsageEntry,
} from "../../api/client.js";
import { Modal } from "../ui/Modal.js";
import { Button } from "../ui/Button.js";
import { Input } from "../ui/Input.js";
import { Select } from "../ui/Select.js";
import { ImageTagSelect } from "./ImageTagSelect.js";
import { useUIStore } from "../../store/ui.js";

/* -------------------------------------------------------------------------- */
/*  Props                                                                     */
/* -------------------------------------------------------------------------- */

export interface DeployWorkerModalProps {
  open: boolean;
  onClose: () => void;
  onDeployed: () => void;
}

/* -------------------------------------------------------------------------- */
/*  Form state shape                                                          */
/* -------------------------------------------------------------------------- */

interface DeployForm {
  organization_id: string;
  host_server_id: string;
  image_tag: string;
  assigned_user_id: string;
  cpu_limit: number;
  mem_limit_mb: number;
  gpu_device: string; // Input gives string; convert at submit
  dry_run: boolean;
}

const defaultForm: DeployForm = {
  organization_id: "",
  host_server_id: "",
  image_tag: "",
  assigned_user_id: "",
  cpu_limit: 4,
  mem_limit_mb: 8192,
  gpu_device: "",
  dry_run: false,
};

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

export function DeployWorkerModal({
  open,
  onClose,
  onDeployed,
}: DeployWorkerModalProps) {
  const addToast = useUIStore((s) => s.addToast);

  const [form, setForm] = useState<DeployForm>(defaultForm);
  const [orgs, setOrgs] = useState<OrgNode[]>([]);
  const [hostServers, setHostServers] = useState<HostServer[]>([]);
  const [portUsage, setPortUsage] = useState<PortUsageEntry[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* ----- fetch orgs + host_servers when modal opens ----- */

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const [orgResp, hsResp] = await Promise.all([
          api.getOrgs(),
          api.getHostServers(),
        ]);
        if (!cancelled) {
          setOrgs(orgResp.organizations);
          setHostServers(hsResp.items);
        }
      } catch {
        // Silently ignore — selects fall back to empty
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  /* ----- fetch port usage when host_server changes ----- */

  useEffect(() => {
    if (!open || !form.host_server_id) {
      setPortUsage([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const resp = await api.getHostServerPortUsage(form.host_server_id);
        if (!cancelled) setPortUsage(resp.allocated);
      } catch {
        if (!cancelled) setPortUsage([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, form.host_server_id]);

  /* ----- reset form when modal closes ----- */

  useEffect(() => {
    if (!open) {
      setForm(defaultForm);
      setError(null);
    }
  }, [open]);

  /* ----- field update helper ----- */

  const update = useCallback(
    <K extends keyof DeployForm>(key: K, value: DeployForm[K]) => {
      setForm((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  /* ----- preview port: first free block in port usage ----- */

  const previewPort = portUsage.find((u) => !u.worker_id)?.base_port ?? null;
  const selectedHostServer = hostServers.find((h) => h.id === form.host_server_id);

  /* ----- submit ----- */

  const submit = async () => {
    setError(null);

    if (!form.organization_id) {
      setError("请选择所属组织");
      return;
    }
    if (!form.host_server_id) {
      setError("请选择目标物理机");
      return;
    }
    if (!form.image_tag) {
      setError("请选择镜像版本");
      return;
    }

    setSubmitting(true);
    try {
      const gpuNum = form.gpu_device.trim()
        ? parseInt(form.gpu_device, 10)
        : undefined;
      const result = await api.deploy.create({
        organization_id: form.organization_id,
        host_server_id: form.host_server_id,
        image_tag: form.image_tag,
        assigned_user_id: form.assigned_user_id.trim() || undefined,
        dry_run: form.dry_run,
        cpu_limit: form.cpu_limit,
        mem_limit_mb: form.mem_limit_mb,
        gpu_device: isNaN(gpuNum as number) ? undefined : gpuNum,
      });

      const portInfo = result.host_port
        ? ` · host_port=${result.host_port}`
        : "";
      const verb = form.dry_run ? "预检完成" : "部署任务已创建";
      addToast(
        "success",
        `${verb}：job_id=${result.job_id.slice(0, 12)} (status=${result.status}${portInfo})`,
      );
      onDeployed();
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      addToast("error", msg);
    } finally {
      setSubmitting(false);
    }
  };

  /* ------------------------------------------------------------------ */
  /*  Styles                                                             */
  /* ------------------------------------------------------------------ */

  const formStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-4)",
  };

  const rowStyle: CSSProperties = {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "var(--space-3)",
  };

  const fieldLabelStyle: CSSProperties = {
    fontSize: "var(--text-sm)",
    fontWeight: "var(--font-medium)" as unknown as number,
    color: "var(--text-primary)",
    marginBottom: "var(--space-1)",
  };

  const toggleRowStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
  };

  const errorBoxStyle: CSSProperties = {
    padding: "var(--space-3)",
    background: "var(--error-light)",
    border: "1px solid var(--error)",
    borderRadius: "var(--radius-md)",
    color: "var(--error-dark)",
    fontSize: "var(--text-sm)",
  };

  /* ------------------------------------------------------------------ */
  /*  Render                                                             */
  /* ------------------------------------------------------------------ */

  const orgOptions = orgs.map((o) => ({
    value: o.id,
    label: `${o.name} (${o.code})`,
  }));
  const hostServerOptions = hostServers
    .filter((h) => h.status === "active")
    .map((h) => ({
      value: h.id,
      label: `${h.hostname} (${h.ssh_target_host}) · ${h.gpu_count} GPU`,
    }));

  return (
    <Modal open={open} onClose={onClose} title="部署新 Worker" size="lg">
      <div style={formStyle}>
        {error && <div style={errorBoxStyle}>{error}</div>}

        {/* Organization */}
        <div>
          <div style={fieldLabelStyle}>所属组织 *</div>
          {orgOptions.length > 0 ? (
            <Select
              value={form.organization_id}
              onChange={(v) => update("organization_id", v)}
              options={orgOptions}
              placeholder="选择组织..."
              searchable
              aria-label="所属组织"
            />
          ) : (
            <Input
              value={form.organization_id}
              onChange={(e) => update("organization_id", e.target.value)}
              placeholder="organization_id（UUID）"
            />
          )}
        </div>

        {/* Host server */}
        <div>
          <div style={fieldLabelStyle}>目标物理机 *</div>
          {hostServerOptions.length > 0 ? (
            <Select
              value={form.host_server_id}
              onChange={(v) => update("host_server_id", v)}
              options={hostServerOptions}
              placeholder="选择物理机..."
              searchable
              aria-label="目标物理机"
            />
          ) : (
            <div
              style={{
                padding: "var(--space-3)",
                background: "var(--warning-light)",
                border: "1px solid var(--warning)",
                borderRadius: "var(--radius-md)",
                fontSize: "var(--text-sm)",
                color: "var(--text-primary)",
              }}
            >
              暂无可用物理机。请先到 <b>/host-servers</b> 注册一台 active 状态的物理机（含 SSH key）。
            </div>
          )}
        </div>

        {/* Port preview */}
        {previewPort !== null && selectedHostServer && (
          <div
            style={{
              padding: "var(--space-3)",
              background: "var(--bg-tertiary)",
              border: "1px solid var(--border-primary)",
              borderRadius: "var(--radius-md)",
              fontSize: "var(--text-sm)",
              color: "var(--text-secondary)",
            }}
          >
            预计分配端口段：<b>{previewPort}-{previewPort + 6}</b>
            （实际端口以部署结果为准；容器内端口固定 21000）
          </div>
        )}

        {/* Image tag */}
        <div>
          <div style={fieldLabelStyle}>镜像版本 *</div>
          <ImageTagSelect
            value={form.image_tag}
            onChange={(v) => update("image_tag", v)}
          />
        </div>

        {/* Assigned user */}
        <Input
          label="指定用户（可选）"
          value={form.assigned_user_id}
          onChange={(e) => update("assigned_user_id", e.target.value)}
          placeholder="user UUID — 留空则绑定到组织"
        />

        {/* CPU + MEM */}
        <div style={rowStyle}>
          <Input
            label="CPU 核数"
            type="number"
            value={String(form.cpu_limit)}
            onChange={(e) => update("cpu_limit", parseInt(e.target.value, 10) || 0)}
          />
          <Input
            label="内存 (MB)"
            type="number"
            value={String(form.mem_limit_mb)}
            onChange={(e) => update("mem_limit_mb", parseInt(e.target.value, 10) || 0)}
          />
        </div>

        {/* GPU device (optional) */}
        <Input
          label="GPU 设备号（可选）"
          value={form.gpu_device}
          onChange={(e) => update("gpu_device", e.target.value)}
          placeholder="例如 0 — 留空则不指定"
        />

        {/* dry-run toggle */}
        <div style={toggleRowStyle}>
          <input
            id="deploy-dry-run"
            type="checkbox"
            checked={form.dry_run}
            onChange={(e) => update("dry_run", e.target.checked)}
          />
          <label
            htmlFor="deploy-dry-run"
            style={{
              fontSize: "var(--text-sm)",
              color: "var(--text-primary)",
              cursor: "pointer",
            }}
          >
            预检模式 (dry_run) — 仅验证 SSH/Docker/端口，不实际部署
          </label>
        </div>

        {/* Actions */}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: "var(--space-2)",
            marginTop: "var(--space-2)",
          }}
        >
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button variant="primary" loading={submitting} onClick={submit}>
            {form.dry_run ? "预检" : "部署"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export default DeployWorkerModal;
