import React, { useState, useEffect, useRef } from "react";
import {
  Globe,
  Plus,
  X,
  RotateCw,
  Maximize2,
  Minimize2,
  Terminal,
  FileDiff,
  FolderTree,
  Eye,
  Code2,
  Monitor,
  Tablet,
  Smartphone,
  ExternalLink,
  FolderOpen,
  Sparkles,
  Copy,
  Check,
} from "lucide-react";
import { useChatStore } from "@/stores/chatStore";
import { getEffectiveTheme, subscribeThemeChange, type EffectiveTheme } from "@/theme";
import BrowserNewTabTools from "./BrowserNewTabTools";
import FileExplorerView from "./FileExplorerView";
import IntegratedTerminalView from "./IntegratedTerminalView";
import GitChangesView from "./GitChangesView";

interface WebWorkspaceDrawerProps {
  isOpen?: boolean;
  onClose?: () => void;
}

function useEffectiveTheme(): EffectiveTheme {
  const [theme, setTheme] = useState<EffectiveTheme>(() => getEffectiveTheme());
  useEffect(() => {
    setTheme(getEffectiveTheme());
    return subscribeThemeChange(setTheme);
  }, []);
  return theme;
}

export const WebWorkspaceDrawer: React.FC<WebWorkspaceDrawerProps> = ({
  isOpen: propIsOpen,
  onClose: propOnClose,
}) => {
  const {
    sessions,
    activeSessionId,
    workbenchOpen,
    workbenchWidth,
    workbenchMaximized,
    workbenchTabs,
    activeWorkbenchTabId,
    autoOpenHtmlOutputs,
    setWorkbenchOpen,
    setWorkbenchWidth,
    setWorkbenchMaximized,
    setAutoOpenHtmlOutputs,
    addWorkbenchTab,
    closeWorkbenchTab,
    setActiveWorkbenchTab,
    updateWorkbenchTab,
    openUrlInWorkbench,
    openFileInWorkbench,
    openDiffInWorkbench,
    openTerminalInWorkbench,
  } = useChatStore();

  const isOpen = propIsOpen !== undefined ? propIsOpen : workbenchOpen;
  const effectiveTheme = useEffectiveTheme();
  const handleCloseDrawer = () => {
    setWorkbenchOpen(false);
    propOnClose?.();
  };

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const workDir = activeSession?.workDir || "";

  const activeTab =
    workbenchTabs.find((t) => t.id === activeWorkbenchTabId) || workbenchTabs[0];

  const [inputUrl, setInputUrl] = useState("");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [viewport, setViewport] = useState<"desktop" | "tablet" | "mobile">("desktop");
  const [htmlSourceContent, setHtmlSourceContent] = useState<string>("");
  const [copiedSource, setCopiedSource] = useState(false);

  const isResizingRef = useRef(false);

  useEffect(() => {
    if (!activeTab) return;
    if (activeTab.type === "url") {
      if (activeTab.filePath) {
        setInputUrl(activeTab.filePath);
      } else {
        setInputUrl(activeTab.url || "");
      }
    } else {
      setInputUrl("");
    }
  }, [activeTab?.id, activeTab?.url, activeTab?.filePath, activeTab?.type]);

  // 当 URL 标签页切换到源码视图时读取本地 HTML 源码
  useEffect(() => {
    if (
      activeTab?.type === "url" &&
      activeTab.viewMode === "code" &&
      activeTab.filePath &&
      window.electronAPI?.readWorkspaceFile
    ) {
      const rootDir =
        workDir ||
        activeTab.filePath.split("/").slice(0, -1).join("/") ||
        "/";
      window.electronAPI
        .readWorkspaceFile(rootDir, activeTab.filePath)
        .then((res) => {
          if (res?.success) {
            setHtmlSourceContent(res.content || "");
          }
        })
        .catch(() => {});
    }
  }, [activeTab?.id, activeTab?.viewMode, activeTab?.filePath, activeTab?.refreshKey, workDir]);

  // 全局快捷键支持：⌘P (文件树)、⌃` (终端)、⌃⇧G (Git Diff)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "p" && !e.shiftKey) {
        e.preventDefault();
        const existingFilesTab = useChatStore
          .getState()
          .workbenchTabs.find((t) => t.type === "files");
        if (existingFilesTab) {
          setWorkbenchOpen(true);
          setActiveWorkbenchTab(existingFilesTab.id);
        } else {
          addWorkbenchTab({ title: "工作区文件", type: "files" });
        }
      } else if (e.ctrlKey && e.key === "`") {
        e.preventDefault();
        openTerminalInWorkbench();
      } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "g") {
        e.preventDefault();
        openDiffInWorkbench();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (!isOpen) return null;

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    isResizingRef.current = true;
    const startX = e.clientX;
    const startWidth = workbenchMaximized
      ? Math.floor(window.innerWidth * 0.9)
      : workbenchWidth;

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!isResizingRef.current) return;
      const delta = startX - moveEvent.clientX;
      setWorkbenchMaximized(false);
      setWorkbenchWidth(startWidth + delta);
    };

    const onMouseUp = () => {
      isResizingRef.current = false;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  const handleNavigate = (targetUrl: string, title?: string, filePath?: string) => {
    const raw = targetUrl.trim();
    if (!raw) return;

    if (
      raw.startsWith("/") &&
      (raw.endsWith(".html") || raw.endsWith(".htm") || raw.endsWith(".svg"))
    ) {
      const localUrl = `local-media://local${encodeURI(raw)}`;
      openUrlInWorkbench(localUrl, raw.split("/").pop(), raw);
      return;
    }

    let finalUrl = raw;
    if (
      !finalUrl.startsWith("http://") &&
      !finalUrl.startsWith("https://") &&
      !finalUrl.startsWith("local-media://") &&
      !finalUrl.startsWith("app://")
    ) {
      if (
        finalUrl.startsWith("localhost") ||
        finalUrl.startsWith("127.0.0.1") ||
        /^localhost:\d+/.test(finalUrl)
      ) {
        finalUrl = `http://${finalUrl}`;
      } else if (finalUrl.includes(".") && !finalUrl.includes(" ")) {
        finalUrl = `https://${finalUrl}`;
      } else {
        finalUrl = `https://www.bing.com/search?q=${encodeURIComponent(finalUrl)}`;
      }
    }

    openUrlInWorkbench(finalUrl, title, filePath);
  };

  const handleRefresh = () => {
    if (!activeTab) return;
    setIsRefreshing(true);
    updateWorkbenchTab(activeTab.id, { refreshKey: Date.now() });
    setTimeout(() => setIsRefreshing(false), 450);
  };

  const handleOpenTool = (toolId: "changes" | "terminal" | "files") => {
    if (toolId === "changes") {
      openDiffInWorkbench();
      return;
    }
    if (toolId === "terminal") {
      openTerminalInWorkbench();
      return;
    }
    const existing = workbenchTabs.find((t) => t.type === "files");
    if (existing) {
      setActiveWorkbenchTab(existing.id);
      return;
    }
    updateWorkbenchTab(activeTab.id, {
      title: "工作区文件",
      type: "files",
      refreshKey: Date.now(),
    });
  };

  const iframeUrl =
    activeTab?.url && activeTab.url.startsWith("local-media://")
      ? `${activeTab.url}${activeTab.url.includes("?") ? "&" : "?"}t=${
          activeTab.refreshKey || 0
        }`
      : activeTab?.url;

  return (
    <>
      {/* 覆盖式遮罩：点击空白处收起工作台（不挤压左侧对话区） */}
      <div
        onClick={handleCloseDrawer}
        className="absolute inset-0 z-30 bg-black/35"
        title="点击收起工作台"
      />
      <aside
        style={{
          width: workbenchMaximized ? "90vw" : `${workbenchWidth}px`,
          maxWidth: "100%",
          backgroundColor:
            effectiveTheme === "light"
              ? "rgba(248, 250, 252, 0.94)"
              : "rgba(18, 18, 20, 0.94)",
          backdropFilter: "blur(28px) saturate(1.1)",
          WebkitBackdropFilter: "blur(28px) saturate(1.1)",
        }}
        className="absolute right-0 top-0 bottom-0 z-40 h-full flex flex-col border-l border-[color:var(--ui-divider-hairline)] shadow-[-12px_0_40px_-12px_rgba(0,0,0,0.45)] select-none transition-[width] duration-150 text-[var(--ui-text-primary)]"
      >
      {/* 左侧拖拽调宽手柄 */}
      <div
        onMouseDown={startResize}
        className="absolute left-0 top-0 bottom-0 w-1.5 -ml-0.5 cursor-col-resize hover:bg-[var(--ui-accent-blue-soft)] active:bg-[var(--ui-accent-blue)] transition-colors z-30"
        title="拖拽调整工作台宽度"
      />

      {/* ─── 1. 顶部多标签与快捷工具栏 (与 ChatHeader 同高 48px，视觉完全对齐) ─── */}
      <div className="h-[48px] bg-[var(--ui-panel-bg)] border-b border-[color:var(--ui-divider-hairline)] flex items-center px-3 gap-2 flex-shrink-0 titlebar-no-drag">
        {/* 左侧标签页独立滚动区：min-w-0 + overflow 保证绝不挤压右侧固定图标组 */}
        <div className="flex items-center gap-1.5 flex-1 min-w-0 overflow-x-auto">
        {workbenchTabs.map((tab) => {
          const isActive = tab.id === activeTab?.id;
          return (
            <div
              key={tab.id}
              onClick={() => setActiveWorkbenchTab(tab.id)}
              className={`h-7 px-2.5 flex items-center gap-1.5 rounded-lg text-xs cursor-pointer transition-all max-w-[170px] group border ${
                isActive
                  ? "bg-[var(--ui-card-bg)] text-[var(--ui-text-primary)] border-[color:var(--ui-border-subtle)] shadow-sm font-medium"
                  : "bg-transparent text-[var(--ui-text-muted)] border-transparent hover:bg-[var(--ui-block-hover-bg)] hover:text-[var(--ui-text-primary)]"
              }`}
            >
              {tab.type === "files" ? (
                <FolderTree size={12.5} className="text-[var(--ui-accent-blue)] flex-shrink-0" />
              ) : tab.type === "terminal" ? (
                <Terminal size={12.5} className="text-[var(--ui-accent-emerald)] flex-shrink-0" />
              ) : tab.type === "changes" ? (
                <FileDiff size={12.5} className="text-[var(--ui-accent-amber)] flex-shrink-0" />
              ) : (
                <Globe size={12.5} className="text-[var(--ui-accent-sky)] flex-shrink-0" />
              )}
              <span className="truncate text-[11px]">{tab.title}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  closeWorkbenchTab(tab.id);
                }}
                className="w-4 h-4 rounded flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-[var(--ui-chip-hover-bg)] text-[var(--ui-text-faint)] hover:text-[var(--ui-text-primary)] transition-opacity"
              >
                <X size={10} />
              </button>
            </div>
          );
        })}

        {/* [+] 新建标签按钮 */}
        <button
          onClick={() => addWorkbenchTab({ title: "工具台", type: "newtab" })}
          className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-[var(--ui-block-hover-bg)] text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] transition-colors flex-shrink-0"
          title="新建工具台标签页"
        >
          <Plus size={13.5} />
        </button>

        </div>

        {/* 右上角快捷直达图标：文件树 / 终端 / Git Diff / 自动预览 / 宽屏 / 关闭（固定不收缩，始终完整可见） */}
        <div className="flex items-center gap-1 text-[var(--ui-text-muted)] flex-shrink-0">
          <button
            onClick={() => handleOpenTool("files")}
            className={`w-7 h-7 flex items-center justify-center rounded-lg transition-colors ${
              activeTab?.type === "files"
                ? "text-[var(--ui-accent-blue)] bg-[var(--ui-accent-blue-soft)]"
                : "hover:bg-[var(--ui-block-hover-bg)] hover:text-[var(--ui-text-primary)]"
            }`}
            title="工作区文件树 (⌘P)"
          >
            <FolderTree size={13.5} />
          </button>
          <button
            onClick={() => openTerminalInWorkbench()}
            className={`w-7 h-7 flex items-center justify-center rounded-lg transition-colors ${
              activeTab?.type === "terminal"
                ? "text-[var(--ui-accent-emerald)] bg-[var(--ui-accent-emerald-soft)]"
                : "hover:bg-[var(--ui-block-hover-bg)] hover:text-[var(--ui-text-primary)]"
            }`}
            title="集成交互式终端 (⌃`)"
          >
            <Terminal size={13.5} />
          </button>
          <button
            onClick={() => openDiffInWorkbench()}
            className={`w-7 h-7 flex items-center justify-center rounded-lg transition-colors ${
              activeTab?.type === "changes"
                ? "text-[var(--ui-accent-amber)] bg-[var(--ui-accent-amber-soft)]"
                : "hover:bg-[var(--ui-block-hover-bg)] hover:text-[var(--ui-text-primary)]"
            }`}
            title="Git 变更对比 (⌃⇧G)"
          >
            <FileDiff size={13.5} />
          </button>
          <button
            onClick={() => setAutoOpenHtmlOutputs(!autoOpenHtmlOutputs)}
            className={`w-7 h-7 flex items-center justify-center rounded-lg transition-colors ${
              autoOpenHtmlOutputs
                ? "text-[var(--ui-accent-emerald)] bg-[var(--ui-accent-emerald-soft)]"
                : "text-[var(--ui-text-faint)] hover:bg-[var(--ui-block-hover-bg)] hover:text-[var(--ui-text-primary)]"
            }`}
            title={
              autoOpenHtmlOutputs
                ? "已开启：Agent 生成 HTML/SVG 时自动打开预览"
                : "已关闭：点击开启 HTML/SVG 产物自动预览"
            }
          >
            <Sparkles size={13.5} />
          </button>

          <div className="w-[1px] h-3.5 bg-[var(--ui-divider-hairline)] mx-0.5" />

          <button
            onClick={() => setWorkbenchMaximized(!workbenchMaximized)}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-[var(--ui-block-hover-bg)] hover:text-[var(--ui-text-primary)] transition-colors"
            title={workbenchMaximized ? "还原窄抽屉宽度" : "宽屏展开工作台 (90%)"}
          >
            {workbenchMaximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
          <button
            onClick={handleCloseDrawer}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-[var(--ui-block-hover-bg)] hover:text-[var(--ui-text-primary)] transition-colors"
            title="收起右侧工作台"
          >
            <X size={13.5} />
          </button>
        </div>
      </div>

      {/* ─── 2. 网页/产物预览专用地址栏与视口切换栏 (当处于 url 或 newtab 时显示) ─── */}
      {(activeTab?.type === "url" || activeTab?.type === "newtab") && (
        <div className="h-10 px-3 flex items-center gap-2 border-b border-[color:var(--ui-divider-hairline)] bg-[var(--ui-panel-bg)] flex-shrink-0">
          <button
            onClick={handleRefresh}
            className="p-1.5 rounded-lg text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-block-hover-bg)] transition-colors"
            title="刷新当前预览"
          >
            <RotateCw size={13} className={isRefreshing ? "animate-spin" : ""} />
          </button>

          <div className="flex-1 h-7 rounded-lg bg-[var(--ui-input-bg)] border border-[color:var(--ui-border-hairline)] flex items-center px-2.5 gap-1.5 focus-within:border-[color:var(--ui-accent-blue-border)] transition-colors">
            {activeTab?.filePath && (
              <span className="px-1.5 py-0.5 rounded bg-[var(--ui-accent-sky-soft)] text-[var(--ui-accent-sky)] text-[10px] font-medium flex-shrink-0">
                本地产物
              </span>
            )}
            <input
              type="text"
              value={inputUrl}
              onChange={(e) => setInputUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  handleNavigate(inputUrl);
                }
              }}
              placeholder="输入网址 (localhost:5173)、本地 HTML 路径或搜索词..."
              className="w-full bg-transparent text-xs text-[var(--ui-text-primary)] placeholder-[var(--ui-text-faint)] outline-none font-mono"
            />
          </div>

          {activeTab?.type === "url" && (
            <div className="flex items-center gap-1 flex-shrink-0">
              {activeTab.filePath && (
                <div className="flex items-center rounded-lg bg-[var(--ui-chip-bg)] p-0.5 border border-[color:var(--ui-border-hairline)]">
                  <button
                    onClick={() => updateWorkbenchTab(activeTab.id, { viewMode: "preview" })}
                    className={`px-2 py-0.5 rounded-md text-[10px] flex items-center gap-1 transition-colors ${
                      activeTab.viewMode !== "code"
                        ? "bg-[var(--ui-accent-sky-soft)] text-[var(--ui-accent-sky)] font-medium"
                        : "text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)]"
                    }`}
                    title="Chromium 实时渲染预览"
                  >
                    <Eye size={11} />
                    <span>预览</span>
                  </button>
                  <button
                    onClick={() => updateWorkbenchTab(activeTab.id, { viewMode: "code" })}
                    className={`px-2 py-0.5 rounded-md text-[10px] flex items-center gap-1 transition-colors ${
                      activeTab.viewMode === "code"
                        ? "bg-[var(--ui-accent-sky-soft)] text-[var(--ui-accent-sky)] font-medium"
                        : "text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)]"
                    }`}
                    title="查看 HTML 源码"
                  >
                    <Code2 size={11} />
                    <span>源码</span>
                  </button>
                </div>
              )}

              {activeTab.viewMode !== "code" && (
                <div className="flex items-center rounded-lg bg-[var(--ui-chip-bg)] p-0.5 border border-[color:var(--ui-border-hairline)]">
                  <button
                    onClick={() => setViewport("desktop")}
                    className={`p-1 rounded-md transition-colors ${
                      viewport === "desktop"
                        ? "bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)]"
                        : "text-[var(--ui-text-faint)] hover:text-[var(--ui-text-primary)]"
                    }`}
                    title="桌面自适应宽度 (100%)"
                  >
                    <Monitor size={11} />
                  </button>
                  <button
                    onClick={() => setViewport("tablet")}
                    className={`p-1 rounded-md transition-colors ${
                      viewport === "tablet"
                        ? "bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)]"
                        : "text-[var(--ui-text-faint)] hover:text-[var(--ui-text-primary)]"
                    }`}
                    title="平板视口 (768px)"
                  >
                    <Tablet size={11} />
                  </button>
                  <button
                    onClick={() => setViewport("mobile")}
                    className={`p-1 rounded-md transition-colors ${
                      viewport === "mobile"
                        ? "bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)]"
                        : "text-[var(--ui-text-faint)] hover:text-[var(--ui-text-primary)]"
                    }`}
                    title="手机视口 (375px)"
                  >
                    <Smartphone size={11} />
                  </button>
                </div>
              )}

              {activeTab.filePath ? (
                <button
                  onClick={() => window.electronAPI?.showInFolder(activeTab.filePath!)}
                  className="p-1.5 rounded-lg hover:bg-[var(--ui-block-hover-bg)] text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] transition-colors"
                  title="在 Finder 中显示产物文件"
                >
                  <FolderOpen size={13} />
                </button>
              ) : activeTab.url?.startsWith("http") ? (
                <button
                  onClick={() => window.electronAPI?.openExternalUrl?.(activeTab.url!)}
                  className="p-1.5 rounded-lg hover:bg-[var(--ui-block-hover-bg)] text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] transition-colors"
                  title="在系统默认浏览器中打开"
                >
                  <ExternalLink size={13} />
                </button>
              ) : null}
            </div>
          )}
        </div>
      )}

      {/* ─── 3. 主内容渲染区 (外层带柔和舞台包裹，与左侧会话区视觉统一) ─── */}
      <div className="flex-1 overflow-hidden relative bg-[var(--ui-stage-wrap-bg)] p-2.5 flex flex-col">
        <div className="flex-1 min-h-0 overflow-hidden bg-[var(--ui-stage-bg)] border border-[color:var(--ui-border-hairline)] rounded-2xl shadow-[var(--ui-stage-shadow)] flex flex-col">
          {activeTab?.type === "newtab" ? (
            <BrowserNewTabTools
              onOpenTool={handleOpenTool}
              onOpenUrl={handleNavigate}
            />
          ) : activeTab?.type === "files" ? (
            <FileExplorerView
              initialFilePath={activeTab.filePath}
              initialLineNumber={activeTab.lineNumber}
              initialViewMode={activeTab.viewMode}
              refreshKey={activeTab.refreshKey}
            />
          ) : activeTab?.type === "changes" ? (
            <GitChangesView
              initialFilePath={activeTab.filePath}
              refreshKey={activeTab.refreshKey}
            />
          ) : activeTab?.type === "terminal" ? (
            <IntegratedTerminalView />
          ) : activeTab?.viewMode === "code" && activeTab.filePath ? (
            <div className="flex-1 flex flex-col overflow-hidden bg-[var(--ui-stage-bg)] select-text">
              <div className="h-9 px-3 border-b border-[color:var(--ui-divider-hairline)] bg-[var(--ui-card-header-bg)] flex items-center justify-between select-none">
                <span className="text-[11px] font-mono text-[var(--ui-text-muted)] truncate">
                  {activeTab.filePath}
                </span>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(htmlSourceContent);
                      setCopiedSource(true);
                      setTimeout(() => setCopiedSource(false), 1200);
                    }}
                    className="px-2 py-0.5 rounded-md hover:bg-[var(--ui-block-hover-bg)] text-[11px] text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] flex items-center gap-1"
                  >
                    {copiedSource ? (
                      <Check size={11} className="text-[var(--ui-accent-emerald)]" />
                    ) : (
                      <Copy size={11} />
                    )}
                    <span>复制源码</span>
                  </button>
                  <button
                    onClick={() =>
                      openFileInWorkbench(activeTab.filePath!, { viewMode: "code" })
                    }
                    className="px-2 py-0.5 rounded-md hover:bg-[var(--ui-block-hover-bg)] text-[11px] text-[var(--ui-accent-blue)]"
                  >
                    在文件树中定位
                  </button>
                </div>
              </div>
              <div className="flex-1 overflow-auto py-2 font-mono text-[12px] leading-[1.6] custom-scrollbar bg-[var(--ui-code-bg)]">
                {htmlSourceContent.split(/\r?\n/).map((line, idx) => (
                  <div
                    key={idx}
                    className="flex px-2 hover:bg-[var(--ui-block-hover-bg)]"
                  >
                    <span className="w-10 pr-3 text-right text-[11px] text-[var(--ui-text-faint)] select-none flex-shrink-0">
                      {idx + 1}
                    </span>
                    <span className="whitespace-pre-wrap break-all text-[var(--ui-text-primary)] flex-1">
                      {line || " "}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex-1 w-full h-full overflow-auto flex justify-center bg-[var(--ui-stage-wrap-bg)]">
              <div
                style={{
                  width:
                    viewport === "mobile"
                      ? "375px"
                      : viewport === "tablet"
                      ? "768px"
                      : "100%",
                }}
                className={`h-full transition-all duration-200 ${
                  viewport !== "desktop"
                    ? "my-2 rounded-xl overflow-hidden border border-[color:var(--ui-border-subtle)] shadow-lg"
                    : "w-full"
                }`}
              >
                <iframe
                  key={`${activeTab?.url}_${activeTab?.refreshKey || 0}`}
                  src={iframeUrl}
                  className="w-full h-full border-0 bg-white"
                  title={activeTab?.title || "Web Preview"}
                  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
                />
              </div>
            </div>
          )}
        </div>
      </div>
      </aside>
    </>
  );
};

export default WebWorkspaceDrawer;
