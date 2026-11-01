import React from 'react';
import WorkspaceCard from './WorkspaceCard';
import ContextCard from './ContextCard';
import ConnectorsCard from './ConnectorsCard';
import ChangesCard from './ChangesCard';

interface SessionInspectorColumnProps {
  isOpen: boolean;
}

/**
 * SessionInspectorColumn — 专属于当前会话的右侧精简监控面板 (对应参考图 4 绿色框区域)
 * 纯粹聚焦核心指标：当前工作空间多目录状态、Context 预算容量条、Connectors (MCP)、Changes 代码变更
 */
export const SessionInspectorColumn: React.FC<SessionInspectorColumnProps> = ({ isOpen }) => {
  if (!isOpen) return null;

  return (
    <aside className='w-[325px] h-full min-h-0 flex flex-col flex-shrink-0 bg-[#141414] border-l border-[#242424] overflow-hidden select-none z-10 titlebar-no-drag'>
      {/* 全局平滑纵向滚动容器 (强制 titlebar-no-drag，确保鼠标滚轮顺畅) */}
      <div className='flex-1 min-h-0 overflow-y-auto overscroll-contain p-3 pb-8 flex flex-col gap-3 [&>*]:shrink-0 custom-scrollbar titlebar-no-drag'>
        {/* 1. 当前工作空间卡片 (多源文件夹展示 + 图 8 弹窗编辑) */}
        <WorkspaceCard />

        {/* 2. Context 容量卡片 (五彩分段条) */}
        <ContextCard />

        {/* 3. Connectors 连接器卡片 (MCP 服务清单) */}
        <ConnectorsCard />

        {/* 4. Changes 代码变更卡片 (实时 Git 增删行 + 文件列表) */}
        <ChangesCard />
      </div>
    </aside>
  );
};

export default SessionInspectorColumn;
