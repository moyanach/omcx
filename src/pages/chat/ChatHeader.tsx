import React from "react";
import { Session } from "../../stores/chatStore";
import { PanelLeft, Compass } from "lucide-react";

interface Props {
  session: Session | undefined;
  leftPanelOpen: boolean;
  onToggleLeftPanel: () => void;
  rightDrawerOpen: boolean;
  onToggleRightDrawer: () => void;
  compact?: boolean;
}

const ChatHeader: React.FC<Props> = ({
  session,
  leftPanelOpen,
  onToggleLeftPanel,
  rightDrawerOpen,
  onToggleRightDrawer,
  compact = false,
}) => {
  if (!session) return null;

  return (
    <div className="h-[48px] border-b border-[color:var(--ui-divider-hairline)] bg-[var(--ui-panel-bg)] flex-shrink-0 flex items-center justify-between gap-2 px-3.5 overflow-hidden titlebar-drag select-none z-30">
      {/* 会话标题与当前工作区路径简略提示（弹性自适应截断，绝不挤压右侧按钮） */}
      <div className="flex items-center gap-2 min-w-0 flex-1 overflow-hidden">
        <h1
          className="font-semibold text-[var(--ui-text-primary)] text-xs truncate min-w-0"
          title={session.title}
        >
          {session.title}
        </h1>
        {session.workDir && !compact && (
          <span
            className="hidden sm:inline-block text-[10px] px-2 py-0.5 rounded-full bg-[var(--ui-chip-bg)] text-[var(--ui-text-muted)] font-mono border border-[color:var(--ui-border-hairline)] truncate max-w-[160px] flex-shrink-0"
            title={session.workDir}
          >
            {session.workDir.split("/").pop()}
          </span>
        )}
      </div>

      {/* 顶部右上角：两个控制图标（固定不换行、不收缩） */}
      <div className="flex items-center gap-1.5 titlebar-no-drag flex-shrink-0">
        <button
          onClick={onToggleLeftPanel}
          className={`h-7 px-2 flex items-center gap-1.5 rounded-lg border text-xs font-medium transition-all flex-shrink-0 whitespace-nowrap ${
            leftPanelOpen
              ? "bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)] border-[color:var(--ui-accent-blue-border)]"
              : "bg-[var(--ui-chip-bg)] text-[var(--ui-text-muted)] border-[color:var(--ui-border-hairline)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-chip-hover-bg)]"
          }`}
          title={leftPanelOpen ? "收起监控与工作空间" : "展开监控与工作空间"}
        >
          <PanelLeft size={13.5} className="flex-shrink-0" />
          <span className="text-[11px] whitespace-nowrap">监控</span>
        </button>

        <button
          onClick={onToggleRightDrawer}
          className={`h-7 px-2 flex items-center gap-1.5 rounded-lg border text-xs font-medium transition-all flex-shrink-0 whitespace-nowrap ${
            rightDrawerOpen
              ? "bg-[var(--ui-accent-emerald-soft)] text-[var(--ui-accent-emerald)] border-[color:var(--ui-accent-emerald-border)]"
              : "bg-[var(--ui-chip-bg)] text-[var(--ui-text-muted)] border-[color:var(--ui-border-hairline)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-chip-hover-bg)]"
          }`}
          title={rightDrawerOpen ? "收起右侧浏览器与工具" : "展开右侧浏览器与工具"}
        >
          <Compass size={13.5} className="flex-shrink-0" />
          <span className="text-[11px] whitespace-nowrap">
            {compact ? "工具台" : "浏览器/工具"}
          </span>
        </button>
      </div>
    </div>
  );
};

export default ChatHeader;
