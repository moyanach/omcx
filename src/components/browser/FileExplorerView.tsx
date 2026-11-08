import React, { useState, useEffect, useRef, useMemo } from "react";
import {
  Folder,
  FolderOpen,
  File,
  ChevronRight,
  ChevronDown,
  RefreshCw,
  FileCode,
  FileText,
  Image as ImageIcon,
  Globe,
  Search,
  AtSign,
  FolderSearch,
  Copy,
  Check,
  Eye,
  Code2,
  ExternalLink,
  PanelLeftClose,
  PanelLeftOpen,
  Layers,
} from "lucide-react";
import { useChatStore } from "@/stores/chatStore";
import MarkdownContent from "@/components/common/MarkdownContent";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark, oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import { getEffectiveTheme, subscribeThemeChange, type EffectiveTheme } from "@/theme";

// 文件扩展名 → Prism 语法语言映射（用于源码视图语法高亮与类型识别）
const EXT_TO_LANGUAGE: Record<string, string> = {
  py: "python",
  pyw: "python",
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  go: "go",
  rs: "rust",
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  ini: "ini",
  sql: "sql",
  html: "markup",
  htm: "markup",
  xml: "xml",
  svg: "markup",
  md: "markdown",
  markdown: "markdown",
  java: "java",
  kt: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  swift: "swift",
  lua: "lua",
  r: "r",
  pl: "perl",
  dockerfile: "docker",
  graphql: "graphql",
  vue: "markup",
  txt: "text",
};

function extToLanguage(ext: string): string {
  return EXT_TO_LANGUAGE[String(ext || "").toLowerCase()] || "text";
}

// 清洗语法高亮主题内层背景与文字阴影，由外层语义背景统一承载（与 CodeBlock 一致）
function stripSyntaxThemeBg(
  themeObj: Record<string, React.CSSProperties>
): Record<string, React.CSSProperties> {
  return Object.fromEntries(
    Object.entries(themeObj).map(([key, val]) => [
      key,
      {
        ...(val as React.CSSProperties),
        background: "transparent",
        backgroundColor: "transparent",
        textShadow: "none",
      },
    ])
  );
}

const cleanOneDark = stripSyntaxThemeBg(oneDark as Record<string, React.CSSProperties>);
const cleanOneLight = stripSyntaxThemeBg(oneLight as Record<string, React.CSSProperties>);

function useEffectiveTheme(): EffectiveTheme {
  const [theme, setTheme] = useState<EffectiveTheme>(() => getEffectiveTheme());
  useEffect(() => {
    setTheme(getEffectiveTheme());
    return subscribeThemeChange(setTheme);
  }, []);
  return theme;
}

interface DirEntry {
  name: string;
  path: string;
  absPath: string;
  isDir: boolean;
  isDirectory?: boolean;
  size: number;
  ext: string;
}

interface WorkspaceRootItem {
  name: string;
  path: string;
  isPrimary?: boolean;
}

interface FileExplorerViewProps {
  initialFilePath?: string;
  initialLineNumber?: number;
  initialViewMode?: "preview" | "code";
  refreshKey?: number;
}

const PREVIEWABLE_EXTS = new Set([
  "html",
  "htm",
  "md",
  "markdown",
  "svg",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "ico",
]);

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "ico", "svg"]);

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getEntryIcon(name: string, isDir: boolean, isExpanded?: boolean) {
  if (isDir) {
    return isExpanded ? (
      <FolderOpen size={14} className="text-[var(--ui-accent-amber)] flex-shrink-0" />
    ) : (
      <Folder size={14} className="text-[var(--ui-accent-amber)] flex-shrink-0" />
    );
  }
  const ext = name.includes(".") ? name.split(".").pop()?.toLowerCase() || "" : "";
  if (ext === "html" || ext === "htm") {
    return <Globe size={13.5} className="text-[var(--ui-accent-sky)] flex-shrink-0" />;
  }
  if (IMAGE_EXTS.has(ext)) {
    return <ImageIcon size={13.5} className="text-[var(--ui-accent-purple)] flex-shrink-0" />;
  }
  if (ext === "md" || ext === "markdown" || ext === "txt") {
    return <FileText size={13.5} className="text-[var(--ui-accent-blue)] flex-shrink-0" />;
  }
  if (
    [
      "ts",
      "tsx",
      "js",
      "jsx",
      "json",
      "py",
      "go",
      "rs",
      "css",
      "scss",
      "sh",
      "yml",
      "yaml",
      "toml",
      "sql",
    ].includes(ext)
  ) {
    return <FileCode size={13.5} className="text-[var(--ui-accent-emerald)] flex-shrink-0" />;
  }
  return <File size={13.5} className="text-[var(--ui-text-faint)] flex-shrink-0" />;
}

