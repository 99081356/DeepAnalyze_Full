import { useState, useEffect, useCallback, type CSSProperties } from "react";
import { api, type OrgNode } from "../../api/client.js";
import { Modal } from "../ui/Modal.js";
import { Button } from "../ui/Button.js";
import { Input } from "../ui/Input.js";
import { Select } from "../ui/Select.js";
import { TextArea } from "../ui/TextArea.js";
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
  ssh_host: string;
  ssh_port: string; // Input gives string; convert at submit time
  ssh_user: string;
  ssh_private_key: string;
  image_tag: string;
  assigned_user_id: string;
  dry_run: boolean;
}

const defaultForm: DeployForm = {
  organization_id: "",
  ssh_host: "",
  ssh_port: "22",
  ssh_user: "ubuntu",
  ssh_private_key: "",
  image_tag: "da-base-v0.9.0-amd64",
  assigned_user_id: "",
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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* ----- fetch orgs once when first opened ----- */

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const resp = await api.getOrgs();
        if (!cancelled) setOrgs(resp.organizations);
      } catch {
        // Silently ignore — org select just falls back to manual entry
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

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

  /* ----- submit ----- */

  const submit = async () => {
    setError(null);

    // Basic validation
    if (!form.organization_id) {
      setError("请选择所属组织");
      return;
    }
    if (!form.ssh_host.trim()) {
      setError("请填写 SSH 主机地址");
      return;
    }
    if (!form.ssh_private_key.trim()) {
      setError("请填写 SSH 私钥");
      return;
    }

    setSubmitting(true);
    try {
      const port = parseInt(form.ssh_port, 10);
      const result = await api.deploy.create({
        organization_id: form.organization_id,
        ssh_host: form.ssh_host.trim(),
        ssh_port: isNaN(port) ? 22 : port,
        ssh_user: form.ssh_user.trim() || "ubuntu",
        ssh_private_key: form.ssh_private_key,
        image_tag: form.image_tag.trim() || "da-base-v0.9.0-amd64",
        assigned_user_id: form.assigned_user_id.trim() || undefined,
        dry_run: form.dry_run,
      });

      const verb = form.dry_run ? "预检完成" : "部署任务已创建";
      addToast(
        "success",
        `${verb}：job_id=${result.job_id.slice(0, 12)} (status=${result.status})`,
      );
      onDeployed();
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
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

  const orgOptions = orgs.map((o) => ({
    value: o.id,
    label: `${o.name} (${o.code})`,
  }));

  /* ------------------------------------------------------------------ */
  /*  Render                                                             */
  /* ------------------------------------------------------------------ */

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="远程部署 Worker"
      size="lg"
    >
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

        {/* SSH host + port */}
        <div style={rowStyle}>
          <Input
            label="SSH 主机 *"
            value={form.ssh_host}
            onChange={(e) => update("ssh_host", e.target.value)}
            placeholder="192.168.1.100 或 worker.example.com"
            hint="目标机器的 IPv4/IPv6/域名"
          />
          <Input
            label="SSH 端口"
            type="number"
            value={form.ssh_port}
            onChange={(e) => update("ssh_port", e.target.value)}
            placeholder="22"
          />
        </div>

        {/* SSH user + image_tag */}
        <div style={rowStyle}>
          <Input
            label="SSH 用户"
            value={form.ssh_user}
            onChange={(e) => update("ssh_user", e.target.value)}
            placeholder="ubuntu"
          />
          <Input
            label="镜像标签"
            value={form.image_tag}
            onChange={(e) => update("image_tag", e.target.value)}
            placeholder="da-base-v0.9.0-amd64"
          />
        </div>

        {/* SSH private key */}
        <TextArea
          label="SSH 私钥 (PEM) *"
          value={form.ssh_private_key}
          onChange={(v) => update("ssh_private_key", v)}
          placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----"}
          rows={6}
        />

        {/* assigned_user_id */}
        <Input
          label="指定用户（可选）"
          value={form.assigned_user_id}
          onChange={(e) => update("assigned_user_id", e.target.value)}
          placeholder="user UUID — 留空则绑定到组织"
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
            预检模式 (dry_run) — 仅验证 SSH/Docker，不实际部署
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
          <Button
            variant="primary"
            loading={submitting}
            onClick={submit}
          >
            {form.dry_run ? "预检" : "部署"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export default DeployWorkerModal;
