import React from 'react';
import LeftSidebar from '@/components/navigation/LeftSidebar';
import { useAppStore } from '@/stores/appStore';
import ChatView from '@/pages/ChatView';
import ToolsView from '@/pages/ToolsView';
import WorkspacesView from '@/pages/WorkspacesView';
import SettingsView from '@/pages/SettingsView';
import InsightsView from '@/pages/InsightsView';
import SettingsModal from '@/components/settings/SettingsModal';

const MainContent: React.FC = () => {
  const { activeNavTab } = useAppStore();

  switch (activeNavTab) {
    case 'tools':
      return <ToolsView />;
    case 'workspaces':
      return <WorkspacesView />;
    case 'insights':
      return <InsightsView />;
    case 'settings':
      return <SettingsView />;
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
