import React from "react";
import {
  FileDiff,
  Terminal,
  FolderTree,
  Sparkles,
  Globe,
  FileText,
  FileCode,
  FolderOpen,
} from "lucide-react";
import { useChatStore } from "@/stores/chatStore";

interface BrowserNewTabToolsProps {
  onOpenTool: (toolId: "changes" | "terminal" | "files") => void;
  onOpenUrl: (url: string, title?: string, filePath?: string) => void;
}

export const BrowserNewTabTools: React.FC<BrowserNewTabToolsProps> = ({
  onOpenTool,
  onOpenUrl,
}) => {
  const {
    sessions,
    activeSessionId,
    workspaces,
    gitStatus,
    outputs,
    toolCallsBySession,
    autoOpenHtmlOutputs,
    setAutoOpenHtmlOutputs,
    openFileInWorkbench,
  } = useChatStore();

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const primaryWorkDir = activeSession?.workDir || "";
  const matchedWs = workspaces.find((ws) =>
    ws.folders?.some((f) => f.path === primaryWorkDir)
  );
  const rootCount = matchedWs?.folders?.length || (primaryWorkDir ? 1 : 0);
  const workDirLabel = matchedWs
    ? `${matchedWs.name} (${rootCount} 个目录)`
    : primaryWorkDir
    ? primaryWorkDir.split(/[\\/]/).pop()
    : "未绑定目录";

  const modifiedCount = gitStatus?.modifiedFiles?.length || 0;
  const agentCmdCount = activeSessionId
    ? (toolCallsBySession[activeSessionId] || []).filter(
        (tc: any) => tc.tool === "run_command"
      ).length
    : 0;

  return (
    <div className="flex-1 h-full bg-[var(--ui-stage-bg)] p-6 flex flex-col overflow-y-auto select-none custom-scrollbar text-[var(--ui-text-primary)]">
      {/* 标题与自动预览开关 */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-base font-bold text-[var(--ui-text-primary)] tracking-tight">
            工作空间工具台
          </h2>
          <p className="text-xs text-[var(--ui-text-muted)] mt-0.5">
            内置 Chromium 产物渲染、多目录代码树、交互终端与 Git 审查
          </p>
        </div>

        <button
          onClick={() => setAutoOpenHtmlOutputs(!autoOpenHtmlOutputs)}
          className={`px-2.5 py-1.5 rounded-xl border text-[11px] flex items-center gap-1.5 transition-all cursor-pointer ${
            autoOpenHtmlOutputs
              ? "bg-[var(--ui-accent-emerald-soft)] text-[var(--ui-accent-emerald)] border-[color:var(--ui-accent-emerald-border)] font-medium"
              : "bg-[var(--ui-chip-bg)] text-[var(--ui-text-muted)] border-[color:var(--ui-border-hairline)] hover:text-[var(--ui-text-primary)]"
          }`}
          title="当 Agent 生成或修改 .html / .svg 文件时自动弹出并实时刷新预览"
        >
          <Sparkles size={12} />
          <span>HTML 自动预览: {autoOpenHtmlOutputs ? "开启" : "关闭"}</span>
        </button>
      </div>

      {/* 3 大核心工程工具卡片 */}
      <div className="flex flex-col gap-2.5">
        {/* 卡片 1: 工作区文件与代码浏览 (⌘P) */}
        <div
          onClick={() => onOpenTool("files")}
          className="flex items-center justify-between p-3.5 rounded-xl bg-[var(--ui-card-bg)] hover:bg-[var(--ui-block-hover-bg)] border border-[color:var(--ui-border-hairline)] cursor-pointer transition-all duration-150 group"
        >
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-[var(--ui-accent-blue-soft)] flex items-center justify-center text-[var(--ui-accent-blue)] border border-[color:var(--ui-accent-blue-border)]">
              <FolderTree size={16} />
            </div>
            <div className="flex flex-col">
              <span className="font-semibold text-xs text-[var(--ui-text-primary)]">
                工作区文件树与预览
              </span>
              <span className="text-[11px] text-[var(--ui-text-muted)]">
                {workDirLabel} · 支持多 Root 目录展开、源码行号与网页预览
              </span>
            </div>
          </div>
          <span className="px-2 py-0.5 rounded-md bg-[var(--ui-chip-bg)] text-[var(--ui-text-muted)] font-mono text-[11px] border border-[color:var(--ui-border-hairline)]">
            ⌘P
          </span>
        </div>

        {/* 卡片 2: 集成交互式终端 (^ `) */}
        <div
          onClick={() => onOpenTool("terminal")}
          className="flex items-center justify-between p-3.5 rounded-xl bg-[var(--ui-card-bg)] hover:bg-[var(--ui-block-hover-bg)] border border-[color:var(--ui-border-hairline)] cursor-pointer transition-all duration-150 group"
        >
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-[var(--ui-accent-emerald-soft)] flex items-center justify-center text-[var(--ui-accent-emerald)] border border-[color:var(--ui-accent-emerald-border)]">
              <Terminal size={16} />
            </div>
            <div className="flex flex-col">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-xs text-[var(--ui-text-primary)]">
                  集成交互终端
                </span>
                {agentCmdCount > 0 && (
                  <span className="px-1.5 py-0.2 rounded bg-[var(--ui-accent-emerald-soft)] text-[var(--ui-accent-emerald)] text-[10px] font-mono">
                    {agentCmdCount} 条 Agent 命令
                  </span>
                )}
              </div>
              <span className="text-[11px] text-[var(--ui-text-muted)]">
                支持实时流式执行 Shell 命令、目录切换与 Agent 命令同步
              </span>
            </div>
          </div>
          <span className="px-2 py-0.5 rounded-md bg-[var(--ui-chip-bg)] text-[var(--ui-text-muted)] font-mono text-[11px] border border-[color:var(--ui-border-hairline)]">
            ^ `
          </span>
        </div>

        {/* 卡片 3: 代码变更 Git Diff (^⇧G) */}
        <div
          onClick={() => onOpenTool("changes")}
          className="flex items-center justify-between p-3.5 rounded-xl bg-[var(--ui-card-bg)] hover:bg-[var(--ui-block-hover-bg)] border border-[color:var(--ui-border-hairline)] cursor-pointer transition-all duration-150 group"
        >
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-[var(--ui-accent-amber-soft)] flex items-center justify-center text-[var(--ui-accent-amber)] border border-[color:var(--ui-accent-amber-border)]">
              <FileDiff size={16} />
            </div>
            <div className="flex flex-col">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-xs text-[var(--ui-text-primary)]">
                  代码变更审查 (Git Diff)
                </span>
                {modifiedCount > 0 && (
                  <span className="px-1.5 py-0.2 rounded bg-[var(--ui-accent-amber-soft)] text-[var(--ui-accent-amber)] text-[10px] font-mono">
                    {modifiedCount} 个待提交文件
                  </span>
                )}
              </div>
              <span className="text-[11px] text-[var(--ui-text-muted)]">
                左右分栏/行内 Diff 对比，支持一键 Git Stage & Commit
              </span>
            </div>
          </div>
          <span className="px-2 py-0.5 rounded-md bg-[var(--ui-chip-bg)] text-[var(--ui-text-muted)] font-mono text-[11px] border border-[color:var(--ui-border-hairline)]">
            ^⇧G
          </span>
        </div>
      </div>

      {/* 当前会话生成的产物列表 (Outputs 快速预览) */}
      {outputs.length > 0 && (
        <div className="mt-6 pt-5 border-t border-[color:var(--ui-divider-hairline)]">
          <h3 className="text-[11px] font-semibold text-[var(--ui-text-muted)] uppercase tracking-wider mb-2.5">
            当前会话产物 ({outputs.length})
          </h3>
          <div className="flex flex-col gap-1.5">
            {outputs.slice(0, 8).map((item) => {
              const lower = item.name.toLowerCase();
              const isHtml =
                lower.endsWith(".html") ||
                lower.endsWith(".htm") ||
                lower.endsWith(".svg");
              return (
                <div
                  key={item.id}
                  onClick={() => {
                    if (isHtml) {
                      const localUrl = `local-media://local${encodeURI(item.filePath)}`;
                      onOpenUrl(localUrl, item.name, item.filePath);
                    } else {
                      openFileInWorkbench(item.filePath);
                    }
                  }}
                  className="p-2.5 rounded-xl bg-[var(--ui-card-bg)] hover:bg-[var(--ui-block-hover-bg)] border border-[color:var(--ui-border-hairline)] flex items-center justify-between cursor-pointer transition-colors group"
                >
                  <div className="flex items-center gap-2 min-w-0 pr-2">
                    {isHtml ? (
                      <Globe size={13.5} className="text-[var(--ui-accent-sky)] flex-shrink-0" />
                    ) : lower.endsWith(".md") ? (
                      <FileText size={13.5} className="text-[var(--ui-accent-amber)] flex-shrink-0" />
                    ) : (
                      <FileCode size={13.5} className="text-[var(--ui-accent-emerald)] flex-shrink-0" />
                    )}
                    <span className="text-xs text-[var(--ui-text-primary)] truncate font-medium">
                      {item.name}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <span className="text-[10px] text-[var(--ui-text-faint)] group-hover:text-[var(--ui-accent-blue)]">
                      {isHtml ? "实时渲染" : "查看文件"}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        window.electronAPI?.showInFolder(item.filePath);
                      }}
                      className="p-1 rounded hover:bg-[var(--ui-chip-hover-bg)] text-[var(--ui-text-faint)] hover:text-[var(--ui-text-primary)]"
                      title="在 Finder 中定位"
                    >
                      <FolderOpen size={11} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

export default BrowserNewTabTools;
