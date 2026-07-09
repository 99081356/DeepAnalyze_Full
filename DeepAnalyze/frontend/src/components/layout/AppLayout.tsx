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
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0 }}>
        <Sidebar />
        <main
          style={{
            flex: 1,
            // 让 main 成为 flex 列容器，并把滚动控制权交给各页面自身
            // （例如 ChatWindow 内部的消息列表）。这样页面根节点才能用
            // height:100% 正确占满视口，输入框不会被推出可视区。
            display: 'flex',
            flexDirection: 'column',
            minWidth: 0,
            minHeight: 0,
            overflow: 'hidden',
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
