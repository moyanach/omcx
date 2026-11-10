import React from 'react';
import { MessageSquare, Wrench, FolderGit2, Settings } from 'lucide-react';
import { useAppStore, NavTab } from '@/stores/appStore';

interface NavItemProps {
  tab: NavTab;
  label: string;
  icon: React.ElementType;
}

const NavItem: React.FC<NavItemProps> = ({ tab, label, icon: Icon }) => {
  const { activeNavTab, setActiveNavTab } = useAppStore();
  const isActive = activeNavTab === tab;

  return (
    <button
      onClick={() => setActiveNavTab(tab)}
      className={`w-[52px] h-[52px] flex flex-col items-center justify-center rounded-xl transition-all duration-200 titlebar-no-drag group select-none ${
        isActive
          ? 'bg-blue-500/15 text-blue-400 border border-blue-500/30 shadow-sm'
          : 'text-neutral-400 hover:text-neutral-200 hover:bg-white/[0.04] border border-transparent'
      }`}
      title={label}
    >
      <Icon size={20} className='group-hover:scale-105 transition-transform' />
      <span className='text-[10px] mt-1 font-medium tracking-tight'>{label}</span>
    </button>
  );
};

export const Sidebar: React.FC = () => {
  return (
    <div className='w-[66px] h-full flex flex-col items-center pt-8 pb-4 flex-shrink-0 titlebar-drag sidebar-container border-r border-[color:var(--ui-divider-hairline)] bg-[var(--sidebar-bg)] z-30 select-none'>
      {/* 顶部留出 macOS 原生红绿灯安全间距 (已按用户要求移除星星图标) */}
      <div className='h-8 w-full' />

      {/* 核心三大主导航 Panel 图标 (会话 / 工具 / 工作空间) */}
      <div className='flex flex-col gap-3 mt-1'>
        {/* 1. 会话列表 */}
        <NavItem tab='sessions' label='会话' icon={MessageSquare} />

        {/* 2. 工具 (SKILLS & MCP 增删改查) */}
        <NavItem tab='tools' label='工具' icon={Wrench} />

        {/* 3. 工作空间 (多空间管理与下属会话树) */}
        <NavItem tab='workspaces' label='空间' icon={FolderGit2} />
      </div>

      <div className='flex-grow' />

      {/* 底部设置按钮 */}
      <div className='flex flex-col gap-2'>
        <NavItem tab='settings' label='设置' icon={Settings} />
      </div>
    </div>
  );
};

export default Sidebar;
