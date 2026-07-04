import { useState } from "react";
import { Button } from "../ui/Button";
import { useUIStore } from "../../store/ui";
import { api } from "../../api/client";
import { ExternalLink } from "lucide-react";

interface OpenMyDAButtonProps {
  workerId: string | null;
  daUrl: string | null;
}

export function OpenMyDAButton({ workerId, daUrl }: OpenMyDAButtonProps) {
  const [loading, setLoading] = useState(false);
  const addToast = useUIStore((s) => s.addToast);

  const handleClick = async () => {
    if (!workerId) {
      addToast("warning", "未分配 DA 容器，请联系管理员");
      return;
    }
    setLoading(true);
    try {
      const data = await api.createSsoTicket(workerId);
      // T09's redirect_url is a fully-qualified URL pointing at DA's /api/auth/sso/callback
      window.location.href = data.redirect_url;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addToast("error", `无法获取 SSO ticket: ${msg}`);
      setLoading(false);
    }
  };

  if (!workerId || !daUrl) {
    return (
      <div style={{ color: "var(--text-secondary)", fontSize: 13 }}>
        未分配 DA 容器
      </div>
    );
  }

  return (
    <Button
      variant="primary"
      size="md"
      loading={loading}
      icon={<ExternalLink size={15} />}
      onClick={handleClick}
    >
      {loading ? "正在跳转..." : "打开我的 DA"}
    </Button>
  );
}
