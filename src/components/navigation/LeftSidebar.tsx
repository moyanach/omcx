import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Plus,
  FolderGit2,
  Wrench,
  Search,
  SlidersHorizontal,
  ChevronDown,
  ChevronRight,
  MessageSquare,
  Pencil,
  Trash2,
  Settings,
  Check,
  Loader2,
  BarChart3,
} from "lucide-react";
import { useChatStore, type Session } from "@/stores/chatStore";
import { useAppStore } from "@/stores/appStore";
import { usePanelResize } from "@/hooks/usePanelResize";
import { formatRelativeTime } from "@/lib/relativeTime";

interface ProjectGroup {
  key: string;
  workspaceId: string | null;
  name: string;
  sessions: Session[];
  canCreate: boolean;
}

const byUpdated = (a: Session, b: Session) => (b.updatedAt || 0) - (a.updatedAt || 0);

const LeftSidebar: React.FC = () => {
  const {
    sessions,
    activeSessionId,
    activeWorkspaceId,
    generatingBySession,
    workspaces,
    setActiveSession,
    addSession,
    addSessionInWorkspace,
    deleteSession,
    updateSessionTitle,
  } = useChatStore();
  const {
    activeNavTab,
    setActiveNavTab,
    settingsOpen,
    openSettings,
    leftSidebarWidth,
    setLeftSidebarWidth,
  } = useAppStore();

  // 侧边栏右侧边缘拖拽调宽：rAF 直写 DOM，松手提交一次
  const {
    targetRef: sidebarRef,
    onPointerDown: startSidebarResize,
    widthRef: sidebarWidthRef,
    isResizingRef: sidebarResizingRef,
    isDragging: sidebarResizing,
  } = usePanelResize({
    edge: "right",
    min: 220,
    max:
      typeof window !== "undefined"
        ? Math.min(520, Math.floor(window.innerWidth * 0.4))
        : 520,
    getWidth: () => leftSidebarWidth,
    onCommit: (width) => setLeftSidebarWidth(width),
  });

  const liveSidebarWidth =
    sidebarResizingRef.current && sidebarWidthRef.current != null
      ? sidebarWidthRef.current
      : null;

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [filter, setFilter] = useState<"active" | "archived">("active");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [username, setUsername] = useState("本地用户");

  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    window.electronAPI
      ?.getUserInfo?.()
      .then((info: any) => setUsername(info?.username || "本地用户"))
      .catch(() => setUsername("本地用户"));
  }, []);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  useEffect(() => {
    if (editingSessionId) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [editingSessionId]);

  useEffect(() => {
    if (!filterOpen) return;
    const close = () => setFilterOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [filterOpen]);

  const normalizedQuery = searchQuery.trim().toLowerCase();

  const matchesQuery = (session: Session) =>
    !normalizedQuery || (session.title || "").toLowerCase().includes(normalizedQuery);

  const visibleSessions = useMemo(
    () =>
      sessions
        .filter((session) => (filter === "archived" ? !!session.archived : !session.archived))
        .filter(matchesQuery),
    [sessions, filter, normalizedQuery]
  );

  const { workspaceGroups, standaloneGroups, unassigned } = useMemo(() => {
    const assignedSessionIds = new Set<string>();

    const groups: ProjectGroup[] = workspaces.map((workspace) => {
      const groupSessions = visibleSessions
        .filter((session) => {
          if (session.workspaceId) {
            return session.workspaceId === workspace.id;
          }
          // 向后兼容历史未保存 workspaceId 但目录属于该空间的数据
          return (
            session.workDir &&
            workspace.folders.some((folder) => folder.path === session.workDir)
          );
        })
        .sort(byUpdated);

      groupSessions.forEach((s) => assignedSessionIds.add(s.id));

      return {
        key: `ws:${workspace.id}`,
        workspaceId: workspace.id,
        name: workspace.name,
        sessions: groupSessions,
        canCreate: workspace.folders.length > 0,
      };
    });

    const filteredGroups = groups.filter((group) => {
      if (!normalizedQuery) return true;
      return group.sessions.length > 0 || group.name.toLowerCase().includes(normalizedQuery);
    });

    const remainingSessions = visibleSessions.filter((s) => !assignedSessionIds.has(s.id));

    const pseudoMap = new Map<string, Session[]>();
    remainingSessions.forEach((session) => {
      if (!session.workDir) return;
      const list = pseudoMap.get(session.workDir) || [];
      list.push(session);
      pseudoMap.set(session.workDir, list);
    });

    const pseudoGroups: ProjectGroup[] = Array.from(pseudoMap.entries())
      .map(([workDir, list]) => ({
        key: `dir:${workDir}`,
        workspaceId: null,
        name: workDir.split(/[\\/]/).filter(Boolean).pop() || workDir,
        sessions: list.sort(byUpdated),
        canCreate: false,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const unassignedSessions = remainingSessions
      .filter((session) => !session.workDir)
      .sort(byUpdated);

    return {
      workspaceGroups: filteredGroups,
      standaloneGroups: pseudoGroups,
      unassigned: unassignedSessions,
    };
  }, [workspaces, visibleSessions, normalizedQuery]);

  const toggleGroup = (key: string) => {
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleNewTask = async () => {
    const activeSession = sessions.find((session) => session.id === activeSessionId);
    await addSession({
      workspaceId: activeWorkspaceId || activeSession?.workspaceId,
      workDir: activeSession?.workDir,
      model: activeSession?.model,
    });
    setActiveNavTab("sessions");
  };

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        handleNewTask();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [sessions, activeSessionId]);

  const handleSelectSession = async (id: string) => {
    setActiveNavTab("sessions");
    await setActiveSession(id);
  };

  const handleNewInWorkspace = async (workspaceId: string) => {
    const createdId = await addSessionInWorkspace(workspaceId);
    if (createdId) setActiveNavTab("sessions");
  };

  const startRename = (session: Session) => {
    setEditingSessionId(session.id);
    setEditingTitle(session.title || "");
  };

  const finishRename = (sessionId: string) => {
    const nextTitle = editingTitle.trim();
    setEditingSessionId(null);
    setEditingTitle("");
    if (nextTitle) updateSessionTitle(sessionId, nextTitle);
  };

  const renderSession = (session: Session) => {
    const isActive = session.id === activeSessionId;
    const isEditing = session.id === editingSessionId;
    const isRunning = Boolean(generatingBySession[session.id]);

    return (
      <div
        key={session.id}
        onClick={() => !isEditing && handleSelectSession(session.id)}
        className={`group/session mx-1.5 flex items-center gap-2 pl-7 pr-2 py-1.5 rounded-lg cursor-pointer transition-colors ${
          isActive
            ? "bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)]"
            : "text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-chip-bg)]"
        }`}
      >
        {isRunning ? (
          <Loader2
            size={12}
            className="flex-shrink-0 text-[var(--ui-accent-blue)] animate-spin"
          />
        ) : (
          <MessageSquare
            size={12}
            className={`flex-shrink-0 ${isActive ? "text-[var(--ui-accent-blue)]" : "text-[var(--ui-text-faint)]"}`}
          />
        )}

        {isEditing ? (
          <input
            ref={renameInputRef}
            value={editingTitle}
            onChange={(e) => setEditingTitle(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                finishRename(session.id);
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setEditingSessionId(null);
                setEditingTitle("");
              }
            }}
            onBlur={() => finishRename(session.id)}
            className="flex-1 min-w-0 h-5 px-1 text-[11px] rounded bg-[var(--ui-card-inner-bg)] text-[var(--ui-text-primary)] border border-blue-500 outline-none"
          />
        ) : (
          <>
            <span className="flex-1 min-w-0 text-[11px] truncate tracking-tight">
              {session.title || "新的 Agent 会话"}
            </span>
            <span className="text-[10px] text-[var(--ui-text-faint)] flex-shrink-0 group-hover/session:hidden">
              {formatRelativeTime(session.updatedAt)}
            </span>
            <div className="hidden group-hover/session:flex items-center gap-0.5 flex-shrink-0">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  startRename(session);
                }}
                className="p-0.5 rounded text-[var(--ui-text-faint)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-chip-hover-bg)]"
                title="重命名"
              >
                <Pencil size={10} />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  deleteSession(session.id);
                }}
                className="p-0.5 rounded text-[var(--ui-text-faint)] hover:text-[var(--ui-accent-rose)] hover:bg-[var(--ui-accent-rose-soft)]"
                title="删除会话"
              >
                <Trash2 size={10} />
              </button>
            </div>
          </>
        )}
      </div>
    );
  };

  const renderGroup = (group: ProjectGroup) => {
    const isExpanded = !collapsed[group.key];
    const isCurrentActive = Boolean(group.workspaceId && group.workspaceId === activeWorkspaceId);

    return (
      <div key={group.key} className="mb-0.5">
        <div
          onClick={() => toggleGroup(group.key)}
          className={`group/ws mx-1.5 flex items-center gap-1.5 pl-1.5 pr-1 py-1.5 rounded-lg cursor-pointer transition-colors ${
            isCurrentActive
              ? "text-[var(--ui-text-primary)] bg-[var(--ui-accent-blue-soft)]/40 font-medium"
              : "text-[var(--ui-text-secondary)] hover:bg-[var(--ui-chip-bg)]"
          }`}
        >
          {isExpanded ? (
            <ChevronDown size={12} className="text-[var(--ui-text-faint)] flex-shrink-0" />
          ) : (
            <ChevronRight size={12} className="text-[var(--ui-text-faint)] flex-shrink-0" />
          )}
          <FolderGit2 size={14} className={isCurrentActive ? "text-blue-400 flex-shrink-0" : "text-[var(--ui-accent-blue)] flex-shrink-0"} />
          <span className="flex-1 min-w-0 text-xs truncate">{group.name}</span>
          {isCurrentActive && (
            <span className="w-1.5 h-1.5 rounded-full bg-blue-400 flex-shrink-0" title="当前活跃工作空间" />
          )}
          {group.workspaceId && group.canCreate && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleNewInWorkspace(group.workspaceId as string);
              }}
              className="w-5 h-5 flex items-center justify-center rounded-md text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-chip-hover-bg)] transition-colors"
              title="在此工作空间新建会话"
            >
              <Plus size={13} />
            </button>
          )}
        </div>

        {isExpanded && group.sessions.map(renderSession)}
        {isExpanded && group.sessions.length === 0 && (
          <div className="pl-9 pr-3 py-1 text-[10px] text-[var(--ui-text-faint)]">暂无会话</div>
        )}
      </div>
    );
  };

  const navClass = (tab: "workspaces" | "tools" | "insights") =>
    `w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg transition-colors ${
      activeNavTab === tab
        ? "bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)]"
        : "text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-chip-bg)]"
    }`;

  const initial = (username || "本").trim().charAt(0).toUpperCase();

  return (
    <aside
      ref={sidebarRef as React.RefObject<HTMLElement>}
      style={{
        width: liveSidebarWidth != null ? `${liveSidebarWidth}px` : leftSidebarWidth,
        maxWidth: "40vw",
      }}
      className="relative h-full bg-[var(--ui-panel-bg)] border-r border-[color:var(--ui-divider-hairline)] flex flex-col flex-shrink-0 select-none"
    >
      {/* 顶部留出 macOS 原生红绿灯安全间距与窗口拖拽区 */}
      <div className="h-9 w-full titlebar-drag flex-shrink-0" />

      <div className="p-2.5 pb-2 space-y-0.5 border-b border-[color:var(--ui-divider-hairline)] titlebar-no-drag">
        <button
          onClick={handleNewTask}
          className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-[var(--ui-text-primary)] hover:bg-[var(--ui-chip-bg)] transition-colors"
        >
          <Plus size={15} className="text-[var(--ui-text-muted)]" />
          <span className="flex-1 text-left text-xs font-medium">新建任务</span>
          <span className="text-[10px] text-[var(--ui-text-faint)] font-mono">⌘N</span>
        </button>

        <button onClick={() => setActiveNavTab("workspaces")} className={navClass("workspaces")}>
          <FolderGit2 size={15} />
          <span className="text-xs font-medium">工作空间</span>
        </button>

        <button onClick={() => setActiveNavTab("tools")} className={navClass("tools")}>
          <Wrench size={15} />
          <span className="text-xs font-medium">工具与技能</span>
        </button>

        <button onClick={() => setActiveNavTab("insights")} className={navClass("insights")}>
          <BarChart3 size={15} />
          <span className="text-xs font-medium">用量与评测</span>
        </button>
      </div>

      <div className="px-3 pt-3 pb-1 flex items-center justify-between">
        <span className="text-[11px] font-semibold text-[var(--ui-text-muted)] tracking-wide">
          任务列表
        </span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => setSearchOpen((open) => !open)}
            className={`w-6 h-6 flex items-center justify-center rounded-md transition-colors ${
              searchOpen ? "text-[var(--ui-accent-blue)] bg-[var(--ui-accent-blue-soft)]" : "text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-chip-bg)]"
            }`}
            title="搜索任务"
          >
            <Search size={13} />
          </button>
          <div className="relative">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setFilterOpen((open) => !open);
              }}
              className={`w-6 h-6 flex items-center justify-center rounded-md transition-colors ${
                filterOpen ? "text-[var(--ui-accent-blue)] bg-[var(--ui-accent-blue-soft)]" : "text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-chip-bg)]"
              }`}
              title="筛选任务"
            >
              <SlidersHorizontal size={13} />
            </button>
            {filterOpen && (
              <div className="absolute right-0 top-7 z-50 w-28 py-1 rounded-lg bg-[var(--ui-popover-bg)] border border-[color:var(--ui-border-subtle)] shadow-[var(--ui-popover-shadow)]">
                {[
                  { value: "active" as const, label: "活动任务" },
                  { value: "archived" as const, label: "已归档" },
                ].map((option) => (
                  <button
                    key={option.value}
                    onClick={() => {
                      setFilter(option.value);
                      setFilterOpen(false);
                    }}
                    className="w-full flex items-center justify-between px-2.5 py-1.5 text-[11px] text-[var(--ui-text-secondary)] hover:bg-[var(--ui-block-hover-bg)]"
                  >
                    <span>{option.label}</span>
                    {filter === option.value && <Check size={11} className="text-[var(--ui-accent-blue)]" />}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {searchOpen && (
        <div className="px-3 pb-2">
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setSearchQuery("");
                setSearchOpen(false);
              }
            }}
            placeholder="搜索任务标题..."
            className="w-full h-7 px-2 text-[11px] rounded-lg bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-subtle)] text-[var(--ui-text-primary)] placeholder-[var(--ui-text-faint)] outline-none focus:border-blue-500/60"
          />
        </div>
      )}

      <div className="flex-1 overflow-y-auto pb-3 custom-scrollbar">
        <div className="px-3 pt-2 pb-1 text-[10px] font-semibold text-[var(--ui-text-faint)] tracking-wide uppercase">
          项目
        </div>
        {workspaceGroups.length === 0 && standaloneGroups.length === 0 ? (
          <div className="px-3 py-2 text-[11px] text-[var(--ui-text-faint)]">
            {normalizedQuery ? "未找到匹配项目" : "暂无项目"}
          </div>
        ) : (
          <>
            {workspaceGroups.map(renderGroup)}
            {standaloneGroups.map(renderGroup)}
          </>
        )}

        <div className="px-3 pt-4 pb-1 text-[10px] font-semibold text-[var(--ui-text-faint)] tracking-wide uppercase">
          任务
        </div>
        {unassigned.length === 0 ? (
          <div className="px-3 py-1.5 text-[11px] text-[var(--ui-text-faint)]">
            {normalizedQuery ? "未找到匹配任务" : "暂无任务"}
          </div>
        ) : (
          unassigned.map(renderSession)
        )}
      </div>

      <div className="border-t border-[color:var(--ui-divider-hairline)] p-3 flex items-center gap-2.5 flex-shrink-0">
        <div className="w-7 h-7 rounded-full bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)] flex items-center justify-center text-[11px] font-bold flex-shrink-0">
          {initial}
        </div>
        <span className="flex-1 min-w-0 text-xs text-[var(--ui-text-secondary)] truncate">{username}</span>
        <button
          onClick={() => openSettings()}
          className={`w-6 h-6 flex items-center justify-center rounded-md transition-colors ${
            settingsOpen
              ? "text-[var(--ui-accent-blue)] bg-[var(--ui-accent-blue-soft)]"
              : "text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-chip-bg)]"
          }`}
          title="设置"
        >
          <Settings size={15} />
        </button>
      </div>

      {/* 右侧拖拽调宽手柄（双击恢复默认 280px） */}
      <div
        onPointerDown={startSidebarResize}
        onDoubleClick={() => setLeftSidebarWidth(280)}
        className={`absolute right-0 top-0 bottom-0 w-2.5 translate-x-1/2 cursor-col-resize z-40 titlebar-no-drag transition-colors ${
          sidebarResizing
            ? "bg-[var(--ui-accent-blue)]/60"
            : "hover:bg-[var(--ui-accent-blue-soft)]"
        }`}
        title="拖拽调整侧边栏宽度（双击恢复默认）"
      />
    </aside>
  );
};

export default LeftSidebar;
