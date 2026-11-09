import React, { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Globe,
  FileText,
  Code,
  File,
  FolderOpen,
  Eye,
  Sparkles,
} from "lucide-react";
import { useChatStore } from "@/stores/chatStore";

export const OutputsCard: React.FC = () => {
  const [isOpen, setIsOpen] = useState(true);
  const {
    outputs,
    autoOpenHtmlOutputs,
    setAutoOpenHtmlOutputs,
    openUrlInWorkbench,
    openFileInWorkbench,
  } = useChatStore();

  const renderIcon = (name: string, type: string) => {
    const lower = name.toLowerCase();
    if (lower.endsWith(".html") || lower.endsWith(".htm") || lower.endsWith(".svg") || type === "html") {
      return <Globe size={14} className="text-sky-400" />;
    }
    if (lower.endsWith(".md") || type === "markdown") {
      return <FileText size={14} className="text-amber-300" />;
    }
    if (
      lower.endsWith(".ts") ||
      lower.endsWith(".tsx") ||
      lower.endsWith(".js") ||
      lower.endsWith(".jsx") ||
      lower.endsWith(".json") ||
      lower.endsWith(".py")
    ) {
      return <Code size={14} className="text-emerald-400" />;
    }
    return <File size={14} className="text-[var(--ui-text-muted)]" />;
  };

  const handlePreviewOutput = (item: { name: string; filePath: string; fileType: string }) => {
    const lower = item.name.toLowerCase();
    if (lower.endsWith(".html") || lower.endsWith(".htm") || lower.endsWith(".svg")) {
      const localUrl = `local-media://local${encodeURI(item.filePath)}`;
      openUrlInWorkbench(localUrl, item.name, item.filePath);
    } else {
      openFileInWorkbench(item.filePath);
    }
  };

  return (
    <div className="bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-hairline)] rounded-2xl overflow-hidden transition-all duration-200 select-none titlebar-no-drag">
      {/* 头部标题与折叠开关 */}
      <div
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-[var(--ui-block-hover-bg)] transition-colors cursor-pointer"
      >
        <div className="flex items-center gap-2">
          <span className="font-semibold text-sm text-[var(--ui-text-primary)] tracking-wide">
            Outputs (会话产物)
          </span>
          {outputs.length > 0 && (
            <span className="px-1.5 py-0.2 rounded-full text-[10px] font-mono bg-[var(--ui-chip-bg)] text-[var(--ui-text-muted)]">
              {outputs.length}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setAutoOpenHtmlOutputs(!autoOpenHtmlOutputs);
            }}
            className={`p-1 rounded-md transition-colors ${
              autoOpenHtmlOutputs
                ? "text-emerald-400 bg-emerald-500/10"
                : "text-[var(--ui-text-faint)] hover:text-[var(--ui-text-secondary)]"
            }`}
            title={
              autoOpenHtmlOutputs
                ? "已开启：生成 HTML/SVG 产物时自动在右侧打开预览"
                : "点击开启 HTML/SVG 产物自动预览"
            }
          >
            <Sparkles size={13} />
          </button>
          <div className="text-[var(--ui-text-faint)]">
            {isOpen ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
          </div>
        </div>
      </div>

      {/* 折叠内容 */}
      {isOpen && (
        <div className="px-4 pb-3.5 pt-0.5 flex flex-col gap-1.5 max-h-[160px] overflow-y-auto custom-scrollbar pr-1 overscroll-contain">
          {outputs.length === 0 ? (
            <div className="py-2.5 text-center text-xs text-[var(--ui-text-faint)]">
              当前会话暂无新增或修改的产物文件
            </div>
          ) : (
            outputs.map((item) => (
              <div
                key={item.id}
                onClick={() => handlePreviewOutput(item)}
                className="flex items-center justify-between py-1.5 px-2 -mx-1.5 rounded-lg hover:bg-[var(--ui-block-hover-bg)] transition-colors cursor-pointer group"
                title={`点击在右侧工作台预览: ${item.filePath}`}
              >
                <div className="flex items-center gap-2 min-w-0 pr-2">
                  <span className="flex-shrink-0">
                    {renderIcon(item.name, item.fileType)}
                  </span>
                  <span className="text-xs font-normal text-[var(--ui-text-secondary)] truncate group-hover:text-[var(--ui-text-primary)] transition-colors">
                    {item.name}
                  </span>
                </div>

                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                  <span
                    className="p-1 rounded hover:bg-[var(--ui-chip-bg)] text-[var(--ui-text-faint)] hover:text-sky-400"
                    title="在右侧工作台打开预览"
                  >
                    <Eye size={12.5} />
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      window.electronAPI?.showInFolder(item.filePath);
                    }}
                    className="p-1 rounded hover:bg-[var(--ui-chip-bg)] text-[var(--ui-text-faint)] hover:text-[var(--ui-text-primary)]"
                    title="在 Finder 中定位"
                  >
                    <FolderOpen size={12.5} />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
};

export default OutputsCard;
