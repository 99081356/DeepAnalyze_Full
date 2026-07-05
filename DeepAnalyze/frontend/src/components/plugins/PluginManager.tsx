// =============================================================================
// DeepAnalyze - PluginManager Component
// Plugin management panel showing installed plugins
// =============================================================================

import { useState, useEffect, useCallback } from "react";
import { api } from "../../api/client";
import { useToast } from "../../hooks/useToast";
import { useConfirm } from "../../hooks/useConfirm";
import { Spinner } from "../ui/Spinner";
import { Button } from "../ui/Button";
import { Badge } from "../ui/Badge";
import { EmptyState } from "../ui/EmptyState";
import { ToggleSwitch } from "../ui/ToggleSwitch";
import type { PluginInfo } from "../../types/index";
import {
  Puzzle,
  Trash2,
  RefreshCw,
  Package,
  AlertCircle,
  Wrench,
  Bot,
} from "lucide-react";

export function PluginManager() {
  const { success, error: toastError } = useToast();
  const confirm = useConfirm();
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadPlugins = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api.listPlugins();
      setPlugins(data);
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : "Failed to load plugins"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPlugins();
  }, [loadPlugins]);

  const handleToggle = async (plugin: PluginInfo) => {
    setTogglingId(plugin.id);
    try {
      if (plugin.enabled) {
        await api.disablePlugin(plugin.id);
        success(`${plugin.name} 已禁用`);
      } else {
        await api.enablePlugin(plugin.id);
        success(`${plugin.name} 已启用`);
      }
      await loadPlugins();
    } catch {
      toastError("操作失败");
    } finally {
      setTogglingId(null);
    }
  };

  const handleDelete = async (id: string) => {
    const ok = await confirm({
      title: "删除插件",
      message: "确定要删除此插件吗？此操作不可撤销。",
      variant: "danger",
    });
    if (!ok) return;
    setDeletingId(id);
    try {
      await api.deletePlugin(id);
      success("插件已删除");
      await loadPlugins();
    } catch {
      toastError("删除失败");
    } finally {
      setDeletingId(null);
    }
  };

  // ===========================================================================
  // Loading state
  // ===========================================================================
  if (loading) {
    return (
      <div style={styles.page}>
        <div style={styles.centerContainer}>
          <Spinner size="lg" />
        </div>
      </div>
    );
  }

  // ===========================================================================
  // Main render
  // ===========================================================================
  return (
    <div style={styles.page}>
      <div style={styles.content}>
        {/* Header */}
        <div style={styles.header}>
          <div>
            <h2 style={styles.title}>
              <Puzzle size={20} />
              {"插件管理"}
            </h2>
            <p style={styles.subtitle}>
              {"管理已安装的场景插件和工具扩展"}
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            icon={<RefreshCw size={14} />}
            onClick={loadPlugins}
          >
            {"刷新"}
          </Button>
        </div>

        {/* Error display */}
        {loadError && (
          <div style={styles.errorBanner}>
            <AlertCircle size={18} style={{ flexShrink: 0 }} />
            <div style={styles.errorText}>
              <strong>{"加载失败"}</strong>
              <p style={styles.errorMessage}>{loadError}</p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={loadPlugins}
              style={{ marginLeft: "auto", flexShrink: 0 }}
            >
              {"重试"}
            </Button>
          </div>
        )}

        {/* Empty state */}
        {!loadError && plugins.length === 0 ? (
          <EmptyState
            icon={<Package size={24} />}
            title={"暂无已安装的插件"}
            description={
              "将插件放入 plugins/ 目录后重启系统即可使用"
            }
            actionLabel={"刷新"}
            onAction={loadPlugins}
          />
        ) : (
          <div style={styles.pluginList}>
            {plugins.map((plugin) => (
              <PluginCard
                key={plugin.id}
                plugin={plugin}
                toggling={togglingId === plugin.id}
                deleting={deletingId === plugin.id}
                onToggle={() => handleToggle(plugin)}
                onDelete={() => handleDelete(plugin.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// PluginCard - individual plugin row
// =============================================================================

function PluginCard({
  plugin,
  toggling,
  deleting,
  onToggle,
  onDelete,
}: {
  plugin: PluginInfo;
  toggling: boolean;
  deleting: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  return (
    <div style={styles.card}>
      <div style={styles.cardBody}>
        {/* Left side: plugin info */}
        <div style={styles.cardInfo}>
          {/* Name + badges row */}
          <div style={styles.cardTitleRow}>
            <span style={styles.cardName}>{plugin.name}</span>
            <Badge variant="default" size="sm">
              {"v" + plugin.version}
            </Badge>
            {plugin.enabled ? (
              <Badge variant="success" size="sm">
                {"已启用"}
              </Badge>
            ) : (
              <Badge variant="default" size="sm">
                {"已禁用"}
              </Badge>
            )}
            {plugin.error && (
              <Badge variant="error" size="sm">
                {"加载错误"}
              </Badge>
            )}
          </div>

          {/* Description */}
          <p style={styles.cardDescription}>{plugin.description}</p>

          {/* Meta row */}
          <div style={styles.cardMeta}>
            {plugin.author && (
              <span style={styles.metaItem}>
                {"作者: " + plugin.author}
              </span>
            )}
            {(plugin.toolNames?.length ?? 0) > 0 && (
              <span style={styles.metaItem}>
                <Wrench size={10} style={{ marginRight: 4 }} />
                {plugin.toolNames.length + " 工具"}
              </span>
            )}
            {(plugin.agentTypes?.length ?? 0) > 0 && (
              <span style={styles.metaItem}>
                <Bot size={10} style={{ marginRight: 4 }} />
                {plugin.agentTypes.length + " Agent"}
              </span>
            )}
          </div>
        </div>

        {/* Right side: actions */}
        <div style={styles.cardActions}>
          {toggling ? (
            <Spinner size="sm" />
          ) : (
            <ToggleSwitch
              checked={plugin.enabled}
              onChange={onToggle}
              size="sm"
              aria-label={
                plugin.enabled
                  ? "禁用 " + plugin.name
                  : "启用 " + plugin.name
              }
            />
          )}
          <Button
            variant="ghost"
            size="sm"
            icon={
              deleting ? <Spinner size="sm" color="currentColor" /> : <Trash2 size={14} />
            }
            onClick={onDelete}
            disabled={deleting}
            style={
              deleting
                ? undefined
                : {
                    color: "var(--text-tertiary)",
                  }
            }
          >
            {"删除"}
          </Button>
        </div>
      </div>

      {/* Error detail */}
      {plugin.error && (
        <div style={styles.cardError}>
          <AlertCircle size={12} />
          <span>{plugin.error}</span>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Styles
// =============================================================================

const styles: Record<string, React.CSSProperties> = {
  page: {
    height: "100%",
    overflowY: "auto",
    padding: "var(--space-6)",
  },
  content: {
    maxWidth: "48rem",
    margin: "0 auto",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-6)",
  },
  centerContainer: {
    height: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  header: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
  },
  title: {
    fontSize: "var(--text-base)",
    fontWeight: "var(--font-semibold)" as unknown as number,
    color: "var(--text-primary)",
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
    margin: 0,
  },
  subtitle: {
    fontSize: "var(--text-sm)",
    color: "var(--text-secondary)",
    marginTop: "var(--space-1)",
    margin: 0,
    paddingTop: "var(--space-1)",
  },
  errorBanner: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-3)",
    padding: "var(--space-3) var(--space-4)",
    background: "var(--error-light)",
    border: "1px solid var(--error)",
    borderRadius: "var(--radius-lg)",
    color: "var(--error-dark)",
    marginBottom: "var(--space-4)",
  },
  errorText: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    minWidth: 0,
  },
  errorMessage: {
    fontSize: "var(--text-xs)",
    margin: 0,
    opacity: 0.85,
    wordBreak: "break-word" as const,
  },
  pluginList: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-3)",
  },
  card: {
    padding: "var(--space-4) var(--space-5)",
    background: "var(--bg-secondary)",
    border: "1px solid var(--border-primary)",
    borderRadius: "var(--radius-lg)",
    boxShadow: "var(--shadow-sm)",
  },
  cardBody: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
  },
  cardInfo: {
    flex: 1,
    minWidth: 0,
  },
  cardTitleRow: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
    flexWrap: "wrap" as const,
  },
  cardName: {
    fontSize: "var(--text-sm)",
    fontWeight: "var(--font-medium)" as unknown as number,
    color: "var(--text-primary)",
  },
  cardDescription: {
    fontSize: "var(--text-xs)",
    color: "var(--text-secondary)",
    marginTop: "var(--space-1)",
    marginBottom: 0,
    lineHeight: "var(--leading-relaxed)" as unknown as number,
  },
  cardMeta: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-3)",
    marginTop: "var(--space-2)",
    fontSize: "var(--text-xs)",
    color: "var(--text-tertiary)",
  },
  metaItem: {
    display: "inline-flex",
    alignItems: "center",
  },
  cardActions: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-3)",
    flexShrink: 0,
    marginLeft: "var(--space-4)",
  },
  cardError: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-1)",
    marginTop: "var(--space-2)",
    padding: "var(--space-2) var(--space-3)",
    fontSize: "var(--text-xs)",
    color: "var(--error)",
    background: "var(--error-light)",
    borderRadius: "var(--radius-sm)",
  },
};
