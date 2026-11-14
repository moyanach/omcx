import React, { Suspense, lazy } from 'react';
import { Loader2 } from 'lucide-react';
import LeftSidebar from '@/components/navigation/LeftSidebar';
import { useAppStore } from '@/stores/appStore';
import ChatView from '@/pages/ChatView';
import SettingsModal from '@/components/settings/SettingsModal';

const ToolsView = lazy(() => import('@/pages/ToolsView'));
const WorkspacesView = lazy(() => import('@/pages/WorkspacesView'));
const SettingsView = lazy(() => import('@/pages/SettingsView'));

const ViewFallback: React.FC = () => (
  <div className='flex-1 h-full flex items-center justify-center text-xs text-[var(--ui-text-muted)] gap-2'>
    <Loader2 size={15} className='animate-spin text-[var(--ui-accent-blue)]' />
    <span>加载视图中...</span>
  </div>
);

const MainContent: React.FC = () => {
  const activeNavTab = useAppStore((s) => s.activeNavTab);

  switch (activeNavTab) {
    case 'tools':
      return (
        <Suspense fallback={<ViewFallback />}>
          <ToolsView />
        </Suspense>
      );
    case 'workspaces':
      return (
        <Suspense fallback={<ViewFallback />}>
          <WorkspacesView />
        </Suspense>
      );
    case 'settings':
      return (
        <Suspense fallback={<ViewFallback />}>
          <SettingsView />
        </Suspense>
      );
    case 'sessions':
    default:
      return <ChatView />;
  }
};

const Layout: React.FC = () => {
  return (
    <div className='flex h-full w-full overflow-hidden bg-[var(--ui-app-bg)]'>
      {/* 单栏任务中心 (对标主流 Agent 桌面端: 新建任务 + 自动化/工具 + 空间树 + 用户) */}
      <LeftSidebar />

      {/* 主展示区域 (会话主窗口 / 工具 Studio / 空间 Hub / 设置) */}
      <main className='flex h-full flex-1 min-w-0 overflow-hidden'>
        <MainContent />
      </main>

      {/* 设置弹出层：覆盖在当前视图之上，Esc / 点击遮罩 / 右上角关闭 */}
      <SettingsModal />
    </div>
  );
};

export default Layout;
