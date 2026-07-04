import { useEffect, useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import {
  Package,
  Building2,
  Server,
  Share2,
  AlertCircle,
  Plus,
  UserPlus,
  Building,
  Zap,
} from "lucide-react";
import { api, type MeResponse } from "../api/client.js";
import { Button } from "../components/ui/Button.js";
import { Badge } from "../components/ui/Badge.js";
import { OpenMyDAButton } from "../components/hub/OpenMyDAButton.js";

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

interface DashData {
  me: MeResponse | null;
  orgCount: number;
  skillCount: number;
  workerTotal: number;
  workerOnline: number;
  sharingCount: number;
  pendingCount: number;
}

/* -------------------------------------------------------------------------- */
/*  Stat card model                                                           */
/* -------------------------------------------------------------------------- */

interface StatCardDef {
  label: string;
  value: string;
  icon: React.ReactNode;
  to: string;
  iconBg: string;
}

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

export function Dashboard() {
  const [data, setData] = useState<DashData>({
    me: null,
    orgCount: 0,
    skillCount: 0,
    workerTotal: 0,
    workerOnline: 0,
    sharingCount: 0,
    pendingCount: 0,
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.allSettled([
      api.me(),
      api.getOrgs(),
      api.getRaw<{ items: unknown[] }>("GET", "/skills"),
      api.getAllWorkers(),
      api.getPendingWorkers(),
      api.listSharings(),
    ]).then((results) => {
      const next: DashData = { ...data };
      if (results[0].status === "fulfilled") next.me = results[0].value;
      if (results[1].status === "fulfilled")
        next.orgCount = results[1].value.organizations.length;
      if (results[2].status === "fulfilled") {
        const resp = results[2].value as { items?: unknown[] };
        next.skillCount = resp.items?.length ?? 0;
      }
      if (results[3].status === "fulfilled") {
        next.workerTotal = results[3].value.workers.length;
        next.workerOnline = results[3].value.workers.filter(
          (w) => w.status === "online" || w.status === "active",
        ).length;
      }
      if (results[4].status === "fulfilled")
        next.pendingCount = results[4].value.workers.length;
      if (results[5].status === "fulfilled")
        next.sharingCount = results[5].value.sharings.length;
      setData(next);
      setLoading(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* -- stat cards -- */

  const cards: StatCardDef[] = [
    {
      label: "组织总数",
      value: String(data.orgCount),
      icon: <Building2 size={22} />,
      to: "/orgs",
      iconBg: "var(--brand-primary)",
    },
    {
      label: "Skills",
      value: String(data.skillCount),
      icon: <Package size={22} />,
      to: "/skills",
      iconBg: "var(--info)",
    },
    {
      label: "Worker 节点",
      value: `${data.workerOnline}/${data.workerTotal}`,
      icon: <Server size={22} />,
      to: "/workers",
      iconBg: "var(--success)",
    },
    {
      label: "跨组织共享",
      value: String(data.sharingCount),
      icon: <Share2 size={22} />,
      to: "/sharings",
      iconBg: "var(--warning)",
    },
  ];

  /* -- styles -- */

  const pageStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-5)",
  };

  const headerStyle: CSSProperties = {
    fontSize: "var(--text-xl)",
    fontWeight: "var(--font-semibold)" as unknown as number,
    color: "var(--text-primary)",
  };

  /* -- pending alert -- */

  const alertStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-3)",
    padding: "var(--space-4) var(--space-5)",
    background: "var(--warning-light)",
    border: "1px solid var(--warning)",
    borderRadius: "var(--radius-xl)",
    color: "var(--warning-dark)",
    fontSize: "var(--text-sm)",
  };

  const alertLinkStyle: CSSProperties = {
    marginLeft: "auto",
    textDecoration: "none",
    flexShrink: 0,
  };

  /* -- stat card grid -- */

  const gridStyle: CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: "var(--space-4)",
  };

  const cardLinkStyle: CSSProperties = {
    textDecoration: "none",
  };

  const cardStyle: CSSProperties = {
    background: "var(--bg-card)",
    border: "1px solid var(--border-primary)",
    borderRadius: "var(--radius-xl)",
    padding: "var(--space-5)",
    display: "flex",
    alignItems: "center",
    gap: "var(--space-4)",
    transition: "all var(--transition-fast)",
    cursor: "pointer",
  };

  const iconBoxStyle: CSSProperties = {
    width: 44,
    height: 44,
    minWidth: 44,
    borderRadius: "var(--radius-lg)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#ffffff",
  };

  const valueStyle: CSSProperties = {
    fontSize: "var(--text-2xl)",
    fontWeight: "var(--font-semibold)" as unknown as number,
    color: "var(--text-primary)",
    lineHeight: 1.1,
  };

  const labelStyle: CSSProperties = {
    fontSize: "var(--text-sm)",
    color: "var(--text-secondary)",
    marginTop: "var(--space-1)",
  };

  /* -- quick actions -- */

  const actionsPanelStyle: CSSProperties = {
    background: "var(--bg-card)",
    border: "1px solid var(--border-primary)",
    borderRadius: "var(--radius-xl)",
    padding: "var(--space-5)",
  };

  const actionsTitleStyle: CSSProperties = {
    fontSize: "var(--text-base)",
    fontWeight: "var(--font-semibold)" as unknown as number,
    color: "var(--text-primary)",
    marginBottom: "var(--space-4)",
  };

  const actionsGridStyle: CSSProperties = {
    display: "flex",
    flexWrap: "wrap",
    gap: "var(--space-3)",
  };

  if (loading) {
    return (
      <div
        style={{
          padding: "var(--space-10)",
          textAlign: "center",
          color: "var(--text-tertiary)",
          fontSize: "var(--text-sm)",
        }}
      >
        加载中...
      </div>
    );
  }

  return (
    <div style={pageStyle}>
      {/* Welcome header */}
      <h2 style={headerStyle}>
        欢迎{data.me ? `, ${data.me.display_name || data.me.username}` : ""}
      </h2>

      {/* Open my DA — primary user action */}
      {data.me && (
        <div style={{
          display: "flex",
          justifyContent: "flex-end",
          alignItems: "center",
          padding: "var(--space-3) var(--space-5)",
          background: "var(--bg-card)",
          borderRadius: "var(--radius-md)",
          marginBottom: "var(--space-4)",
        }}>
          <OpenMyDAButton
            workerId={data.me.da_worker_id}
            daUrl={data.me.da_url}
          />
        </div>
      )}

      {/* Pending worker alert */}
      {data.pendingCount > 0 && (
        <div style={alertStyle}>
          <AlertCircle size={20} style={{ flexShrink: 0 }} />
          <span>
            有 <strong>{data.pendingCount}</strong> 个 Worker 待审批，请到"Worker 审批"页面处理。
          </span>
          <Link to="/workers" style={alertLinkStyle}>
            <Badge variant="warning" size="md">
              前往处理
            </Badge>
          </Link>
        </div>
      )}

      {/* Stat cards */}
      <div style={gridStyle}>
        {cards.map((card) => (
          <Link key={card.label} to={card.to} style={cardLinkStyle}>
            <div
              style={cardStyle}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = "var(--brand-primary)";
                e.currentTarget.style.background = "var(--bg-hover)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = "var(--border-primary)";
                e.currentTarget.style.background = "var(--bg-card)";
              }}
            >
              <div style={{ ...iconBoxStyle, background: card.iconBg }}>
                {card.icon}
              </div>
              <div>
                <div style={valueStyle}>{card.value}</div>
                <div style={labelStyle}>{card.label}</div>
              </div>
            </div>
          </Link>
        ))}
      </div>

      {/* Quick actions */}
      <div style={actionsPanelStyle}>
        <div style={actionsTitleStyle}>快捷操作</div>
        <div style={actionsGridStyle}>
          <Link to="/skills" style={{ textDecoration: "none" }}>
            <Button variant="primary" size="md" icon={<Plus size={15} />}>
              创建 Skill
            </Button>
          </Link>
          <Link to="/orgs" style={{ textDecoration: "none" }}>
            <Button variant="secondary" size="md" icon={<Building size={15} />}>
              新建组织
            </Button>
          </Link>
          <Link to="/users" style={{ textDecoration: "none" }}>
            <Button variant="secondary" size="md" icon={<UserPlus size={15} />}>
              添加用户
            </Button>
          </Link>
          <Link to="/security" style={{ textDecoration: "none" }}>
            <Button variant="danger" size="md" icon={<Zap size={15} />}>
              Kill Switch
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
