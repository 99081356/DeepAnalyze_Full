import { useEffect, useState, useCallback } from "react";
import { api, type MeResponse } from "../api/client.js";

interface SkillPackage {
  id: string;
  name: string;
  slug: string;
  display_name: string;
  description: string | null;
  scope: "system" | "org" | "user";
  category: string;
  tags: string[];
  stats: { downloads: number; subscriptions: number; rating_avg: number };
  trust_level: string;
  is_kill_switched: boolean;
  created_at: string;
}

interface SkillVersion {
  id: string;
  version: string;
  status: string;
  content_hash: string;
  created_at: string;
  published_at: string | null;
  change_summary: string | null;
}

export function Skills({ user }: { user: MeResponse }) {
  const [packages, setPackages] = useState<SkillPackage[]>([]);
  const [selectedPkg, setSelectedPkg] = useState<SkillPackage | null>(null);
  const [versions, setVersions] = useState<SkillVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [newPkg, setNewPkg] = useState({
    name: "",
    description: "",
    scope: "user",
    version: "1.0.0",
    content: "",
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await api.getRaw<{ items: SkillPackage[]; total: number }>(
        "GET",
        `/skills?search=${encodeURIComponent(search)}`,
      );
      setPackages(resp.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load skills");
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    load();
  }, [load]);

  const loadVersions = useCallback(async (pkgId: string) => {
    try {
      const resp = await api.getRaw<{ versions: SkillVersion[] }>("GET", `/skills/${pkgId}/versions`);
      setVersions(resp.versions);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load versions");
    }
  }, []);

  const handleSelect = (pkg: SkillPackage) => {
    setSelectedPkg(pkg);
    loadVersions(pkg.id);
  };

  const handleCreate = async () => {
    if (!newPkg.name || !newPkg.content) return;
    try {
      // Step 1: create package
      const pkgResp = await api.createPackage({
        name: newPkg.name,
        description: newPkg.description,
        scope: newPkg.scope as "system" | "org" | "user",
      });
      // Step 2: add first version
      await api.createVersionRaw(pkgResp.package.id, {
        version: newPkg.version,
        content: newPkg.content,
      });
      setNewPkg({ name: "", description: "", scope: "user", version: "1.0.0", content: "" });
      setShowCreate(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create");
    }
  };

  const handleSubscribe = async (pkgId: string) => {
    try {
      await api.subscribeSkill(pkgId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    }
  };

  const handleUnsubscribe = async (pkgId: string) => {
    try {
      await api.unsubscribeSkill(pkgId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    }
  };

  const handleKillSwitch = async (pkgId: string, reason: string) => {
    if (!confirm(`激活 Kill Switch？原因: ${reason}`)) return;
    try {
      await api.killSwitchSkill(pkgId, reason);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    }
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
        <h2 style={{ fontSize: 20, fontWeight: 600 }}>Skills 市场 ({packages.length})</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && load()}
            placeholder="搜索..."
            style={inputStyle}
          />
          <button onClick={() => setShowCreate(!showCreate)} style={btnPrimary}>+ 新建</button>
        </div>
      </div>

      {showCreate && (
        <div style={{ background: "white", padding: 16, marginBottom: 16, borderRadius: 8 }}>
          <h3 style={{ fontSize: 15, fontWeight: 500, marginBottom: 12 }}>创建 Skill 包</h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 200px", gap: 12, marginBottom: 12 }}>
            <input placeholder="名称" value={newPkg.name} onChange={(e) => setNewPkg({ ...newPkg, name: e.target.value })} style={inputStyle} />
            <input placeholder="版本 (如 1.0.0)" value={newPkg.version} onChange={(e) => setNewPkg({ ...newPkg, version: e.target.value })} style={inputStyle} />
            <select value={newPkg.scope} onChange={(e) => setNewPkg({ ...newPkg, scope: e.target.value })} style={inputStyle}>
              <option value="user">user</option>
              <option value="org">org</option>
              {user.is_super_admin && <option value="system">system</option>}
            </select>
          </div>
          <input placeholder="描述（可选）" value={newPkg.description} onChange={(e) => setNewPkg({ ...newPkg, description: e.target.value })} style={{ ...inputStyle, width: "100%", marginBottom: 12 }} />
          <textarea
            placeholder="SKILL.md 内容"
            value={newPkg.content}
            onChange={(e) => setNewPkg({ ...newPkg, content: e.target.value })}
            style={{ ...inputStyle, width: "100%", minHeight: 120, fontFamily: "monospace", marginBottom: 12 }}
          />
          <button onClick={handleCreate} style={{ ...btnPrimary, background: "#059669" }}>创建</button>
        </div>
      )}

      {error && <div style={errStyle}>{error}</div>}

      <div style={{ display: "grid", gridTemplateColumns: selectedPkg ? "1fr 1fr" : "1fr", gap: 16 }}>
        <div style={{ display: "grid", gap: 8 }}>
          {loading ? (
            <div style={emptyStyle}>加载中...</div>
          ) : packages.length === 0 ? (
            <div style={emptyStyle}>无 Skills</div>
          ) : packages.map((pkg) => (
            <div
              key={pkg.id}
              onClick={() => handleSelect(pkg)}
              style={{
                background: "white", padding: 12, borderRadius: 8, cursor: "pointer",
                borderLeft: `4px solid ${pkg.scope === "system" ? "#dc2626" : pkg.scope === "org" ? "#2563eb" : "#10b981"}`,
                opacity: pkg.is_kill_switched ? 0.5 : 1,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <div>
                  <span style={{ fontWeight: 500 }}>{pkg.name}</span>
                  <span style={{ marginLeft: 8, fontSize: 11, padding: "1px 8px", borderRadius: 10, background: "#e5e7eb" }}>{pkg.scope}</span>
                  {pkg.is_kill_switched && <span style={{ marginLeft: 8, fontSize: 11, color: "#dc2626" }}>KILLED</span>}
                </div>
                <div style={{ fontSize: 11, color: "#6b7280" }}>
                  👥 {pkg.stats?.subscriptions ?? 0} · ⬇ {pkg.stats?.downloads ?? 0}
                </div>
              </div>
              {pkg.description && <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>{pkg.description}</div>}
            </div>
          ))}
        </div>

        {selectedPkg && (
          <div style={{ background: "white", padding: 16, borderRadius: 8 }}>
            <h3 style={{ fontSize: 16, fontWeight: 500, marginBottom: 8 }}>{selectedPkg.name}</h3>
            <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 12 }}>
              {selectedPkg.description || "无描述"}
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              <button onClick={() => handleSubscribe(selectedPkg.id)} style={{ ...btnPrimary, background: "#059669" }}>订阅</button>
              <button onClick={() => handleUnsubscribe(selectedPkg.id)} style={btnPrimary}>取消订阅</button>
              {(user.is_super_admin || user.is_org_admin) && (
                <button
                  onClick={() => handleKillSwitch(selectedPkg.id, prompt("Kill 原因:") || "test")}
                  style={{ ...btnPrimary, background: "#dc2626" }}
                  disabled={selectedPkg.is_kill_switched}
                >
                  Kill Switch
                </button>
              )}
            </div>
            <h4 style={{ fontSize: 13, fontWeight: 500, marginBottom: 8 }}>版本历史</h4>
            {versions.length === 0 ? (
              <div style={{ fontSize: 12, color: "#6b7280" }}>无版本</div>
            ) : (
              versions.map((v) => (
                <div key={v.id} style={{ padding: "6px 0", borderBottom: "1px solid #f3f4f6", fontSize: 12 }}>
                  <div>v{v.version} <span style={{ color: v.status === "published" ? "#059669" : "#6b7280", fontSize: 11 }}>({v.status})</span></div>
                  <div style={{ color: "#9ca3af", marginTop: 2 }}>
                    hash: {v.content_hash.slice(0, 12)} · {new Date(v.created_at).toLocaleString("zh-CN")}
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "6px 10px", border: "1px solid #d1d5db", borderRadius: 4, fontSize: 13,
};
const btnPrimary: React.CSSProperties = {
  padding: "6px 14px", background: "#2563eb", color: "white",
  border: "none", borderRadius: 4, fontSize: 13, cursor: "pointer",
};
const emptyStyle: React.CSSProperties = {
  padding: 40, textAlign: "center", color: "#6b7280", background: "white", borderRadius: 8,
};
const errStyle: React.CSSProperties = {
  padding: 12, background: "#fee2e2", color: "#991b1b", borderRadius: 4, marginBottom: 16,
};
