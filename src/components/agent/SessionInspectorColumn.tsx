import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '@/stores/appStore';
import { usePanelResize } from '@/hooks/usePanelResize';
import WorkspaceCard from './WorkspaceCard';
import ContextCard from './ContextCard';
import ConnectorsCard from './ConnectorsCard';
import ChangesCard from './ChangesCard';
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
  const { inspectorWidth, setInspectorWidth } = useAppStore(
    useShallow((s) => ({ inspectorWidth: s.inspectorWidth, setInspectorWidth: s.setInspectorWidth }))
  );

  const {
    targetRef: inspectorRef,
    onPointerDown: startInspectorResize,
    widthRef: inspectorWidthRef,
    isResizingRef,
    isDragging: isResizing,
  } = usePanelResize({
    edge: 'left',
    min: 260,
    max:
      typeof window !== 'undefined'
        ? Math.min(560, Math.floor(window.innerWidth * 0.45))
        : 560,
    getWidth: () => inspectorWidth,
    onCommit: (width) => setInspectorWidth(width),
  });

  const liveWidth =
    isResizingRef.current && inspectorWidthRef.current != null
      ? inspectorWidthRef.current
      : null;

  if (!isOpen) return null;

  return (
    <aside
      ref={inspectorRef as React.RefObject<HTMLElement>}
      style={{
        width: liveWidth != null ? `${liveWidth}px` : inspectorWidth,
        maxWidth: '45vw',
      }}
      className='relative h-full min-h-0 flex flex-col flex-shrink-0 bg-[var(--ui-panel-bg)] backdrop-blur-xl backdrop-saturate-150 border-l border-[color:var(--ui-divider-hairline)] select-none z-10 titlebar-no-drag'
    >
      {/* 左侧拖拽调宽手柄（双击恢复默认 325px） */}
      <div
        onPointerDown={startInspectorResize}
        onDoubleClick={() => setInspectorWidth(325)}
        className={`absolute left-0 top-0 bottom-0 w-2.5 -translate-x-1/2 cursor-col-resize z-40 titlebar-no-drag transition-colors ${
          isResizing
            ? 'bg-[var(--ui-accent-blue)]/60'
            : 'hover:bg-[var(--ui-accent-blue-soft)]'
        }`}
        title='拖拽调整监控面板宽度（双击恢复默认）'
      />
      {/* 全局平滑纵向滚动容器 (强制 titlebar-no-drag，确保鼠标滚轮顺畅) */}
      <div className='flex-1 min-h-0 overflow-y-auto overscroll-contain pt-1 pb-8 flex flex-col [&>*]:shrink-0 custom-scrollbar titlebar-no-drag'>
        {/* 1. 当前工作空间卡片 (多源文件夹展示 + 图 8 弹窗编辑) */}
        <WorkspaceCard />

        {/* 2. Context 容量卡片 (五彩分段条) */}
        <ContextCard />

        {/* 3. Connectors 连接器卡片 (MCP 服务清单) */}
        <ConnectorsCard />

        {/* 4. Repo Wiki 仓库级文档 (基于符号索引生成并缓存) */}
        <RepoWikiCard />

        {/* 5. 隔离工作树 (高风险任务在独立 Git worktree 中执行) */}
        <WorktreeCard />

        {/* 6. Quest 规格文档 (需求/方案/验收/实施步骤) */}
        <SpecCard />

        {/* 7. Changes 代码变更卡片 (实时 Git 增删行 + 文件列表) */}
        <ChangesCard />
      </div>
    </aside>
  );
};

export default SessionInspectorColumn;
