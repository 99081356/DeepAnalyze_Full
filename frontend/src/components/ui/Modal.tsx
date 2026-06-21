import React, { useEffect, useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '../../utils/cn';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export type ModalSize = 'sm' | 'md' | 'lg';

export interface ModalProps {
  /** Whether the modal is visible */
  open: boolean;
  /** Callback fired when the modal should close */
  onClose: () => void;
  /** Title displayed in the header */
  title?: string;
  /** Width preset */
  size?: ModalSize;
  /** Modal body content */
  children: React.ReactNode;
  /** Additional class for the panel */
  className?: string;
  /** Hide the close button in the header */
  hideClose?: boolean;
  /** Click overlay to close (default: true) */
  closeOnOverlay?: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Size map                                                                  */
/* -------------------------------------------------------------------------- */

const sizeMap: Record<ModalSize, string> = {
  sm: '400px',
  md: '520px',
  lg: '680px',
};

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

export const Modal: React.FC<ModalProps> = ({
  open,
  onClose,
  title,
  size = 'md',
  children,
  className,
  hideClose = false,
  closeOnOverlay = true,
}) => {
  const [visible, setVisible] = useState(false);
  const [animating, setAnimating] = useState<'in' | 'out' | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Sync open prop with local visibility state
  useEffect(() => {
    if (open) {
      setVisible(true);
      setAnimating('in');
    } else if (visible) {
      setAnimating('out');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Lock body scroll when open
  useEffect(() => {
    if (visible) {
      document.body.style.overflow = 'hidden';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [visible]);

  const handleAnimationEnd = useCallback(() => {
    if (animating === 'out') {
      setVisible(false);
      setAnimating(null);
    } else {
      setAnimating(null);
    }
  }, [animating]);

  // Escape key
  useEffect(() => {
    if (!visible) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [visible, onClose]);

  if (!visible) return null;

  /* ---- Styles ---- */

  const overlayStyle: React.CSSProperties = {
    position: 'fixed',
    inset: 0,
    zIndex: 'var(--z-overlay)' as unknown as number,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--overlay-bg)',
    backdropFilter: 'blur(4px)',
    WebkitBackdropFilter: 'blur(4px)',
    animation:
      animating === 'out'
        ? `modalFadeOut var(--transition-base) ease-out forwards`
        : `modalFadeIn var(--transition-base) ease-out`,
  };

  const panelStyle: React.CSSProperties = {
    position: 'relative',
    background: 'var(--bg-primary)',
    borderRadius: 'var(--radius-xl)',
    boxShadow: 'var(--shadow-xl)',
    width: `min(${sizeMap[size]}, calc(100vw - var(--space-8)))`,
    maxHeight: `calc(100vh - var(--space-16))`,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    animation:
      animating === 'out'
        ? `modalScaleOut var(--transition-base) ease-out forwards`
        : `modalScaleIn var(--transition-base) ease-out`,
  };

  const headerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: `var(--space-4) var(--space-5)`,
    borderBottom: '1px solid var(--border-primary)',
    flexShrink: 0,
  };

  const titleStyle: React.CSSProperties = {
    fontSize: 'var(--text-lg)',
    fontWeight: 'var(--font-semibold)' as unknown as number,
    color: 'var(--text-primary)',
    lineHeight: 'var(--leading-tight)' as unknown as number,
  };

  const bodyStyle: React.CSSProperties = {
    padding: 'var(--space-5)',
    overflowY: 'auto',
    flex: 1,
  };

  const closeBtnStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '28px',
    height: '28px',
    borderRadius: 'var(--radius-md)',
    border: 'none',
    background: 'transparent',
    color: 'var(--text-tertiary)',
    cursor: 'pointer',
    transition: `all var(--transition-fast)`,
    padding: 0,
  };

  const content = (
    <div
      style={overlayStyle}
      onClick={closeOnOverlay ? onClose : undefined}
      onAnimationEnd={handleAnimationEnd}
    >
      {/* Embedded keyframes – injected once per modal instance */}
      <style>{`
        @keyframes modalFadeIn {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        @keyframes modalFadeOut {
          from { opacity: 1; }
          to   { opacity: 0; }
        }
        @keyframes modalScaleIn {
          from { opacity: 0; transform: scale(0.95); }
          to   { opacity: 1; transform: scale(1); }
        }
        @keyframes modalScaleOut {
          from { opacity: 1; transform: scale(1); }
          to   { opacity: 0; transform: scale(0.95); }
        }
      `}</style>

      <div
        ref={panelRef}
        className={cn('da-modal-panel', className)}
        style={panelStyle}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? 'da-modal-title' : undefined}
      >
        {title && (
          <div style={headerStyle}>
            <h2 id="da-modal-title" style={titleStyle}>
              {title}
            </h2>
            {!hideClose && (
              <button
                type="button"
                style={closeBtnStyle}
                onClick={onClose}
                aria-label="Close"
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.background =
                    'var(--bg-hover)';
                  (e.currentTarget as HTMLElement).style.color =
                    'var(--text-primary)';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.background =
                    'transparent';
                  (e.currentTarget as HTMLElement).style.color =
                    'var(--text-tertiary)';
                }}
              >
                <X size={16} />
              </button>
            )}
          </div>
        )}

        {/* If no title but close is still visible, show a floating close button */}
        {!title && !hideClose && (
          <button
            type="button"
            style={{
              ...closeBtnStyle,
              position: 'absolute',
              top: 'var(--space-3)',
              right: 'var(--space-3)',
              zIndex: 1,
            }}
            onClick={onClose}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        )}

        <div style={bodyStyle}>{children}</div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
};

export default Modal;
