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
  Bot,
  Loader2,
  MessageSquareText,
} from "lucide-react";
import { useChatStore } from "@/stores/chatStore";
import { usePanelResize } from "@/hooks/usePanelResize";
import { getEffectiveTheme, subscribeThemeChange, type EffectiveTheme } from "@/theme";
import BrowserNewTabTools from "./BrowserNewTabTools";
import FileExplorerView from "./FileExplorerView";
import IntegratedTerminalView from "./IntegratedTerminalView";
import GitChangesView from "./GitChangesView";
import BrowserAutomationView from "./BrowserAutomationView";
import BtwPanel from "@/pages/chat/BtwPanel";

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
  const [frameLoading, setFrameLoading] = useState(false);
  const [frameTimedOut, setFrameTimedOut] = useState(false);

  const frameLoadedRef = useRef(false);

  // 工作台宽度拖拽：rAF 直写 DOM，松手才提交一次 store，避免每帧 React 重渲染造成卡顿
  const {
    targetRef: drawerRef,
    onPointerDown: startResize,
    widthRef: resizeWidthRef,
    isResizingRef,
    isDragging: isResizing,
  } = usePanelResize({
    edge: "left",
    min: 360,
    max:
      typeof window !== "undefined" ? Math.floor(window.innerWidth * 0.92) : 1600,
    getWidth: () =>
      workbenchMaximized
        ? Math.floor(window.innerWidth * 0.9)
        : workbenchWidth,
    onStart: () => setWorkbenchMaximized(false),
    onCommit: (width) => setWorkbenchWidth(width),
  });

  const liveResizeWidth =
    isResizingRef.current && resizeWidthRef.current != null
      ? resizeWidthRef.current
      : null;

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

  // 网页 iframe 首次加载态：8s 内未触发 onLoad 则提示可能被目标站点拒绝嵌入
  useEffect(() => {
    if (activeTab?.type !== "url" || activeTab?.viewMode === "code") {
      setFrameLoading(false);
      setFrameTimedOut(false);
      return;
    }
    frameLoadedRef.current = false;
    setFrameLoading(true);
    setFrameTimedOut(false);
    const timer = setTimeout(() => {
      if (!frameLoadedRef.current) {
        setFrameLoading(false);
        setFrameTimedOut(true);
      }
    }, 8000);
    return () => clearTimeout(timer);
  }, [activeTab?.id, activeTab?.type, activeTab?.url, activeTab?.refreshKey, activeTab?.viewMode]);

  const handleFrameLoad = () => {
    frameLoadedRef.current = true;
    setFrameLoading(false);
    setFrameTimedOut(false);
  };

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

  const handleOpenAutomation = () => {
    const existing = workbenchTabs.find((t) => t.type === "automation");
    if (existing) {
      setActiveWorkbenchTab(existing.id);
      return;
    }
    addWorkbenchTab({ title: "浏览器自动化", type: "automation" });
  };

  const handleOpenInAutomation = (targetUrl?: string) => {
    // 先切到自动化标签页，让用户立即看到加载进度，再异步打开目标页面
    handleOpenAutomation();
    const target = String(targetUrl || "").trim();
    if (target && window.electronAPI?.browserAutoOpen) {
      window.electronAPI.browserAutoOpen(target).catch(() => {});
    }
  };

  const handleOpenBtw = () => {
    const existing = workbenchTabs.find((t) => t.type === "btw");
    if (existing) {
      setWorkbenchOpen(true);
      setActiveWorkbenchTab(existing.id);
      return;
    }
    addWorkbenchTab({ title: "旁路问答", type: "btw" });
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
      {/* 拖拽期间的全屏拦截层：避免鼠标掠过 iframe / 焦点元素时丢失 pointermove */}
      {isResizing && (
        <div className="absolute inset-0 z-[60] cursor-col-resize" />
      )}
      <aside
        ref={drawerRef as React.RefObject<HTMLElement>}
        style={{
          width:
            liveResizeWidth != null
              ? `${liveResizeWidth}px`
              : workbenchMaximized
              ? "90vw"
              : `${workbenchWidth}px`,
          maxWidth: "100%",
          backgroundColor:
            effectiveTheme === "light"
              ? isResizing
                ? "rgb(248, 250, 252)"
                : "rgba(248, 250, 252, 0.94)"
              : isResizing
              ? "rgb(18, 18, 20)"
              : "rgba(18, 18, 20, 0.94)",
          // 拖拽期间关闭 28px 背景模糊与阴影，避免每帧重算合成层
          backdropFilter: isResizing ? "none" : "blur(28px) saturate(1.1)",
          WebkitBackdropFilter: isResizing ? "none" : "blur(28px) saturate(1.1)",
          boxShadow: isResizing
            ? "none"
            : "-12px 0 40px -12px rgba(0,0,0,0.45)",
        }}
        className={`absolute right-0 top-0 bottom-0 z-40 h-full flex flex-col border-l border-[color:var(--ui-divider-hairline)] select-none text-[var(--ui-text-primary)] ${
          isResizing ? "will-change-[width]" : "transition-[width] duration-150"
        }`}
      >
      {/* 左侧拖拽调宽手柄 */}
      <div
        onPointerDown={startResize}
        onDoubleClick={() => {
          setWorkbenchMaximized(false);
          setWorkbenchWidth(560);
        }}
        className="absolute left-0 top-0 bottom-0 w-2.5 -ml-[5px] cursor-col-resize z-30 hover:bg-[var(--ui-accent-blue-soft)] active:bg-[var(--ui-accent-blue)]/60 transition-colors"
        title="拖拽调整工作台宽度（双击恢复默认）"
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
              ) : tab.type === "automation" ? (
                <Bot size={12.5} className="text-[var(--ui-accent-violet)] flex-shrink-0" />
              ) : tab.type === "btw" ? (
                <MessageSquareText size={12.5} className="text-[var(--ui-accent-sky)] flex-shrink-0" />
              ) : (
                <Globe size={12.5} className="text-[var(--ui-accent-sky)] flex-shrink-0" />
              )}
              <span className="truncate text-[11px]">{tab.title}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  // 关闭自动化标签时同步收敛隐藏的自动化浏览器，避免后台页面继续驻留
                  if (tab.type === "automation") {
                    window.electronAPI?.browserAutoClose?.().catch(() => {});
                  }
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
            onClick={handleOpenAutomation}
            className={`w-7 h-7 flex items-center justify-center rounded-lg transition-colors ${
              activeTab?.type === "automation"
                ? "text-[var(--ui-accent-violet)] bg-[var(--ui-accent-violet-soft)]"
                : "hover:bg-[var(--ui-block-hover-bg)] hover:text-[var(--ui-text-primary)]"
            }`}
            title="浏览器自动化 (内置 Chromium + 视觉回归)"
          >
            <Bot size={13.5} />
          </button>
          <button
            onClick={handleOpenBtw}
            className={`w-7 h-7 flex items-center justify-center rounded-lg transition-colors ${
              activeTab?.type === "btw"
                ? "text-[var(--ui-accent-sky)] bg-[var(--ui-accent-sky-soft)]"
                : "hover:bg-[var(--ui-block-hover-bg)] hover:text-[var(--ui-text-primary)]"
            }`}
            title="旁路问答 (/btw)：不打断主线任务"
          >
            <MessageSquareText size={13.5} />
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
                <>
                  <button
                    onClick={() => handleOpenInAutomation(activeTab.url!)}
                    className="p-1.5 rounded-lg hover:bg-[var(--ui-block-hover-bg)] text-[var(--ui-text-muted)] hover:text-[var(--ui-accent-violet)] transition-colors"
                    title="用内置浏览器自动化打开（可绕过站点禁止嵌入限制）"
                  >
                    <Bot size={13} />
                  </button>
                  <button
                    onClick={() => window.electronAPI?.openExternalUrl?.(activeTab.url!)}
                    className="p-1.5 rounded-lg hover:bg-[var(--ui-block-hover-bg)] text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] transition-colors"
                    title="在系统默认浏览器中打开"
                  >
                    <ExternalLink size={13} />
                  </button>
                </>
              ) : null}
            </div>
          )}
        </div>
      )}

      {/* ─── 3. 主内容渲染区 (外层带柔和舞台包裹，与左侧会话区视觉统一) ─── */}
      <div className="flex-1 overflow-hidden relative bg-[var(--ui-stage-wrap-bg)] p-2.5 flex flex-col">
        <div className="flex-1 min-h-0 overflow-hidden bg-[var(--ui-stage-bg)] border border-[color:var(--ui-border-hairline)] rounded-2xl shadow-[var(--ui-stage-shadow)] flex flex-col">
          {/* 交互终端常驻挂载：切换其他标签页时仅隐藏，避免 Shell 进程被销毁 */}
          <div
            className={
              activeTab?.type === "terminal"
                ? "flex-1 min-h-0 flex flex-col"
                : "hidden"
            }
          >
            {workbenchTabs.some((tab) => tab.type === "terminal") && (
              <IntegratedTerminalView />
            )}
          </div>

          {activeTab?.type !== "terminal" && (
            activeTab?.type === "newtab" ? (
            <BrowserNewTabTools
              onOpenTool={handleOpenTool}
              onOpenUrl={handleNavigate}
              onOpenAutomation={handleOpenAutomation}
            />
          ) : activeTab?.type === "files" ? (
            <FileExplorerView
              initialFilePath={activeTab.filePath}
              initialLineNumber={activeTab.lineNumber}
              initialLineEnd={activeTab.lineEnd}
              initialViewMode={activeTab.viewMode}
              refreshKey={activeTab.refreshKey}
            />
          ) : activeTab?.type === "changes" ? (
            <GitChangesView
              initialFilePath={activeTab.filePath}
              refreshKey={activeTab.refreshKey}
            />
          ) : activeTab?.type === "automation" ? (
            <BrowserAutomationView />
          ) : activeTab?.type === "btw" ? (
            <BtwPanel sessionId={activeSessionId || ""} />
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
                className={`relative h-full transition-all duration-200 ${
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
                  onLoad={handleFrameLoad}
                />
                {frameLoading && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-white/90 text-slate-500">
                    <Loader2 size={22} className="animate-spin text-sky-500" />
                    <span className="text-[11px] font-mono">正在加载页面…</span>
                  </div>
                )}
                {frameTimedOut && !frameLoading && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 bg-[var(--ui-stage-bg)] px-8 text-center">
                    <Globe size={22} className="text-[var(--ui-text-faint)]" />
                    <span className="text-xs text-[var(--ui-text-secondary)]">
                      页面 8 秒内未完成加载
                    </span>
                    <span className="text-[10.5px] leading-relaxed text-[var(--ui-text-muted)]">
                      目标站点可能禁止被嵌入（X-Frame-Options / frame-ancestors），或本地服务尚未启动。
                    </span>
                    <div className="flex items-center gap-2 mt-1">
                      <button
                        onClick={handleRefresh}
                        className="h-7 px-2.5 rounded-lg bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)] text-[11px] text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)] transition-colors"
                      >
                        重试
                      </button>
                      {activeTab?.url?.startsWith("http") && (
                        <>
                          <button
                            onClick={() => handleOpenInAutomation(activeTab.url!)}
                            className="h-7 px-2.5 rounded-lg bg-[var(--ui-accent-violet-soft)] border border-[color:var(--ui-accent-violet-border)] text-[11px] text-[var(--ui-accent-violet)] hover:brightness-110 transition-all"
                          >
                            用浏览器自动化打开
                          </button>
                          <button
                            onClick={() => window.electronAPI?.openExternalUrl?.(activeTab.url!)}
                            className="h-7 px-2.5 rounded-lg bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)] text-[11px] text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)] transition-colors"
                          >
                            系统浏览器打开
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
      </aside>
    </>
  );
};

export default WebWorkspaceDrawer;
