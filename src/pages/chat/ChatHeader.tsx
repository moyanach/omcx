import React, { useEffect, useRef, useState } from "react";
import { Session } from "../../stores/chatStore";
import { PanelLeft, Compass, MoreHorizontal, GitFork, Download, Loader2 } from "lucide-react";
import { useChatStore } from "@/stores/chatStore";

interface Props {
  session: Session | undefined;
  leftPanelOpen: boolean;
  onToggleLeftPanel: () => void;
  rightDrawerOpen: boolean;
  onToggleRightDrawer: () => void;
  compact?: boolean;
  onNotify?: (message: string) => void;
}

const ChatHeader: React.FC<Props> = ({
  session,
  leftPanelOpen,
  onToggleLeftPanel,
  rightDrawerOpen,
  onToggleRightDrawer,
  compact = false,
  onNotify,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState<"" | "fork" | "export">("");
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  const handleFork = async () => {
    if (!session || busy) return;
    setBusy("fork");
    setMenuOpen(false);
    try {
      const id = await useChatStore.getState().forkSession(session.id);
      onNotify?.(id ? "已创建会话分支" : "创建会话分支失败");
    } finally {
      setBusy("");
    }
  };

  const handleExport = async () => {
    if (!session || busy) return;
    setBusy("export");
    setMenuOpen(false);
    try {
      const result = await window.electronAPI?.exportSession?.(session.id);
      if (result?.success) onNotify?.(`会话已导出：${result.filePath}`);
      else if (!result?.canceled) onNotify?.(result?.error || "导出会话失败");
    } catch (err: any) {
      onNotify?.(err?.message || "导出会话失败");
    } finally {
      setBusy("");
    }
  };
  if (!session) return null;

  return (
    <div className="h-[48px] border-b border-[color:var(--ui-divider-hairline)] bg-[var(--ui-panel-bg)] backdrop-blur-xl backdrop-saturate-150 flex-shrink-0 flex items-center justify-between gap-2 px-3.5 overflow-hidden titlebar-drag select-none z-30">
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
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setMenuOpen((v) => !v)}
            disabled={Boolean(busy)}
            title="会话操作：分支 / 导出"
            className="h-7 w-7 flex items-center justify-center rounded-lg border border-[color:var(--ui-border-hairline)] bg-[var(--ui-chip-bg)] text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-chip-hover-bg)] transition-all disabled:opacity-50"
          >
            {busy ? <Loader2 size={13.5} className="animate-spin" /> : <MoreHorizontal size={14} />}
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-8 z-[200] w-44 rounded-xl bg-[var(--ui-popover-bg)] backdrop-blur-xl backdrop-saturate-150 border border-[color:var(--ui-border-subtle)] shadow-[var(--ui-popover-shadow)] p-1 select-none">
              <button
                onClick={handleFork}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[11px] text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-block-hover-bg)] transition-colors"
              >
                <GitFork size={12} className="text-[var(--ui-accent-sky)]" />
                分支当前会话
              </button>
              <button
                onClick={handleExport}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[11px] text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-block-hover-bg)] transition-colors"
              >
                <Download size={12} className="text-[var(--ui-accent-emerald)]" />
                导出为 Markdown
              </button>
            </div>
          )}
        </div>

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
