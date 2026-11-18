import React, { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  ChevronDown,
  ChevronRight,
  Globe,
  FileText,
  FileSpreadsheet,
  Code,
  File,
  FolderOpen,
  Eye,
  Sparkles,
  Download,
  FileDown,
  Check,
} from "lucide-react";
import { useChatStore } from "@/stores/chatStore";

export const OutputsCard: React.FC = () => {
  const [isOpen, setIsOpen] = useState(true);
  const [exportedId, setExportedId] = useState<string | null>(null);
  const {
    sessions,
    activeSessionId,
    outputs,
    autoOpenHtmlOutputs,
    setAutoOpenHtmlOutputs,
    openUrlInWorkbench,
    openFileInWorkbench,
  } = useChatStore(
    useShallow((s) => ({
      sessions: s.sessions,
      activeSessionId: s.activeSessionId,
      outputs: s.outputs,
      autoOpenHtmlOutputs: s.autoOpenHtmlOutputs,
      setAutoOpenHtmlOutputs: s.setAutoOpenHtmlOutputs,
      openUrlInWorkbench: s.openUrlInWorkbench,
      openFileInWorkbench: s.openFileInWorkbench,
    }))
  );
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const workDir = activeSession?.workDir || null;

  const renderIcon = (name: string, type: string) => {
    const lower = name.toLowerCase();
    if (lower.endsWith(".html") || lower.endsWith(".htm") || lower.endsWith(".svg") || type === "html") {
      return <Globe size={13.5} className="text-[var(--ui-accent-sky)]" />;
    }
    if (lower.endsWith(".csv") || lower.endsWith(".tsv") || lower.endsWith(".xlsx") || lower.endsWith(".xlsm")) {
      return <FileSpreadsheet size={13.5} className="text-[var(--ui-accent-emerald)]" />;
    }
    if (
      lower.endsWith(".md") ||
      lower.endsWith(".markdown") ||
      lower.endsWith(".docx") ||
      lower.endsWith(".doc") ||
      lower.endsWith(".pdf") ||
      lower.endsWith(".pptx") ||
      type === "markdown"
    ) {
      return <FileText size={13.5} className="text-[var(--ui-accent-amber)]" />;
    }
    if (
      lower.endsWith(".ts") ||
      lower.endsWith(".tsx") ||
      lower.endsWith(".js") ||
      lower.endsWith(".jsx") ||
      lower.endsWith(".json") ||
      lower.endsWith(".py")
    ) {
      return <Code size={13.5} className="text-[var(--ui-accent-blue)]" />;
    }
    return <File size={13.5} className="text-[var(--ui-text-muted)]" />;
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

  const handleExport = async (
    e: React.MouseEvent,
    item: { id: string; filePath: string },
    format: "original" | "html" | "pdf"
  ) => {
    e.stopPropagation();
    if (!window.electronAPI?.exportFileOutput) return;
    const res = await window.electronAPI.exportFileOutput({
      workDir,
      filePath: item.filePath,
      format,
    });
    if (res?.success) {
      setExportedId(item.id);
      setTimeout(() => {
        setExportedId((prev) => (prev === item.id ? null : prev));
      }, 1800);
    }
  };

  return (
    <div className="border-b border-[color:var(--ui-divider-hairline)] last:border-b-0 transition-colors select-none titlebar-no-drag">
      {/* 头部标题与折叠开关 */}
      <div
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-[var(--ui-block-hover-bg)] transition-colors cursor-pointer"
      >
        <div className="flex items-center gap-2">
          {isOpen ? (
            <ChevronDown size={12} className="text-[var(--ui-text-faint)]" />
          ) : (
            <ChevronRight size={12} className="text-[var(--ui-text-faint)]" />
          )}
          <span className="text-[11px] font-semibold text-[var(--ui-text-secondary)]">
            交付产物
          </span>
          {outputs.length > 0 && (
            <span className="px-1.5 py-0.2 rounded-full text-[10px] font-mono bg-[var(--ui-chip-bg)] text-[var(--ui-text-muted)]">
              {outputs.length}
            </span>
          )}
        </div>

        <button
          onClick={(e) => {
            e.stopPropagation();
            setAutoOpenHtmlOutputs(!autoOpenHtmlOutputs);
          }}
          className={`p-1 rounded-md transition-colors ${
            autoOpenHtmlOutputs
              ? "text-[var(--ui-accent-emerald)] bg-[var(--ui-accent-emerald-soft)]"
              : "text-[var(--ui-text-faint)] hover:text-[var(--ui-text-secondary)]"
          }`}
          title={
            autoOpenHtmlOutputs
              ? "已开启：生成 HTML/SVG 产物时自动在右侧打开预览"
              : "点击开启 HTML/SVG 产物自动预览"
          }
        >
          <Sparkles size={12} />
        </button>
      </div>

      {/* 折叠内容 */}
      {isOpen && (
        <div className="px-3 pb-3 pt-0.5 flex flex-col gap-1 max-h-[180px] overflow-y-auto custom-scrollbar overscroll-contain">
          {outputs.length === 0 ? (
            <div className="py-2 px-1 text-[11px] text-[var(--ui-text-faint)]">
              当前会话暂无新增或修改的交付产物
            </div>
          ) : (
            outputs.map((item) => {
              const lower = item.name.toLowerCase();
              const isMarkdown = lower.endsWith(".md") || lower.endsWith(".markdown");
              const canExportPdf =
                isMarkdown ||
                lower.endsWith(".html") ||
                lower.endsWith(".htm") ||
                lower.endsWith(".docx");
              const isExported = exportedId === item.id;
              return (
                <div
                  key={item.id}
                  onClick={() => handlePreviewOutput(item)}
                  className="flex items-center justify-between py-1.5 px-2 rounded-lg hover:bg-[var(--ui-block-hover-bg)] transition-colors cursor-pointer group"
                  title={`点击在右侧工作台预览: ${item.filePath}`}
                >
                  <div className="flex items-center gap-2 min-w-0 pr-1.5">
                    <span className="flex-shrink-0">{renderIcon(item.name, item.fileType)}</span>
                    <span className="text-[11.5px] font-normal text-[var(--ui-text-secondary)] truncate group-hover:text-[var(--ui-text-primary)] transition-colors">
                      {item.name}
                    </span>
                  </div>

                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                    <span
                      className="p-1 rounded hover:bg-[var(--ui-chip-bg)] text-[var(--ui-text-faint)] hover:text-[var(--ui-accent-sky)]"
                      title="在右侧工作台预览"
                    >
                      <Eye size={12} />
                    </span>
                    {canExportPdf && (
                      <button
                        onClick={(e) => void handleExport(e, item, "pdf")}
                        className="p-1 rounded hover:bg-[var(--ui-chip-bg)] text-[var(--ui-text-faint)] hover:text-[var(--ui-accent-rose)] cursor-pointer"
                        title="导出为 PDF 文档"
                      >
                        <FileDown size={12} />
                      </button>
                    )}
                    <button
                      onClick={(e) => void handleExport(e, item, "original")}
                      className="p-1 rounded hover:bg-[var(--ui-chip-bg)] text-[var(--ui-text-faint)] hover:text-[var(--ui-accent-emerald)] cursor-pointer"
                      title="另存为..."
                    >
                      {isExported ? (
                        <Check size={12} className="text-[var(--ui-accent-emerald)]" />
                      ) : (
                        <Download size={12} />
                      )}
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        window.electronAPI?.showInFolder(item.filePath);
                      }}
                      className="p-1 rounded hover:bg-[var(--ui-chip-bg)] text-[var(--ui-text-faint)] hover:text-[var(--ui-text-primary)] cursor-pointer"
                      title="在 Finder 中定位"
                    >
                      <FolderOpen size={12} />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
};

export default OutputsCard;
