import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { RightPanel } from './RightPanel';
import { EvidencePreviewPanel } from '../preview/EvidencePreviewPanel';
import { Toast } from '../ui/Toast';
import { ConfirmDialog } from '../ui/ConfirmDialog';

export function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        overflow: 'hidden',
        background: 'var(--bg-primary)',
        color: 'var(--text-primary)',
      }}
    >
      <Header />
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <Sidebar />
        <main
          style={{
            flex: 1,
            overflow: 'auto',
            background: 'var(--bg-primary)',
            position: 'relative',
          }}
        >
          {children}
        </main>
      </div>
      {/* Global overlays */}
      <Toast />
      <ConfirmDialog />
      <RightPanel />
      <EvidencePreviewPanel />
    </div>
  );
}
