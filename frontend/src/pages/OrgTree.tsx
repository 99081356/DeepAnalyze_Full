import { useEffect, useState } from "react";
import { api, type OrgNode } from "../api/client.js";
import { OrgTreeNode, type OrgTreeNodeData } from "../components/hub/OrgTreeNode.js";
import { Badge } from "../components/ui/Badge.js";
import { Button } from "../components/ui/Button.js";

function toTreeNode(node: OrgNode): OrgTreeNodeData {
  return {
    id: node.id,
    name: node.name,
    code: node.code,
    type: node.type,
    level: node.level,
    user_count: node.user_count,
    children: node.children?.map(toTreeNode),
  };
}

const ICON_MAP: Record<string, string> = {
  company: "🏢",
  department: "📁",
  team: "👥",
};

export function OrgTree() {
  const [tree, setTree] = useState<OrgNode | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getOrgTree()
      .then((res) => {
        setTree(res.tree);
        setLoading(false);
      })
      .catch((err) => {
        console.error("Failed to load org tree:", err);
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }, []);

  if (loading) {
    return (
      <div style={{ padding: 40, textAlign: "center", color: "var(--text-tertiary)" }}>
        加载中...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 40, textAlign: "center", color: "var(--error)" }}>
        加载失败：{error}
      </div>
    );
  }

  if (!tree) {
    return (
      <div style={{ padding: 40, textAlign: "center", color: "var(--text-tertiary)" }}>
        无数据
      </div>
    );
  }

  const findNode = (node: OrgNode, id: string): OrgNode | undefined => {
    if (node.id === id) return node;
    return (node.children ?? [])
      .map((c) => findNode(c, id))
      .find((r): r is OrgNode => r !== undefined);
  };

  const selectedNode = (tree && selectedId ? findNode(tree, selectedId) : null) ?? tree;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: "var(--space-4)" }}>
      {/* 左侧：树 */}
      <div
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border-primary)",
          borderRadius: "var(--radius-xl)",
          padding: "var(--space-4)",
        }}
      >
        <OrgTreeNode
          node={toTreeNode(tree)}
          selectedId={selectedNode?.id}
          onSelect={(n) => setSelectedId(n.id)}
        />
      </div>

      {/* 右侧：详情侧栏 */}
      <div
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border-primary)",
          borderRadius: "var(--radius-xl)",
          padding: "var(--space-5)",
          height: "fit-content",
          position: "sticky",
          top: "var(--space-6)",
        }}
      >
        {selectedNode && (
          <>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-2)",
                marginBottom: "var(--space-3)",
              }}
            >
              <span style={{ fontSize: 24 }}>
                {ICON_MAP[selectedNode.type] ?? "🏢"}
              </span>
              <div>
                <div style={{ fontSize: "var(--text-lg)", fontWeight: 600 }}>
                  {selectedNode.name}
                </div>
                <div
                  style={{
                    fontSize: "var(--text-xs)",
                    color: "var(--text-tertiary)",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {selectedNode.code}
                </div>
              </div>
            </div>
            <div
              style={{
                display: "flex",
                gap: "var(--space-2)",
                marginBottom: "var(--space-4)",
              }}
            >
              <Badge>{selectedNode.type}</Badge>
              <Badge variant="info">Level {selectedNode.level}</Badge>
              {selectedNode.user_count != null && (
                <Badge variant="success">{selectedNode.user_count} 成员</Badge>
              )}
            </div>
            <Button variant="secondary" size="sm" disabled title="暂未实现">
              添加子节点
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
