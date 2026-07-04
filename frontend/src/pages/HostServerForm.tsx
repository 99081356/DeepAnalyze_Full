import { useEffect, useState, useCallback, type CSSProperties } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import {
  api,
  type CreateHostServerInput,
  type HostServer,
} from "../api/client.js";
import { Button } from "../components/ui/Button.js";
import { useUIStore } from "../store/ui.js";

/* -------------------------------------------------------------------------- */
/*  Form state                                                                */
/* -------------------------------------------------------------------------- */

interface FormState {
  hostname: string;
  ssh_target_host: string;
  ssh_target_port: string;
  ssh_user: string;
  port_range_start: string;
  port_range_end: string;
  port_block_size: string;
  cpu_cores: string;
  memory_gb: string;
  gpu_count: string;
  gpu_vram_mb: string;
  gpu_model: string;
  notes: string;
}

const EMPTY_FORM: FormState = {
  hostname: "",
  ssh_target_host: "",
  ssh_target_port: "22",
  ssh_user: "root",
  port_range_start: "30000",
  port_range_end: "32767",
  port_block_size: "10",
  cpu_cores: "",
  memory_gb: "",
  gpu_count: "0",
  gpu_vram_mb: "",
  gpu_model: "",
  notes: "",
};

function toFormState(hs: HostServer): FormState {
  return {
    hostname: hs.hostname,
    ssh_target_host: hs.ssh_target_host,
    ssh_target_port: String(hs.ssh_target_port),
    ssh_user: hs.ssh_user,
    port_range_start: String(hs.port_range_start),
    port_range_end: String(hs.port_range_end),
    port_block_size: String(hs.port_block_size),
    cpu_cores: hs.cpu_cores != null ? String(hs.cpu_cores) : "",
    memory_gb: hs.memory_gb != null ? String(hs.memory_gb) : "",
    gpu_count: String(hs.gpu_count),
    gpu_vram_mb: hs.gpu_vram_mb != null ? String(hs.gpu_vram_mb) : "",
    gpu_model: hs.gpu_model ?? "",
    notes: hs.notes ?? "",
  };
}

function buildInput(
  f: FormState,
  isEdit: boolean,
): CreateHostServerInput {
  const num = (s: string): number | undefined => {
    const s2 = s.trim();
    if (s2 === "") return undefined;
    const n = Number(s2);
    return Number.isFinite(n) ? n : undefined;
  };
  const input: CreateHostServerInput = {
    hostname: f.hostname.trim(),
    ssh_target_host: f.ssh_target_host.trim(),
    ssh_target_port: num(f.ssh_target_port),
    ssh_user: f.ssh_user.trim() || undefined,
    port_range_start: num(f.port_range_start),
    port_range_end: num(f.port_range_end),
    port_block_size: num(f.port_block_size),
    cpu_cores: num(f.cpu_cores),
    memory_gb: num(f.memory_gb),
    gpu_count: num(f.gpu_count),
    gpu_vram_mb: num(f.gpu_vram_mb),
    gpu_model: f.gpu_model.trim() || undefined,
    notes: f.notes.trim() || undefined,
  };
  // On edit, drop undefined fields so PATCH doesn't null them out unexpectedly.
  if (isEdit) {
    Object.keys(input).forEach((k) => {
      if (input[k as keyof CreateHostServerInput] === undefined) {
        delete input[k as keyof CreateHostServerInput];
      }
    });
  }
  return input;
}

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

