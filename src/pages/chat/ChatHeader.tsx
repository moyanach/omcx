import React from "react";
import { Session } from "../../stores/chatStore";
import { PanelLeft, PanelRight, Compass } from "lucide-react";

interface Props {
  session: Session | undefined;
  leftPanelOpen: boolean;
  onToggleLeftPanel: () => void;
  rightDrawerOpen: boolean;
  onToggleRightDrawer: () => void;
}

const ChatHeader: React.FC<Props> = ({
  session,
  leftPanelOpen,
  onToggleLeftPanel,
  rightDrawerOpen,
  onToggleRightDrawer,
}) => {
  if (!session) return null;

  return (
    <div className="h-[48px] border-b border-[#242424] bg-[#141414] flex-shrink-0 flex items-center justify-between px-5 titlebar-drag select-none z-30">
      {/* 会话标题与当前工作区路径简略提示 */}
      <div className="flex items-center gap-2.5 min-w-0">
        <h1 className="font-semibold text-neutral-200 text-xs truncate max-w-[280px]">
          {session.title}
        </h1>
        {session.workDir && (
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#202020] text-neutral-400 font-mono border border-[#2e2e2e] truncate max-w-[240px]">
            {session.workDir.split('/').pop()}
          </span>
        )}
      </div>

      {/* 顶部右上角：两个控制图标 (精准符合用户要求) */}
      <div className="flex items-center gap-2 titlebar-no-drag">
        {/* 开关 1: 控制左侧内容（工作空间 + Inspector 两大块） */}
        <button
          onClick={onToggleLeftPanel}
          className={`h-7 px-2 flex items-center gap-1.5 rounded-lg border text-xs font-medium transition-all ${
            leftPanelOpen
              ? "bg-blue-500/15 text-blue-400 border-blue-500/30"
              : "bg-[#202020] text-neutral-400 border-[#2d2d2d] hover:text-white hover:bg-[#282828]"
          }`}
          title={leftPanelOpen ? "收起左侧监控与工作空间" : "展开左侧监控与工作空间"}
        >
          <PanelLeft size={14} />
          <span className="text-[11px]">监控</span>
        </button>

        {/* 开关 2: 控制最右侧额外功能（集成浏览器、测试场景、终端与文件目录） */}
        <button
          onClick={onToggleRightDrawer}
          className={`h-7 px-2 flex items-center gap-1.5 rounded-lg border text-xs font-medium transition-all ${
            rightDrawerOpen
              ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
              : "bg-[#202020] text-neutral-400 border-[#2d2d2d] hover:text-white hover:bg-[#282828]"
          }`}
          title={rightDrawerOpen ? "收起右侧浏览器与工具" : "展开右侧浏览器与工具"}
        >
          <Compass size={14} />
          <span className="text-[11px]">浏览器/工具</span>
        </button>
      </div>
    </div>
  );
};

export default ChatHeader;
