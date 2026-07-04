import { useState, useEffect } from "react";
import type { CSSProperties } from "react";
import { ConfigTemplateEditor } from "../components/ConfigTemplateEditor.js";
import { api } from "../api/client.js";
import type { MeResponse, OrgNode } from "../api/client.js";

/* -------------------------------------------------------------------------- */
/*  ConfigTemplates page                                                       */
/* -------------------------------------------------------------------------- */
/**
 * Admin page for editing global / org config templates.
 *
 * Layout: sidebar scope selector + main editor area.
 *  - super_admin: sees "全局模板" + all orgs (fetched via api.getOrgs)
 *  - org_admin: sees only "本组织模板"
 *
 * The page takes `user` as a prop (matching Skills.tsx pattern) —
 * there is no useCurrentUser hook in the Hub.
 */
interface ConfigTemplatesProps {
  user: MeResponse;
}

export function ConfigTemplates({ user }: ConfigTemplatesProps) {
  const [scope, setScope] = useState<"global" | "org">(
    user.is_super_admin ? "global" : "org",
  );
  const [selectedOrgId, setSelectedOrgId] = useState<string | undefined>(
    user.is_super_admin ? undefined : user.organization_id ?? undefined,
  );
  const [orgs, setOrgs] = useState<OrgNode[]>([]);

  useEffect(() => {
    if (user.is_super_admin) {
      api
        .getOrgs()
        .then((d) => setOrgs(d.organizations))
        .catch(() => {
          /* non-fatal — sidebar fills in async */
        });
    }
  }, [user.is_super_admin]);

  const pageStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-5)",
  };

  const layoutStyle: CSSProperties = {
    display: "flex",
    gap: "var(--space-5)",
    minHeight: 600,
  };

  const sidebarStyle: CSSProperties = {
    width: 220,
    flexShrink: 0,
    padding: "var(--space-3)",
    background: "var(--bg-card)",
    borderRadius: "var(--radius-lg)",
    border: "1px solid var(--border-primary)",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-1)",
  };

  const mainStyle: CSSProperties = {
    flex: 1,
    padding: "var(--space-5)",
    background: "var(--bg-card)",
    borderRadius: "var(--radius-lg)",
    border: "1px solid var(--border-primary)",
  };

  const tabBtnBase: CSSProperties = {
    width: "100%",
    textAlign: "left",
    padding: "var(--space-2) var(--space-3)",
    background: "transparent",
    color: "var(--text-secondary)",
    border: "none",
    borderRadius: "var(--radius-md)",
    cursor: "pointer",
    fontSize: 13,
  };

  const tabBtnActive: CSSProperties = {
    background: "var(--brand-light)",
    color: "var(--brand-primary)",
    fontWeight: 500,
  };

  const headingStyle: CSSProperties = {
    fontSize: "var(--text-xl)",
    fontWeight: 600,
    margin: 0,
  };

  const hintStyle: CSSProperties = {
    fontSize: 13,
    color: "var(--text-secondary)",
    marginTop: "var(--space-1)",
    marginBottom: "var(--space-4)",
  };

  return (
    <div style={pageStyle}>
      <h2 style={headingStyle}>配置模板</h2>

      <div style={layoutStyle}>
        <aside style={sidebarStyle}>
          {user.is_super_admin && (
            <button
              style={
                scope === "global"
                  ? { ...tabBtnBase, ...tabBtnActive }
                  : tabBtnBase
              }
              onClick={() => {
                setScope("global");
                setSelectedOrgId(undefined);
              }}
            >
              全局模板
            </button>
          )}
          {user.is_super_admin ? (
            <>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--text-tertiary)",
                  padding: "var(--space-2)",
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                }}
              >
                组织模板
              </div>
              {orgs.map((o) => (
                <button
                  key={o.id}
                  style={
                    scope === "org" && selectedOrgId === o.id
                      ? { ...tabBtnBase, ...tabBtnActive }
                      : tabBtnBase
                  }
                  onClick={() => {
                    setScope("org");
                    setSelectedOrgId(o.id);
                  }}
                >
                  {o.name}
                </button>
              ))}
            </>
          ) : (
            <button
              style={
                scope === "org" ? { ...tabBtnBase, ...tabBtnActive } : tabBtnBase
              }
              onClick={() => {
                setScope("org");
                setSelectedOrgId(user.organization_id ?? undefined);
              }}
            >
              本组织模板
            </button>
          )}
        </aside>

        <main style={mainStyle}>
          <h3 style={{ ...headingStyle, fontSize: "var(--text-lg)" }}>
            {scope === "global" ? "全局配置模板" : "组织配置模板"}
          </h3>
          <p style={hintStyle}>
            {scope === "global"
              ? "所有 DA 容器的默认配置基线。组织模板可覆盖此处的字段。null 值表示删除该字段。"
              : "本组织对全局模板的 override。仅列出的字段会覆盖；fieldLocks.lockedPaths 会与全局取并集。"}
          </p>
          {scope === "global" ? (
            <ConfigTemplateEditor scope="global" />
          ) : selectedOrgId ? (
            <ConfigTemplateEditor scope="org" orgId={selectedOrgId} />
          ) : (
            <div style={{ color: "var(--text-secondary)" }}>请选择组织</div>
          )}
        </main>
      </div>
    </div>
  );
}