export function HostServerForm() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const addToast = useUIStore((s) => s.addToast);
  const isEdit = Boolean(id);

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const hs = await api.getHostServer(id);
      setForm(toFormState(hs));
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载物理机失败");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const handleChange = (field: keyof FormState, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!form.hostname.trim() || !form.ssh_target_host.trim()) {
      setError("hostname 和 ssh_target_host 为必填项");
      return;
    }

    setSaving(true);
    try {
      const input = buildInput(form, isEdit);
      let savedId: string;
      if (isEdit && id) {
        const updated = await api.updateHostServer(id, input);
        savedId = updated.id;
        addToast("success", "已更新");
      } else {
        const created = await api.createHostServer(input);
        savedId = created.id;
        addToast("success", "已创建");
      }
      navigate(`/host-servers/${savedId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
      addToast("error", err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  /* -- styles -- */

  const pageStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-5)",
    maxWidth: 800,
  };

  const backLinkStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--space-1)",
    color: "var(--text-secondary)",
    textDecoration: "none",
    fontSize: "var(--text-sm)",
  };

  const titleStyle: CSSProperties = {
    fontSize: "var(--text-xl)",
    fontWeight: "var(--font-semibold)" as unknown as number,
    color: "var(--text-primary)",
    margin: 0,
  };

  const loadingStyle: CSSProperties = {
    padding: "var(--space-10)",
    textAlign: "center",
    color: "var(--text-tertiary)",
    fontSize: "var(--text-sm)",
  };

  const errorStyle: CSSProperties = {
    padding: "var(--space-3) var(--space-4)",
    background: "var(--error-light)",
    border: "1px solid var(--error)",
    borderRadius: "var(--radius-lg)",
    color: "var(--error-dark)",
    fontSize: "var(--text-sm)",
  };

  const cardStyle: CSSProperties = {
    background: "var(--bg-card)",
    border: "1px solid var(--border-primary)",
    borderRadius: "var(--radius-xl)",
    padding: "var(--space-5)",
  };

  const gridStyle: CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
    gap: "var(--space-4)",
  };

  const labelStyle: CSSProperties = {
    display: "block",
    fontSize: "var(--text-xs)",
    color: "var(--text-secondary)",
    marginBottom: "var(--space-1)",
  };

  const inputStyle: CSSProperties = {
    width: "100%",
    padding: "var(--space-2) var(--space-3)",
    fontSize: "var(--text-sm)",
    color: "var(--text-primary)",
    background: "var(--bg-page)",
    border: "1px solid var(--border-primary)",
    borderRadius: "var(--radius-md)",
    boxSizing: "border-box",
    outline: "none",
  };

  const textareaStyle: CSSProperties = {
    ...inputStyle,
    minHeight: 80,
    resize: "vertical",
    fontFamily: "inherit",
  };

  const footnoteStyle: CSSProperties = {
    fontSize: "var(--text-xs)",
    color: "var(--text-tertiary)",
    marginTop: "var(--space-1)",
  };

  const actionRowStyle: CSSProperties = {
    display: "flex",
    gap: "var(--space-3)",
    justifyContent: "flex-end",
  };

  if (loading) return <div style={loadingStyle}>加载中...</div>;

  return (
    <div style={pageStyle}>
      <Link to={isEdit ? `/host-servers/${id}` : "/host-servers"} style={backLinkStyle}>
        <ArrowLeft size={14} />
        返回
      </Link>

      <h2 style={titleStyle}>{isEdit ? "编辑物理机" : "注册新物理机"}</h2>

      {error && <div style={errorStyle}>{error}</div>}

      <form onSubmit={handleSubmit} style={cardStyle}>
        <div style={gridStyle}>
          <div>
            <label style={labelStyle}>Hostname *</label>
            <input
              value={form.hostname}
              onChange={(e) => handleChange("hostname", e.target.value)}
              style={inputStyle}
              placeholder="gpu-node-01"
              autoFocus
            />
          </div>

          <div>
            <label style={labelStyle}>SSH Target Host *</label>
            <input
              value={form.ssh_target_host}
              onChange={(e) => handleChange("ssh_target_host", e.target.value)}
              style={inputStyle}
              placeholder="192.168.1.10"
            />
          </div>

          <div>
            <label style={labelStyle}>SSH Port</label>
            <input
              type="number"
              value={form.ssh_target_port}
              onChange={(e) => handleChange("ssh_target_port", e.target.value)}
              style={inputStyle}
            />
          </div>

          <div>
            <label style={labelStyle}>SSH User</label>
            <input
              value={form.ssh_user}
              onChange={(e) => handleChange("ssh_user", e.target.value)}
              style={inputStyle}
            />
          </div>

          <div>
            <label style={labelStyle}>Port Range Start</label>
            <input
              type="number"
              value={form.port_range_start}
              onChange={(e) => handleChange("port_range_start", e.target.value)}
              style={inputStyle}
            />
          </div>

          <div>
            <label style={labelStyle}>Port Range End</label>
            <input
              type="number"
              value={form.port_range_end}
              onChange={(e) => handleChange("port_range_end", e.target.value)}
              style={inputStyle}
            />
          </div>

          <div>
            <label style={labelStyle}>Port Block Size</label>
            <input
              type="number"
              value={form.port_block_size}
              onChange={(e) => handleChange("port_block_size", e.target.value)}
              style={inputStyle}
            />
            <div style={footnoteStyle}>
              每个 worker 占用的连续端口数（端口段大小）
            </div>
          </div>

          <div>
            <label style={labelStyle}>CPU Cores</label>
            <input
              type="number"
              value={form.cpu_cores}
              onChange={(e) => handleChange("cpu_cores", e.target.value)}
              style={inputStyle}
              placeholder="可选"
            />
          </div>

          <div>
            <label style={labelStyle}>Memory (GB)</label>
            <input
              type="number"
              value={form.memory_gb}
              onChange={(e) => handleChange("memory_gb", e.target.value)}
              style={inputStyle}
              placeholder="可选"
            />
          </div>

          <div>
            <label style={labelStyle}>GPU Count</label>
            <input
              type="number"
              value={form.gpu_count}
              onChange={(e) => handleChange("gpu_count", e.target.value)}
              style={inputStyle}
            />
          </div>

          <div>
            <label style={labelStyle}>GPU VRAM (MB)</label>
            <input
              type="number"
              value={form.gpu_vram_mb}
              onChange={(e) => handleChange("gpu_vram_mb", e.target.value)}
              style={inputStyle}
              placeholder="可选"
            />
          </div>

          <div>
            <label style={labelStyle}>GPU Model</label>
            <input
              value={form.gpu_model}
              onChange={(e) => handleChange("gpu_model", e.target.value)}
              style={inputStyle}
              placeholder="可选"
            />
          </div>
        </div>

        <div style={{ gridColumn: "1 / -1", marginTop: "var(--space-4)" }}>
          <label style={labelStyle}>Notes</label>
          <textarea
            value={form.notes}
            onChange={(e) => handleChange("notes", e.target.value)}
            style={textareaStyle}
            placeholder="机房位置、负责人、用途等备注"
          />
        </div>

        {/* SSH key 字段暂未实现 — 需要后端先支持加密存储。
            见 T06 brief 中"do NOT include SSH key field"说明。*/}

        <div style={{ ...actionRowStyle, marginTop: "var(--space-5)" }}>
          <Link to={isEdit ? `/host-servers/${id}` : "/host-servers"}>
            <Button variant="secondary" size="md" type="button">
              取消
            </Button>
          </Link>
          <Button
            variant="primary"
            size="md"
            type="submit"
            loading={saving}
            disabled={saving}
          >
            {isEdit ? "保存修改" : "创建"}
          </Button>
        </div>
      </form>
    </div>
  );
}
