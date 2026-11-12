import React from 'react';
import WorkspaceCard from './WorkspaceCard';
import ContextCard from './ContextCard';
import ConnectorsCard from './ConnectorsCard';
import ChangesCard from './ChangesCard';
import ChecksCard from './ChecksCard';
import CheckpointsCard from './CheckpointsCard';
import RepoWikiCard from './RepoWikiCard';
import WorktreeCard from './WorktreeCard';
import SpecCard from './SpecCard';

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
    <aside className='w-[325px] h-full min-h-0 flex flex-col flex-shrink-0 bg-[var(--ui-panel-bg)] border-l border-[color:var(--ui-divider-hairline)] overflow-hidden select-none z-10 titlebar-no-drag'>
      {/* 全局平滑纵向滚动容器 (强制 titlebar-no-drag，确保鼠标滚轮顺畅) */}
      <div className='flex-1 min-h-0 overflow-y-auto overscroll-contain pt-1 pb-8 flex flex-col [&>*]:shrink-0 custom-scrollbar titlebar-no-drag'>
        {/* 1. 当前工作空间卡片 (多源文件夹展示 + 图 8 弹窗编辑) */}
        <WorkspaceCard />

        {/* 2. Context 容量卡片 (五彩分段条) */}
        <ContextCard />

        {/* 3. Connectors 连接器卡片 (MCP 服务清单) */}
        <ConnectorsCard />

        {/* 4. Changes 代码变更卡片 (实时 Git 增删行 + 文件列表) */}
        <ChangesCard />

        {/* 5. Checks 诊断与测试运行卡片 */}
        <ChecksCard />

        {/* 6. Checkpoints 文件检查点卡片 (按回合回滚 Agent 修改) */}
        <CheckpointsCard />

        {/* 7. Repo Wiki 仓库级文档 (基于符号索引生成并缓存) */}
        <RepoWikiCard />

        {/* 8. 隔离工作树 (高风险任务在独立 Git worktree 中执行) */}
        <WorktreeCard />

        {/* 9. Quest 规格文档 (需求/方案/验收/实施步骤) */}
        <SpecCard />
      </div>
    </aside>
  );
};

export default SessionInspectorColumn;
