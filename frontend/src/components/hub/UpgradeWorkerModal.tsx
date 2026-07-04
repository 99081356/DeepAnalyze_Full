import { useState, type CSSProperties } from "react";
import { Modal } from "../ui/Modal.js";
import { Button } from "../ui/Button.js";
import { ImageTagSelect } from "./ImageTagSelect.js";
import { api } from "../../api/client.js";
import { useUIStore } from "../../store/ui.js";

/* -------------------------------------------------------------------------- */
/*  Props                                                                     */
/* -------------------------------------------------------------------------- */

export interface UpgradeWorkerModalProps {
  workerId: string;
  currentTag: string | null;
  hostname: string;
  open: boolean;
  onClose: () => void;
  onUpgraded: () => void;
}

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

export function UpgradeWorkerModal({
  workerId,
  currentTag,
  hostname,
  open,
  onClose,
  onUpgraded,
}: UpgradeWorkerModalProps) {
  const [toTag, setToTag] = useState("");
  const [upgrading, setUpgrading] = useState(false);
  const [result, setResult] = useState<{
    jobId?: string;
    backupId?: string;
  } | null>(null);
  const addToast = useUIStore((s) => s.addToast);

  const handleUpgrade = async () => {
    if (!toTag) return;
    if (toTag === currentTag) {
      addToast("error", "目标版本与当前版本相同");
      return;
    }
    setUpgrading(true);
    setResult(null);
    try {
      const res = await api.deploy.upgrade(workerId, toTag);
      setResult({
        jobId: res.jobId,
        backupId: res.backupId,
      });
      addToast("success", `升级任务已启动：${hostname}`);
      onUpgraded();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "升级失败";
      addToast("error", `升级失败: ${msg}`);
    } finally {
      setUpgrading(false);
    }
  };

  /* -- styles -- */

  const infoBoxStyle: CSSProperties = {
    marginTop: "var(--space-3)",
    padding: "var(--space-2) var(--space-3)",
    background: "var(--info-light)",
    border: "1px solid var(--info)",
    borderRadius: "var(--radius-md)",
    fontSize: "var(--text-sm)",
  };

  const rowStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-3)",
    marginTop: "var(--space-3)",
  };

  const actionsStyle: CSSProperties = {
    display: "flex",
    justifyContent: "flex-end",
    gap: "var(--space-2)",
    marginTop: "var(--space-4)",
  };

  const labelStyle: CSSProperties = {
    color: "var(--text-secondary)",
    fontSize: "var(--text-sm)",
  };

  const monoStyle: CSSProperties = {
    fontFamily: "var(--font-mono)",
  };

  return (
    <Modal open={open} onClose={onClose} title="升级 Worker" size="md">
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-2)",
        }}
      >
        <div>
          <span style={labelStyle}>目标 Worker：</span>
          <span style={monoStyle}>{hostname}</span>
        </div>
        <div>
          <span style={labelStyle}>当前版本：</span>
          <span style={monoStyle}>{currentTag ?? "（未设置）"}</span>
        </div>

        <div style={rowStyle}>
          <label
            style={{
              minWidth: 80,
              fontSize: "var(--text-sm)",
              color: "var(--text-secondary)",
            }}
          >
            目标版本：
          </label>
          <div style={{ flex: 1 }}>
            <ImageTagSelect
              value={toTag}
              onChange={setToTag}
              disabled={upgrading}
            />
          </div>
        </div>

        {result?.jobId && (
          <div style={infoBoxStyle}>
            升级任务已创建：
            <code style={monoStyle}>{result.jobId}</code>
            {result.backupId && (
              <>
                {" "}
                （备份 ID：
                <code style={monoStyle}>{result.backupId}</code>）
              </>
            )}
          </div>
        )}

        <div style={actionsStyle}>
          <Button
            variant="secondary"
            size="md"
            onClick={onClose}
            disabled={upgrading}
          >
            关闭
          </Button>
          <Button
            variant="primary"
            size="md"
            onClick={handleUpgrade}
            disabled={!toTag || upgrading || toTag === currentTag}
            loading={upgrading}
          >
            确认升级
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export default UpgradeWorkerModal;
