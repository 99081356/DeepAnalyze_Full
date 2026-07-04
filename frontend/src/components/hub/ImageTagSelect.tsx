import { useEffect, useState, type CSSProperties } from "react";
import { api, type BundleManifestInfo } from "../../api/client.js";
import { Select } from "../ui/Select.js";

export interface ImageTagSelectProps {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}

export function ImageTagSelect({ value, onChange, disabled }: ImageTagSelectProps) {
  const [manifests, setManifests] = useState<BundleManifestInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp = await api.getBundleManifests();
        if (!cancelled) {
          setManifests(resp.manifests);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load image tags");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const options = manifests.map((m) => ({
    value: m.da_image_tag,
    label: `${m.da_image_tag} · ${m.image_name} · ${
      m.file_size ? `${(m.file_size / 1e9).toFixed(2)}GB` : "未知大小"
    } · ${new Date(m.uploaded_at).toLocaleDateString("zh-CN")}`,
  }));

  if (loading) {
    return (
      <div
        style={{
          padding: "var(--space-3)",
          fontSize: "var(--text-sm)",
          color: "var(--text-tertiary)",
        }}
      >
        加载镜像列表...
      </div>
    );
  }

  if (error) {
    return (
      <div
        style={{
          padding: "var(--space-3)",
          background: "var(--error-light)",
          border: "1px solid var(--error)",
          borderRadius: "var(--radius-md)",
          fontSize: "var(--text-sm)",
          color: "var(--error-dark)",
        }}
      >
        {error}
      </div>
    );
  }

  if (options.length === 0) {
    return (
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
        暂无可用镜像。请先用 da-packer 推送一个 bundle。
      </div>
    );
  }

  return (
    <Select
      value={value}
      onChange={onChange}
      options={options}
      placeholder="选择镜像版本..."
      searchable
      disabled={disabled}
      aria-label="镜像版本"
    />
  );
}

export default ImageTagSelect;
