import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, CheckCircle2, AlertCircle, AlertTriangle, Info } from 'lucide-react';
import { useUIStore } from '../../store/ui';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

type ToastType = 'success' | 'error' | 'warning' | 'info';

interface ToastCardProps {
  id: string;
  type: ToastType;
  message: string;
  onDismiss: (id: string) => void;
}

/* -------------------------------------------------------------------------- */
/*  Config per toast type                                                     */
/* -------------------------------------------------------------------------- */

const TOAST_DURATION = 4000;

const typeConfig: Record<
  ToastType,
  { icon: React.ReactNode; color: string; bg: string }
> = {
  success: {
    icon: <CheckCircle2 size={18} />,
    color: 'var(--success)',
    bg: 'var(--success-light)',
  },
  error: {
    icon: <AlertCircle size={18} />,
    color: 'var(--error)',
    bg: 'var(--error-light)',
  },
  warning: {
    icon: <AlertTriangle size={18} />,
    color: 'var(--warning)',
    bg: 'var(--warning-light)',
  },
  info: {
    icon: <Info size={18} />,
    color: 'var(--info)',
    bg: 'var(--info-light)',
  },
};

/* -------------------------------------------------------------------------- */
/*  ToastCard – individual toast                                              */
/* -------------------------------------------------------------------------- */

const ToastCard: React.FC<ToastCardProps> = ({ id, type, message, onDismiss }) => {
  const [progress, setProgress] = useState(100);
  const config = typeConfig[type];
  const startTimeRef = useRef(Date.now());
  const rafRef = useRef<number>(0);

  // Animate progress bar
  useEffect(() => {
    startTimeRef.current = Date.now();

    const tick = () => {
      const elapsed = Date.now() - startTimeRef.current;
      const remaining = Math.max(0, 100 - (elapsed / TOAST_DURATION) * 100);
      setProgress(remaining);
      if (remaining > 0) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  const handleClose = () => {
    cancelAnimationFrame(rafRef.current);
    onDismiss(id);
  };

  const cardStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 'var(--space-3)',
    padding: 'var(--space-3) var(--space-4)',
    paddingRight: 'var(--space-3)',
    background: 'var(--bg-primary)',
    border: '1px solid var(--border-primary)',
    borderRadius: 'var(--radius-lg)',
    boxShadow: 'var(--shadow-lg)',
    minWidth: '300px',
    maxWidth: '420px',
    position: 'relative',
    overflow: 'hidden',
    animation: 'toastSlideIn var(--transition-slow) ease-out',
  };

  const iconWrapStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: '28px',
    height: '28px',
    borderRadius: 'var(--radius-full)',
    background: config.bg,
    color: config.color,
  };

  const msgStyle: React.CSSProperties = {
    flex: 1,
    fontSize: 'var(--text-sm)',
    color: 'var(--text-primary)',
    lineHeight: 'var(--leading-normal)' as unknown as number,
    paddingTop: 'var(--space-0)',
  };

  const closeBtnStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '24px',
    height: '24px',
    borderRadius: 'var(--radius-sm)',
    border: 'none',
    background: 'transparent',
    color: 'var(--text-tertiary)',
    cursor: 'pointer',
    flexShrink: 0,
    padding: 0,
    transition: `all var(--transition-fast)`,
  };

  const progressBarStyle: React.CSSProperties = {
    position: 'absolute',
    bottom: 0,
    left: 0,
    height: '2px',
    background: config.color,
    width: `${progress}%`,
    transition: 'width 60ms linear',
    borderRadius: '0 0 var(--radius-lg) var(--radius-lg)',
  };

  return (
    <div style={cardStyle}>
      <span style={iconWrapStyle}>{config.icon}</span>
      <span style={msgStyle}>{message}</span>
      <button
        type="button"
        style={closeBtnStyle}
        onClick={handleClose}
        aria-label="Dismiss"
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)';
          (e.currentTarget as HTMLElement).style.color = 'var(--text-primary)';
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLElement).style.background = 'transparent';
          (e.currentTarget as HTMLElement).style.color = 'var(--text-tertiary)';
        }}
      >
        <X size={14} />
      </button>
      <span style={progressBarStyle} />
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/*  Toast container – renders the stack                                       */
/* -------------------------------------------------------------------------- */

export const ToastContainer: React.FC = () => {
  const toasts = useUIStore((s) => s.toasts);
  const removeToast = useUIStore((s) => s.removeToast);

  const containerStyle: React.CSSProperties = {
    position: 'fixed',
    top: 'var(--space-4)',
    right: 'var(--space-4)',
    zIndex: 'var(--z-toast)' as unknown as number,
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-2)',
    pointerEvents: 'none',
  };

  if (toasts.length === 0) return null;

  const content = (
    <>
      <style>{`
        @keyframes toastSlideIn {
          from {
            opacity: 0;
            transform: translateX(20px) scale(0.95);
          }
          to {
            opacity: 1;
            transform: translateX(0) scale(1);
          }
        }
      `}</style>
      <div style={containerStyle}>
        {toasts.map((toast) => (
          <div key={toast.id} style={{ pointerEvents: 'auto' }}>
            <ToastCard
              id={toast.id}
              type={toast.type}
              message={toast.message}
              onDismiss={removeToast}
            />
          </div>
        ))}
      </div>
    </>
  );

  return createPortal(content, document.body);
};

/** Alias for convenient import */
export const Toast = ToastContainer;

export default ToastContainer;
