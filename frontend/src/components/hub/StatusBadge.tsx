import { Badge } from '../ui/Badge.js';

/* -------------------------------------------------------------------------- */
/*  Status → Badge variant mapping                                            */
/*  Badge variants: 'default' | 'success' | 'warning' | 'error' | 'info'     */
/* -------------------------------------------------------------------------- */

type BadgeVariant = 'default' | 'success' | 'warning' | 'error' | 'info';

interface StatusConfig {
  variant: BadgeVariant;
  label: string;
}

const STATUS_CONFIG: Record<string, StatusConfig> = {
  online: { variant: 'success', label: '在线' },
  offline: { variant: 'default', label: '离线' },
  pending: { variant: 'warning', label: '待审批' },
  approved: { variant: 'success', label: '已批准' },
  rejected: { variant: 'error', label: '已拒绝' },
  draining: { variant: 'warning', label: '排水中' },
};

export function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status] ?? {
    variant: 'default' as BadgeVariant,
    label: status,
  };
  return <Badge variant={cfg.variant}>{cfg.label}</Badge>;
}

export default StatusBadge;
