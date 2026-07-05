import React from 'react';
import { AlertTriangle, AlertCircle, Info } from 'lucide-react';
import { Modal } from './Modal';
import { Button } from './Button';
import { useUIStore } from '../../store/ui';
import type { ButtonVariant } from './Button';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

type ConfirmVariant = 'danger' | 'warning' | 'default';

/* -------------------------------------------------------------------------- */
/*  Variant config                                                            */
/* -------------------------------------------------------------------------- */

const variantConfig: Record<
  ConfirmVariant,
  { icon: React.ReactNode; confirmVariant: ButtonVariant }
> = {
  danger: {
    icon: <AlertCircle size={20} style={{ color: 'var(--error)' }} />,
    confirmVariant: 'danger',
  },
  warning: {
    icon: <AlertTriangle size={20} style={{ color: 'var(--warning)' }} />,
    confirmVariant: 'primary',
  },
  default: {
    icon: <Info size={20} style={{ color: 'var(--interactive)' }} />,
    confirmVariant: 'primary',
  },
};

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

export const ConfirmDialog: React.FC = () => {
  const confirmDialog = useUIStore((s) => s.confirmDialog);
  const resolveConfirm = useUIStore((s) => s.resolveConfirm);

  if (!confirmDialog) return null;

  const { title, message, confirmLabel, cancelLabel, variant = 'default' } = confirmDialog;
  const config = variantConfig[variant];

  return (
    <Modal
      open={confirmDialog.open}
      onClose={() => resolveConfirm(false)}
      title={title}
      size="sm"
    >
      {/* Message row with icon */}
      <div
        style={{
          display: 'flex',
          gap: 'var(--space-3)',
          alignItems: 'flex-start',
        }}
      >
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            width: '36px',
            height: '36px',
            borderRadius: 'var(--radius-full)',
            background:
              variant === 'danger'
                ? 'var(--error-light)'
                : variant === 'warning'
                  ? 'var(--warning-light)'
                  : 'var(--interactive-light)',
          }}
        >
          {config.icon}
        </span>

        <p
          style={{
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
            lineHeight: 'var(--leading-relaxed)' as unknown as number,
            margin: 0,
            paddingTop: 'var(--space-1)',
          }}
        >
          {message}
        </p>
      </div>

      {/* Action buttons */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 'var(--space-2)',
          marginTop: 'var(--space-5)',
        }}
      >
        <Button variant="secondary" onClick={() => resolveConfirm(false)}>
          {cancelLabel}
        </Button>
        <Button variant={config.confirmVariant} onClick={() => resolveConfirm(true)}>
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
};

export default ConfirmDialog;
