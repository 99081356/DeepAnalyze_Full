import { useEffect, useState } from "react";
import { api, type MeResponse, type OrgNode, type PendingWorker, type UserListResponse } from "../api/client.js";

export function Dashboard() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [orgCount, setOrgCount] = useState<number>(0);
  const [userCount, setUserCount] = useState<number>(0);
  const [workerCount, setWorkerCount] = useState<number>(0);
  const [pendingCount, setPendingCount] = useState<number>(0);

  useEffect(() => {
    Promise.allSettled([
      api.me(),
      api.getOrgs(),
      api.getUsers({ limit: 1 }),
      api.getAllWorkers(),
      api.getPendingWorkers(),
    ]).then((results) => {
      if (results[0].status === "fulfilled") setMe(results[0].value);
      if (results[1].status === "fulfilled") setOrgCount(results[1].value.organizations.length);
      if (results[2].status === "fulfilled") setUserCount(results[2].value.total);
      if (results[3].status === "fulfilled") setWorkerCount(results[3].value.workers.length);
      if (results[4].status === "fulfilled") setPendingCount(results[4].value.workers.length);
    });
  }, []);

  const cards = [
    { label: "组织总数", value: orgCount, color: "#3b82f6" },
    { label: "用户总数", value: userCount, color: "#10b981" },
    { label: "Worker 节点", value: workerCount, color: "#8b5cf6" },
    { label: "待审批", value: pendingCount, color: pendingCount > 0 ? "#ef4444" : "#6b7280" },
  ];

  return (
    <div>
      <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 20 }}>欢迎{me ? `, ${me.display_name || me.username}` : ""}</h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 16 }}>
        {cards.map((card) => (
          <div key={card.label} style={{
            background: "white",
            padding: 20,
            borderRadius: 8,
            borderLeft: `4px solid ${card.color}`,
          }}>
            <div style={{ fontSize: 13, color: "#6b7280" }}>{card.label}</div>
            <div style={{ fontSize: 32, fontWeight: 600, color: card.color, marginTop: 8 }}>{card.value}</div>
          </div>
        ))}
      </div>
      {pendingCount > 0 && (
        <div style={{
          marginTop: 24, padding: 16, background: "#fef3c7", border: "1px solid #fde68a",
          borderRadius: 8, color: "#92400e", fontSize: 14,
        }}>
          有 {pendingCount} 个 Worker 待审批，请到"Worker 审批"页面处理。
        </div>
      )}
    </div>
  );
}
