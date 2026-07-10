import { useEffect, useState, useCallback } from "react";
import { api, type OrgNode, type MeResponse } from "../api/client.js";
import { OrgTreeNode, type OrgTreeNodeData } from "../components/hub/OrgTreeNode.js";
import { Badge } from "../components/ui/Badge.js";
import { Button } from "../components/ui/Button.js";
import { Modal } from "../components/ui/Modal.js";
import { Select } from "../components/ui/Select.js";
import { Input } from "../components/ui/Input.js";

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

/** 扁平化组织树，用于 Select 选项与「排除自身及子孙」校验 */
function flattenOrgs(node: OrgNode, acc: OrgNode[] = []): OrgNode[] {
  acc.push(node);
  if (node.children) {
    for (const c of node.children) flattenOrgs(c, acc);
  }
  return acc;
}

const ICON_MAP: Record<string, string> = {
  company: "🏢",
  department: "📁",
  team: "👥",
};

const ORG_TYPES = [
  { value: "group", label: "集团" },
  { value: "company", label: "公司" },
  { value: "department", label: "部门" },
  { value: "team", label: "团队" },
];

export function OrgTree({ user }: { user: MeResponse }) {
  const [tree, setTree] = useState<OrgNode | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 添加子节点弹窗
  const [showAddChild, setShowAddChild] = useState(false);
  const [addChildForm, setAddChildForm] = useState({ name: "", code: "", type: "department" });
  const [submitting, setSubmitting] = useState(false);

  // 移动节点弹窗
  const [showMove, setShowMove] = useState(false);
  const [moveTarget, setMoveTarget] = useState<string>("");
  const [orgsFlat, setOrgsFlat] = useState<OrgNode[]>([]);
  const [moveSubmitting, setMoveSubmitting] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);

  // 编辑节点弹窗
  const [showEdit, setShowEdit] = useState(false);
  const [editForm, setEditForm] = useState({ name: "", code: "" });
  const [editSubmitting, setEditSubmitting] = useState(false);

  // 删除节点
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);

  const canCreate = user.is_super_admin || user.permissions?.includes("org:create");
  const canUpdate = user.is_super_admin || user.permissions?.includes("org:update");
  const canDelete = user.is_super_admin || user.permissions?.includes("org:delete");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getOrgTree();
      setTree(res.tree);
      setLoading(false);
    } catch (err) {
      console.error("Failed to load org tree:", err);
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

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

  // ---- 添加子节点 ----
  const openAddChild = () => {
    setAddChildForm({ name: "", code: "", type: "department" });
    setShowAddChild(true);
  };

  const handleAddChild = async () => {
    if (!selectedNode || !addChildForm.name || !addChildForm.code) return;
    setSubmitting(true);
    try {
      await api.createOrg({
        name: addChildForm.name,
        code: addChildForm.code,
        type: addChildForm.type,
        parent_id: selectedNode.id,
      });
      setShowAddChild(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  // ---- 移动节点 ----
  const openMove = async () => {
    if (!selectedNode) return;
    setMoveError(null);
    setMoveTarget("");
    // 拉取扁平组织列表用于 Select 选项
    try {
      const res = await api.getOrgs();
      setOrgsFlat(res.organizations);
    } catch {
      // 降级：用当前树扁平化
      setOrgsFlat(flattenOrgs(tree));
    }
    setShowMove(true);
  };

  const handleMove = async () => {
    if (!selectedNode || !moveTarget) return;
    setMoveSubmitting(true);
    setMoveError(null);
    try {
      await api.updateOrg(selectedNode.id, { parent_id: moveTarget });
      setShowMove(false);
      await load();
    } catch (err) {
      setMoveError(err instanceof Error ? err.message : String(err));
    } finally {
      setMoveSubmitting(false);
    }
  };

  // ---- 编辑节点（改名/改编码）----
  const openEdit = () => {
    if (!selectedNode) return;
    setEditForm({ name: selectedNode.name, code: selectedNode.code });
    setShowEdit(true);
  };

  const handleEdit = async () => {
    if (!selectedNode || !editForm.name) return;
    setEditSubmitting(true);
    try {
      await api.updateOrg(selectedNode.id, { name: editForm.name, code: editForm.code });
      setShowEdit(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setEditSubmitting(false);
    }
  };

  // ---- 删除节点 ----
  const handleDelete = async () => {
    if (!selectedNode) return;
    if (!selectedNode.parent_id) {
      window.alert("根组织不可删除");
      return;
    }
    const confirmed = window.confirm(
      `确定要删除组织「${selectedNode.name}」吗？\n\n注意：仅当该组织无子节点、无关联用户、无关联 Worker 时才能删除。`,
    );
    if (!confirmed) return;
    setDeleteSubmitting(true);
    try {
      await api.deleteOrg(selectedNode.id);
      setSelectedId(null);
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`删除失败：${msg}`);
    } finally {
      setDeleteSubmitting(false);
    }
  };

  // 移动目标选项：排除自身及其子孙（path 前缀匹配）
  const moveOptions = orgsFlat
    .filter((o) => {
      if (o.id === selectedNode.id) return false;
      // 排除子孙：path 以 selectedNode.path + "/" 开头
      if (o.path && selectedNode.path && o.path.startsWith(selectedNode.path + "/")) return false;
      return true;
    })
    .map((o) => ({
      value: o.id,
      label: `${o.name} (${o.code})`,
    }));

  return (
    <div>
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
                  flexWrap: "wrap",
                }}
              >
                <Badge>{selectedNode.type}</Badge>
                <Badge variant="info">Level {selectedNode.level}</Badge>
                {selectedNode.user_count != null && (
                  <Badge variant="success">{selectedNode.user_count} 成员</Badge>
                )}
              </div>
              <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
                {canCreate && (
                  <Button variant="secondary" size="sm" onClick={openAddChild}>
                    添加子节点
                  </Button>
                )}
                {canUpdate && (
                  <Button variant="ghost" size="sm" onClick={openEdit}>
                    编辑
                  </Button>
                )}
                {canUpdate && selectedNode.parent_id && (
                  <Button variant="ghost" size="sm" onClick={openMove}>
                    移动节点
                  </Button>
                )}
                {canDelete && selectedNode.parent_id && (
                  <Button variant="danger" size="sm" loading={deleteSubmitting} onClick={handleDelete}>
                    删除
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {error && (
        <div style={{ marginTop: "var(--space-4)", padding: "var(--space-3)", background: "var(--error-bg, #fee2e2)", color: "var(--error)", borderRadius: "var(--radius-md)" }}>
          {error}
        </div>
      )}

      {/* 添加子节点 Modal */}
      <Modal open={showAddChild} onClose={() => setShowAddChild(false)} title={`在「${selectedNode?.name}」下添加子节点`} size="sm">
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)", paddingTop: "var(--space-2)" }}>
          <Input
            label="名称"
            value={addChildForm.name}
            onChange={(e) => setAddChildForm({ ...addChildForm, name: e.target.value })}
            placeholder="如：研发一部"
          />
          <Input
            label="编码"
            value={addChildForm.code}
            onChange={(e) => setAddChildForm({ ...addChildForm, code: e.target.value })}
            placeholder="如：rd-team-1"
          />
          <div>
            <div style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", marginBottom: "var(--space-1)" }}>类型</div>
            <Select
              value={addChildForm.type}
              onChange={(v) => setAddChildForm({ ...addChildForm, type: v })}
              options={ORG_TYPES}
              aria-label="组织类型"
              style={{ width: "100%" }}
            />
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
            <Button variant="secondary" size="md" onClick={() => setShowAddChild(false)}>取消</Button>
            <Button variant="primary" size="md" loading={submitting} onClick={handleAddChild} disabled={!addChildForm.name || !addChildForm.code}>
              创建
            </Button>
          </div>
        </div>
      </Modal>

      {/* 移动节点 Modal */}
      <Modal open={showMove} onClose={() => setShowMove(false)} title={`移动「${selectedNode?.name}」到`} size="sm">
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)", paddingTop: "var(--space-2)" }}>
          <div>
            <div style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", marginBottom: "var(--space-1)" }}>目标父组织</div>
            <Select
              value={moveTarget}
              onChange={setMoveTarget}
              options={moveOptions}
              placeholder="选择目标组织..."
              searchable
              aria-label="目标父组织"
              style={{ width: "100%" }}
            />
          </div>
          {moveError && (
            <div style={{ fontSize: "var(--text-sm)", color: "var(--error)" }}>{moveError}</div>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
            <Button variant="secondary" size="md" onClick={() => setShowMove(false)}>取消</Button>
            <Button variant="primary" size="md" loading={moveSubmitting} onClick={handleMove} disabled={!moveTarget}>
              移动
            </Button>
          </div>
        </div>
      </Modal>

      {/* 编辑节点 Modal */}
      <Modal open={showEdit} onClose={() => setShowEdit(false)} title={`编辑「${selectedNode?.name}」`} size="sm">
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)", paddingTop: "var(--space-2)" }}>
          <Input
            label="名称"
            value={editForm.name}
            onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
            placeholder="组织名称"
          />
          <Input
            label="编码"
            value={editForm.code}
            onChange={(e) => setEditForm({ ...editForm, code: e.target.value })}
            placeholder="组织编码"
          />
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
            <Button variant="secondary" size="md" onClick={() => setShowEdit(false)}>取消</Button>
            <Button variant="primary" size="md" loading={editSubmitting} onClick={handleEdit} disabled={!editForm.name}>
              保存
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