export const FileExplorerView: React.FC<FileExplorerViewProps> = ({
  initialFilePath,
  initialLineNumber,
  initialViewMode,
  refreshKey,
}) => {
  const {
    sessions,
    activeSessionId,
    workspaces,
    setPendingMentionInsert,
    openUrlInWorkbench,
  } = useChatStore();

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const primaryWorkDir = activeSession?.workDir || "";
  const effectiveTheme = useEffectiveTheme();

  // 解析当前工作空间挂载的所有 Root 根目录（兼容对象数组与主进程返回）
  const storeRoots = useMemo<WorkspaceRootItem[]>(() => {
    if (!primaryWorkDir) return [];
    const normPrimary = primaryWorkDir.replace(/\/+$/, "");
    const matchedWs = workspaces.find((ws) =>
      ws.folders?.some((f) => (f.path || "").replace(/\/+$/, "") === normPrimary)
    );
    if (matchedWs && Array.isArray(matchedWs.folders) && matchedWs.folders.length > 0) {
      return matchedWs.folders.map((f, idx) => ({
        name: f.name || f.path.split(/[\\/]/).pop() || f.path,
        path: f.path.replace(/\/+$/, ""),
        isPrimary: Boolean(f.isPrimary || idx === 0),
      }));
    }
    return [
      {
        name: normPrimary.split(/[\\/]/).pop() || normPrimary,
        path: normPrimary,
        isPrimary: true,
      },
    ];
  }, [primaryWorkDir, workspaces]);

  const [serverRoots, setServerRoots] = useState<WorkspaceRootItem[]>([]);
  const workspaceRoots = useMemo<WorkspaceRootItem[]>(() => {
    return serverRoots.length > 0 ? serverRoots : storeRoots;
  }, [serverRoots, storeRoots]);

  // 以目录绝对路径 absPath 作为 key 存储各目录的子项
  const [dirEntriesMap, setDirEntriesMap] = useState<Record<string, DirEntry[]>>({});
  const [expandedDirs, setExpandedDirs] = useState<Record<string, boolean>>({});
  const [loadingTree, setLoadingTree] = useState(false);

  // 全局搜索过滤
  const [searchQuery, setSearchQuery] = useState("");
  const [allIndexedFiles, setAllIndexedFiles] = useState<
    Array<{ path: string; isDir: boolean }>
  >([]);

  // 当前选中的文件与内容状态
  const [selectedFile, setSelectedFile] = useState<{
    displayPath: string;
    absPath: string;
    name: string;
    ext: string;
    size: number;
    content: string;
    isBinary: boolean;
    truncated?: boolean;
  } | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [viewMode, setViewMode] = useState<"preview" | "code">("code");
  const [highlightLine, setHighlightLine] = useState<number | undefined>(initialLineNumber);
  const [copied, setCopied] = useState(false);
  const [treeCollapsed, setTreeCollapsed] = useState(false);

  const codeContainerRef = useRef<HTMLDivElement>(null);

  // 加载指定绝对目录的子项
  const loadDirectory = async (absDir: string) => {
    if (!primaryWorkDir || !absDir || !window.electronAPI?.listWorkspaceDir) return;
    try {
      const res = await window.electronAPI.listWorkspaceDir(primaryWorkDir, absDir);
      if (res?.success) {
        if (Array.isArray(res.roots) && res.roots.length > 0) {
          setServerRoots(
            res.roots.map((r: any) => ({
              name: r.name || r.path.split(/[\\/]/).pop() || r.path,
              path: String(r.path).replace(/\/+$/, ""),
              isPrimary: Boolean(r.isPrimary),
            }))
          );
        }
        if (Array.isArray(res.entries)) {
          const normalized: DirEntry[] = res.entries.map((item: any) => ({
            name: item.name,
            path: item.path,
            absPath: String(item.absPath || "").replace(/\/+$/, ""),
            isDir: Boolean(item.isDir ?? item.isDirectory),
            size: item.size || 0,
            ext: item.ext || "",
          }));
          setDirEntriesMap((prev) => ({
            ...prev,
            [absDir.replace(/\/+$/, "")]: normalized,
          }));
        }
      }
    } catch (err) {
      console.error("加载目录失败:", err);
    }
  };

  // 加载全局文件索引用于搜索
  const loadFileIndex = async () => {
    if (!primaryWorkDir || !window.electronAPI?.getWorkspaceFileIndex) return;
    try {
      const res = await window.electronAPI.getWorkspaceFileIndex(primaryWorkDir);
      const list = Array.isArray(res) ? res : Array.isArray(res?.files) ? res.files : [];
      setAllIndexedFiles(
        list.map((item: any) => ({
          path: String(item.path || ""),
          isDir: Boolean(item.isDir ?? item.type === "directory"),
        }))
      );
    } catch {
      // ignore
    }
  };

  // 初始化并展开所有 Root 根目录
  const refreshAllRoots = async () => {
    if (!primaryWorkDir) return;
    setLoadingTree(true);
    try {
      const firstRes = await window.electronAPI?.listWorkspaceDir(
        primaryWorkDir,
        primaryWorkDir
      );
      const rootsToLoad: WorkspaceRootItem[] =
        Array.isArray(firstRes?.roots) && firstRes.roots.length > 0
          ? firstRes.roots.map((r: any) => ({
              name: r.name || r.path.split(/[\\/]/).pop() || r.path,
              path: String(r.path).replace(/\/+$/, ""),
              isPrimary: Boolean(r.isPrimary),
            }))
          : storeRoots;

      if (rootsToLoad.length > 0) {
        setServerRoots(rootsToLoad);
      }

      const initExpanded: Record<string, boolean> = {};
      rootsToLoad.forEach((r) => {
        initExpanded[r.path] = true;
      });
      setExpandedDirs((prev) => ({ ...initExpanded, ...prev }));

      await Promise.all(rootsToLoad.map((r) => loadDirectory(r.path)));
      loadFileIndex();
    } finally {
      setLoadingTree(false);
    }
  };

  useEffect(() => {
    setServerRoots([]);
    setDirEntriesMap({});
    setExpandedDirs({});
    if (primaryWorkDir) {
      refreshAllRoots();
    }
  }, [primaryWorkDir, workspaces]);

  // 将相对路径或带 Root 前缀的路径解析为绝对路径
  const resolveTargetPath = (rawPath: string): string => {
    const clean = String(rawPath || "").trim();
    if (!clean) return "";
    if (clean.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(clean)) {
      return clean.replace(/\/+$/, "");
    }
    // 多 Root 索引可能以 "<rootName>/path/to/file" 格式返回
    if (workspaceRoots.length > 1) {
      const firstSeg = clean.split("/")[0];
      const matchedRoot = workspaceRoots.find((r) => r.name === firstSeg);
      if (matchedRoot) {
        const rest = clean.slice(firstSeg.length + 1);
        return rest ? `${matchedRoot.path}/${rest}` : matchedRoot.path;
      }
    }
    return `${primaryWorkDir.replace(/\/+$/, "")}/${clean.replace(/^\.?\//, "")}`;
  };

  // 计算文件相对于所属 Root 的友好展示路径（用于顶部面包屑与 @ 引用）
  const formatDisplayPath = (absPath: string): string => {
    const norm = absPath.replace(/\/+$/, "");
    for (const root of workspaceRoots) {
      if (norm === root.path) return root.name;
      if (norm.startsWith(`${root.path}/`)) {
        const rel = norm.slice(root.path.length + 1);
        return workspaceRoots.length > 1 ? `${root.name}/${rel}` : rel;
      }
    }
    return norm;
  };

  // 读取并打开某个文件
  const openFile = async (
    targetPath: string,
    opts?: { line?: number; mode?: "preview" | "code" }
  ) => {
    if (!primaryWorkDir || !window.electronAPI?.readWorkspaceFile) return;
    const resolvedTarget = resolveTargetPath(targetPath);
    if (!resolvedTarget) return;

    setLoadingFile(true);
    try {
      const res = await window.electronAPI.readWorkspaceFile(
        primaryWorkDir,
        resolvedTarget
      );
      if (res?.success) {
        const ext = String(res.ext || "").toLowerCase();
        const nextMode =
          opts?.mode || (PREVIEWABLE_EXTS.has(ext) ? "preview" : "code");
        const abs = String(res.absPath || resolvedTarget).replace(/\/+$/, "");
        setSelectedFile({
          displayPath: formatDisplayPath(abs),
          absPath: abs,
          name: res.name || abs.split("/").pop() || abs,
          ext,
          size: res.size || 0,
          content: res.content || "",
          isBinary: Boolean(res.isBinary),
          truncated: Boolean(res.truncated),
        });
        setViewMode(nextMode);
        setHighlightLine(opts?.line);

        // 自动展开该文件所属 Root 及全部父级目录
        const matchedRoot = workspaceRoots.find((r) =>
          abs.startsWith(`${r.path}/`)
        );
        if (matchedRoot) {
          const relInsideRoot = abs.slice(matchedRoot.path.length + 1);
          const segments = relInsideRoot.split("/").filter(Boolean);
          if (segments.length > 1) {
            let cur = matchedRoot.path;
            const parentsToExpand = [matchedRoot.path];
            for (let i = 0; i < segments.length - 1; i++) {
              cur = `${cur}/${segments[i]}`;
              parentsToExpand.push(cur);
            }
            setExpandedDirs((prev) => {
              const next = { ...prev };
              parentsToExpand.forEach((p) => (next[p] = true));
              return next;
            });
            for (const dir of parentsToExpand) {
              if (!dirEntriesMap[dir]) {
                loadDirectory(dir);
              }
            }
          }
        }
      }
    } catch (err) {
      console.error("读取文件失败:", err);
    } finally {
      setLoadingFile(false);
    }
  };

  useEffect(() => {
    if (initialFilePath && primaryWorkDir) {
      openFile(initialFilePath, {
        line: initialLineNumber,
        mode: initialViewMode,
      });
    } else if (selectedFile && refreshKey) {
      openFile(selectedFile.absPath, {
        line: highlightLine,
        mode: viewMode,
      });
    }
  }, [initialFilePath, initialLineNumber, initialViewMode, refreshKey, primaryWorkDir]);

  useEffect(() => {
    if (viewMode === "code" && highlightLine && codeContainerRef.current) {
      const timer = setTimeout(() => {
        const lineEl = codeContainerRef.current?.querySelector(
          `[data-line-number="${highlightLine}"]`
        );
        if (lineEl) {
          lineEl.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }, 60);
      return () => clearTimeout(timer);
    }
  }, [viewMode, highlightLine, selectedFile?.absPath]);

  const toggleDir = (absDirPath: string) => {
    const norm = absDirPath.replace(/\/+$/, "");
    const isNowOpen = !expandedDirs[norm];
    setExpandedDirs((prev) => ({ ...prev, [norm]: isNowOpen }));
    if (isNowOpen && !dirEntriesMap[norm]) {
      loadDirectory(norm);
    }
  };

  const handleCopyContent = () => {
    if (!selectedFile?.content) return;
    navigator.clipboard.writeText(selectedFile.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleInsertMention = (mentionPath: string) => {
    setPendingMentionInsert(`@${mentionPath} `);
  };

  // 搜索过滤列表（仅过滤文件，排除目录）
  const filteredSearchFiles = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    return allIndexedFiles
      .filter((item) => !item.isDir && item.path.toLowerCase().includes(q))
      .slice(0, 60);
  }, [searchQuery, allIndexedFiles]);

  // 递归渲染某个目录绝对路径下的子项
  const renderDirectoryChildren = (parentAbsPath: string, depth: number) => {
    const normParent = parentAbsPath.replace(/\/+$/, "");
    const entries = dirEntriesMap[normParent];

    if (!entries) {
      return (
        <div
          style={{ paddingLeft: `${depth * 14 + 24}px` }}
          className="py-1 text-[11px] text-[var(--ui-text-faint)]"
        >
          加载中...
        </div>
      );
    }

    if (entries.length === 0) {
      return (
        <div
          style={{ paddingLeft: `${depth * 14 + 24}px` }}
          className="py-1 text-[11px] text-[var(--ui-text-faint)] italic"
        >
          (空目录)
        </div>
      );
    }

    return entries.map((entry) => {
      const isDir = Boolean(entry.isDir ?? entry.isDirectory);
      const isExpanded = isDir && Boolean(expandedDirs[entry.absPath]);
      const isSelected = !isDir && selectedFile?.absPath === entry.absPath;

      return (
        <React.Fragment key={entry.absPath}>
          <div
            onClick={() => {
              if (isDir) {
                toggleDir(entry.absPath);
              } else {
                openFile(entry.absPath);
              }
            }}
            style={{ paddingLeft: `${depth * 14 + 10}px` }}
            className={`group flex items-center justify-between py-1.5 pr-2 rounded-lg cursor-pointer text-xs transition-colors ${
              isSelected
                ? "bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)] font-medium"
                : "text-[var(--ui-text-secondary)] hover:bg-[var(--ui-block-hover-bg)] hover:text-[var(--ui-text-primary)]"
            }`}
          >
            <div className="flex items-center gap-1.5 min-w-0 flex-1">
              {isDir ? (
                <span className="text-[var(--ui-text-faint)] w-3.5 flex items-center justify-center flex-shrink-0">
                  {isExpanded ? <ChevronDown size={12.5} /> : <ChevronRight size={12.5} />}
                </span>
              ) : (
                <span className="w-3.5 flex-shrink-0" />
              )}
              {getEntryIcon(entry.name, isDir, isExpanded)}
              <span
                className={`truncate text-[12px] ${
                  isDir ? "font-medium text-[var(--ui-text-primary)]" : ""
                }`}
              >
                {entry.name}
              </span>
            </div>

            {!isDir ? (
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleInsertMention(formatDisplayPath(entry.absPath));
                  }}
                  className="p-0.5 rounded hover:bg-[var(--ui-chip-hover-bg)] text-[var(--ui-text-muted)] hover:text-[var(--ui-accent-blue)]"
                  title="引用 @文件 到对话框"
                >
                  <AtSign size={11} />
                </button>
              </div>
            ) : (
              <span className="text-[10px] text-[var(--ui-text-faint)] opacity-0 group-hover:opacity-100 transition-opacity pr-0.5">
                目录
              </span>
            )}
          </div>

          {isDir && isExpanded && renderDirectoryChildren(entry.absPath, depth + 1)}
        </React.Fragment>
      );
    });
  };

  if (!primaryWorkDir) {
    return (
      <div className="flex-1 h-full bg-[var(--ui-stage-bg)] flex flex-col items-center justify-center p-8 text-center">
        <Folder size={32} className="text-[var(--ui-text-faint)] mb-3 opacity-60" />
        <div className="text-sm font-medium text-[var(--ui-text-primary)] mb-1">
          尚未绑定工作空间目录
        </div>
        <div className="text-xs text-[var(--ui-text-muted)] max-w-[280px]">
          请先在会话顶部或左侧工作空间面板选择本地工程目录，即可浏览文件树与实时预览代码。
        </div>
      </div>
    );
  }

  const isPreviewable = selectedFile ? PREVIEWABLE_EXTS.has(selectedFile.ext) : false;

  return (
    <div className="flex-1 h-full bg-[var(--ui-stage-bg)] flex flex-col overflow-hidden text-[var(--ui-text-primary)] select-none">
      {/* 顶部工具栏：多 Root 统计提示 + 搜索框 + 刷新 */}
      <div className="h-10 px-3 flex items-center gap-2 border-b border-[color:var(--ui-divider-hairline)] bg-[var(--ui-card-header-bg)] flex-shrink-0">
        {selectedFile && (
          <button
            onClick={() => setTreeCollapsed(!treeCollapsed)}
            className="p-1.5 rounded-lg hover:bg-[var(--ui-block-hover-bg)] text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] transition-colors"
            title={treeCollapsed ? "展开文件树" : "收起文件树"}
          >
            {treeCollapsed ? <PanelLeftOpen size={13.5} /> : <PanelLeftClose size={13.5} />}
          </button>
        )}

        <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)] text-[11px] text-[var(--ui-text-secondary)] flex-shrink-0">
          <Layers size={12} className="text-[var(--ui-accent-blue)]" />
          <span className="font-medium truncate max-w-[120px]">
            {workspaceRoots.length > 1
              ? `${workspaceRoots.length} 个根目录`
              : workspaceRoots[0]?.name || "工作区文件"}
          </span>
        </div>

        {/* 快速搜索框 */}
        <div className="flex-1 h-7 rounded-lg bg-[var(--ui-input-bg)] border border-[color:var(--ui-border-hairline)] flex items-center px-2.5 gap-1.5 focus-within:border-[color:var(--ui-accent-blue-border)] transition-colors">
          <Search size={12} className="text-[var(--ui-text-faint)] flex-shrink-0" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="快速搜索工作区文件 (支持路径/文件名)..."
            className="w-full bg-transparent text-xs text-[var(--ui-text-primary)] placeholder-[var(--ui-text-faint)] outline-none"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="text-[10px] text-[var(--ui-text-faint)] hover:text-[var(--ui-text-primary)] flex-shrink-0"
            >
              清除
            </button>
          )}
        </div>

        <button
          onClick={() => {
            refreshAllRoots();
            if (selectedFile) {
              openFile(selectedFile.absPath, { line: highlightLine, mode: viewMode });
            }
          }}
          className="p-1.5 rounded-lg hover:bg-[var(--ui-block-hover-bg)] text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] transition-colors"
          title="刷新全部工作区目录"
        >
          <RefreshCw size={12.5} className={loadingTree ? "animate-spin" : ""} />
        </button>
      </div>

      {/* 主体分栏：左侧多 Root 文件树 + 右侧文件内容/预览 */}
      <div className="flex-1 flex overflow-hidden">
        {(!selectedFile || !treeCollapsed) && (
          <div
            className={`${
              selectedFile
                ? "w-[225px] border-r border-[color:var(--ui-divider-hairline)]"
                : "flex-1"
            } h-full overflow-y-auto p-2 flex flex-col gap-0.5 custom-scrollbar bg-[var(--ui-panel-bg)] flex-shrink-0`}
          >
            {searchQuery.trim() ? (
              filteredSearchFiles.length === 0 ? (
                <div className="py-8 text-center text-xs text-[var(--ui-text-faint)]">
                  未找到匹配 "{searchQuery}" 的文件
                </div>
              ) : (
                filteredSearchFiles.map((item) => {
                  const fileName = item.path.split("/").pop() || item.path;
                  const resolved = resolveTargetPath(item.path);
                  const isSelected = selectedFile?.absPath === resolved;
                  return (
                    <div
                      key={item.path}
                      onClick={() => openFile(item.path)}
                      className={`flex flex-col py-1.5 px-2.5 rounded-lg cursor-pointer transition-colors ${
                        isSelected
                          ? "bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)]"
                          : "hover:bg-[var(--ui-block-hover-bg)] text-[var(--ui-text-primary)]"
                      }`}
                    >
                      <div className="flex items-center gap-1.5 text-xs font-medium truncate">
                        {getEntryIcon(fileName, false)}
                        <span className="truncate">{fileName}</span>
                      </div>
                      <span className="text-[10px] text-[var(--ui-text-faint)] truncate pl-5">
                        {item.path}
                      </span>
                    </div>
                  );
                })
              )
            ) : (
              /* 并列展示工作空间下的所有 Root 根目录 */
              workspaceRoots.map((root) => {
                const isRootExpanded = Boolean(expandedDirs[root.path]);
                return (
                  <div key={root.path} className="mb-1">
                    {/* Root 顶层目录头 */}
                    <div
                      onClick={() => toggleDir(root.path)}
                      className="flex items-center justify-between px-2 py-1.5 rounded-lg bg-[var(--ui-card-bg)] hover:bg-[var(--ui-block-hover-bg)] border border-[color:var(--ui-border-hairline)] cursor-pointer transition-colors mb-0.5"
                      title={root.path}
                    >
                      <div className="flex items-center gap-1.5 min-w-0 flex-1">
                        <span className="text-[var(--ui-text-muted)] flex-shrink-0">
                          {isRootExpanded ? (
                            <ChevronDown size={13} />
                          ) : (
                            <ChevronRight size={13} />
                          )}
                        </span>
                        {isRootExpanded ? (
                          <FolderOpen
                            size={14}
                            className="text-[var(--ui-accent-amber)] flex-shrink-0"
                          />
                        ) : (
                          <Folder
                            size={14}
                            className="text-[var(--ui-accent-amber)] flex-shrink-0"
                          />
                        )}
                        <span className="text-xs font-semibold text-[var(--ui-text-primary)] truncate">
                          {root.name}
                        </span>
                      </div>

                      {workspaceRoots.length > 1 && (
                        <span
                          className={`px-1.5 py-0.2 rounded text-[9px] font-medium flex-shrink-0 ${
                            root.isPrimary
                              ? "bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)]"
                              : "bg-[var(--ui-chip-bg)] text-[var(--ui-text-faint)]"
                          }`}
                        >
                          {root.isPrimary ? "主目录" : "挂载"}
                        </span>
                      )}
                    </div>

                    {/* 该 Root 下的多级子目录与文件 */}
                    {isRootExpanded && renderDirectoryChildren(root.path, 0)}
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* 右侧文件内容查看器与实时预览器 */}
        {selectedFile && (
          <div className="flex-1 h-full flex flex-col overflow-hidden bg-[var(--ui-stage-bg)] select-text">
            {/* 文件操作头部 */}
            <div className="h-9 px-3 flex items-center justify-between gap-2 border-b border-[color:var(--ui-divider-hairline)] bg-[var(--ui-card-header-bg)] flex-shrink-0 select-none">
              <div className="flex items-center gap-1.5 min-w-0 flex-1">
                {getEntryIcon(selectedFile.name, false)}
                <span
                  className="text-xs font-medium text-[var(--ui-text-primary)] truncate"
                  title={selectedFile.absPath}
                >
                  {selectedFile.displayPath}
                </span>
                <span className="text-[10px] text-[var(--ui-text-faint)] flex-shrink-0">
                  ({formatBytes(selectedFile.size)})
                </span>
                {!selectedFile.isBinary && extToLanguage(selectedFile.ext) !== "text" && (
                  <span className="px-1.5 py-0.2 rounded text-[9px] font-mono font-semibold uppercase tracking-wide bg-[var(--ui-accent-emerald-soft)] text-[var(--ui-accent-emerald)] border border-[color:var(--ui-accent-emerald-border)] flex-shrink-0">
                    {extToLanguage(selectedFile.ext)}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-1 flex-shrink-0">
                {isPreviewable && (
                  <div className="flex items-center rounded-lg bg-[var(--ui-chip-bg)] p-0.5 border border-[color:var(--ui-border-hairline)] mr-1">
                    <button
                      onClick={() => setViewMode("preview")}
                      className={`px-2 py-0.5 rounded-md text-[11px] flex items-center gap-1 transition-colors ${
                        viewMode === "preview"
                          ? "bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)] font-medium"
                          : "text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)]"
                      }`}
                    >
                      <Eye size={11} />
                      <span>预览</span>
                    </button>
                    <button
                      onClick={() => setViewMode("code")}
                      className={`px-2 py-0.5 rounded-md text-[11px] flex items-center gap-1 transition-colors ${
                        viewMode === "code"
                          ? "bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)] font-medium"
                          : "text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)]"
                      }`}
                    >
                      <Code2 size={11} />
                      <span>源码</span>
                    </button>
                  </div>
                )}

                {(selectedFile.ext === "html" || selectedFile.ext === "htm") && (
                  <button
                    onClick={() => {
                      const localUrl = `local-media://local${encodeURI(selectedFile.absPath)}`;
                      openUrlInWorkbench(localUrl, selectedFile.name, selectedFile.absPath);
                    }}
                    className="px-1.5 py-1 rounded-lg hover:bg-[var(--ui-block-hover-bg)] text-[var(--ui-text-muted)] hover:text-[var(--ui-accent-sky)] text-[11px] flex items-center gap-1 transition-colors"
                    title="在独立浏览器标签页打开"
                  >
                    <ExternalLink size={12} />
                  </button>
                )}

                <button
                  onClick={() => handleInsertMention(selectedFile.displayPath)}
                  className="px-2 py-1 rounded-lg hover:bg-[var(--ui-block-hover-bg)] text-[var(--ui-text-muted)] hover:text-[var(--ui-accent-blue)] text-[11px] flex items-center gap-1 transition-colors"
                  title="将 @文件路径 插入到聊天输入框"
                >
                  <AtSign size={12} />
                  <span>引用</span>
                </button>

                {!selectedFile.isBinary && (
                  <button
                    onClick={handleCopyContent}
                    className="p-1.5 rounded-lg hover:bg-[var(--ui-block-hover-bg)] text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] transition-colors"
                    title="复制文件内容"
                  >
                    {copied ? (
                      <Check size={12} className="text-[var(--ui-accent-emerald)]" />
                    ) : (
                      <Copy size={12} />
                    )}
                  </button>
                )}

                <button
                  onClick={() => window.electronAPI?.showInFolder(selectedFile.absPath)}
                  className="p-1.5 rounded-lg hover:bg-[var(--ui-block-hover-bg)] text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] transition-colors"
                  title="在 Finder 中显示"
                >
                  <FolderSearch size={12} />
                </button>
              </div>
            </div>

            {/* 内容主体 */}
            <div
              ref={codeContainerRef}
              className="flex-1 overflow-auto custom-scrollbar relative bg-[var(--ui-code-bg)]"
            >
              {loadingFile ? (
                <div className="p-8 text-center text-xs text-[var(--ui-text-faint)]">
                  正在读取文件...
                </div>
              ) : viewMode === "preview" &&
                (selectedFile.ext === "html" || selectedFile.ext === "htm") ? (
                <iframe
                  key={`${selectedFile.absPath}_${refreshKey || 0}`}
                  src={`local-media://local${encodeURI(selectedFile.absPath)}`}
                  className="w-full h-full border-0 bg-white"
                  title={selectedFile.name}
                  sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                />
              ) : viewMode === "preview" &&
                (selectedFile.ext === "md" || selectedFile.ext === "markdown") ? (
                <div className="p-5 max-w-none bg-[var(--ui-stage-bg)] min-h-full">
                  <MarkdownContent content={selectedFile.content} />
                </div>
              ) : viewMode === "preview" && IMAGE_EXTS.has(selectedFile.ext) ? (
                <div className="w-full h-full flex items-center justify-center p-6 bg-[var(--ui-stage-bg)]">
                  <img
                    src={`local-media://local${encodeURI(selectedFile.absPath)}`}
                    alt={selectedFile.name}
                    className="max-w-full max-h-full object-contain rounded-xl border border-[color:var(--ui-border-hairline)] shadow-sm"
                  />
                </div>
              ) : selectedFile.isBinary ? (
                <div className="p-8 text-center text-xs text-[var(--ui-text-faint)]">
                  二进制文件不支持直接查看文本源码，可点击右上角在 Finder 中打开。
                </div>
              ) : (
                <div className="font-mono text-[12px] leading-[1.6]">
                  <SyntaxHighlighter
                    language={extToLanguage(selectedFile.ext)}
                    style={effectiveTheme === "light" ? cleanOneLight : cleanOneDark}
                    showLineNumbers
                    wrapLines
                    wrapLongLines
                    codeTagProps={{
                      style: {
                        background: "transparent",
                        backgroundColor: "transparent",
                        padding: 0,
                        border: "none",
                        fontFamily: "inherit",
                      },
                    }}
                    lineProps={(lineNumber: number) => ({
                      "data-line-number": lineNumber,
                      onClick: () => setHighlightLine(lineNumber),
                      style: {
                        display: "block",
                        cursor: "pointer",
                        background:
                          highlightLine === lineNumber
                            ? "var(--ui-accent-amber-soft)"
                            : "transparent",
                        backgroundColor:
                          highlightLine === lineNumber
                            ? "var(--ui-accent-amber-soft)"
                            : "transparent",
                        borderLeft:
                          highlightLine === lineNumber
                            ? "2px solid var(--ui-accent-amber)"
                            : "2px solid transparent",
                      },
                    })}
                    customStyle={{
                      margin: 0,
                      padding: "0.5rem 0",
                      background: "transparent",
                      backgroundColor: "transparent",
                      fontSize: "12px",
                      lineHeight: "1.6",
                    }}
                    lineNumberStyle={{
                      minWidth: "2.75em",
                      paddingRight: "1em",
                      color: effectiveTheme === "light" ? "#94a3b8" : "#525252",
                      userSelect: "none",
                    }}
                  >
                    {selectedFile.content}
                  </SyntaxHighlighter>
                  {selectedFile.truncated && (
                    <div className="px-4 py-2 text-[11px] text-[var(--ui-accent-amber)] border-t border-[color:var(--ui-divider-hairline)]">
                      文件较大，此处仅展示前 250 KB 内容。
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default FileExplorerView;
