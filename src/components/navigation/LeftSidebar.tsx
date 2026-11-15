import React, { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
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
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { useChatStore, type Session } from "@/stores/chatStore";
import { useAppStore } from "@/stores/appStore";
import { usePanelResize } from "@/hooks/usePanelResize";
import { formatRelativeTime } from "@/lib/relativeTime";
import { useDeleteSessionWithWorktree } from "./DeleteSessionModal";
import { useNewSessionModal } from "./NewSessionModal";

interface ProjectGroup {
  key: string;
  workspaceId: string | null;
  name: string;
  sessions: Session[];
  canCreate: boolean;
}

const byUpdated = (a: Session, b: Session) => (b.updatedAt || 0) - (a.updatedAt || 0);
const WORKSPACE_DRAG_MIME = "application/x-omcx-workspace-id";

const LeftSidebar: React.FC = () => {
  const {
    sessions,
    activeSessionId,
    activeWorkspaceId,
    generatingBySession,
    workspaces,
    setActiveSession,
    updateSessionTitle,
    reorderWorkspaces,
  } = useChatStore(
    useShallow((s) => ({
      sessions: s.sessions,
      activeSessionId: s.activeSessionId,
      activeWorkspaceId: s.activeWorkspaceId,
      generatingBySession: s.generatingBySession,
      workspaces: s.workspaces,
      setActiveSession: s.setActiveSession,
      updateSessionTitle: s.updateSessionTitle,
      reorderWorkspaces: s.reorderWorkspaces,
    }))
  );
  const { requestDeleteSession, deleteSessionModal } = useDeleteSessionWithWorktree();
  const { requestNewSession, newSessionModal } = useNewSessionModal();
  const {
    activeNavTab,
    setActiveNavTab,
    settingsOpen,
    openSettings,
    leftSidebarWidth,
    setLeftSidebarWidth,
    leftSidebarCollapsed,
    toggleLeftSidebarCollapsed,
  } = useAppStore(
    useShallow((s) => ({
      activeNavTab: s.activeNavTab,
      setActiveNavTab: s.setActiveNavTab,
      settingsOpen: s.settingsOpen,
      openSettings: s.openSettings,
      leftSidebarWidth: s.leftSidebarWidth,
      setLeftSidebarWidth: s.setLeftSidebarWidth,
      leftSidebarCollapsed: s.leftSidebarCollapsed,
      toggleLeftSidebarCollapsed: s.toggleLeftSidebarCollapsed,
    }))
  );

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
  const [searchHitMap, setSearchHitMap] = useState<
    Record<string, { matchType: "title" | "message"; matchSnippet?: string }>
  >({});
  const [filterOpen, setFilterOpen] = useState(false);
  const [filter, setFilter] = useState<"active" | "archived">("active");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [username, setUsername] = useState("本地用户");
  const [draggingWorkspaceId, setDraggingWorkspaceId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    workspaceId: string;
    position: "before" | "after";
  } | null>(null);

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

  useEffect(() => {
    const q = searchQuery.trim();
    if (!q || !window.electronAPI?.dbSearchSessions) {
      setSearchHitMap({});
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const hits = await window.electronAPI.dbSearchSessions(q, 50);
        if (cancelled) return;
        const map: Record<string, { matchType: "title" | "message"; matchSnippet?: string }> = {};
        if (Array.isArray(hits)) {
          for (const item of hits) {
            if (item?.sessionId) {
              map[item.sessionId] = {
                matchType: item.matchType,
                matchSnippet: item.matchSnippet,
              };
            }
          }
        }
        setSearchHitMap(map);
      } catch {
        if (!cancelled) setSearchHitMap({});
      }
    }, 160);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [searchQuery]);

  const matchesQuery = (session: Session) =>
    !normalizedQuery ||
    (session.title || "").toLowerCase().includes(normalizedQuery) ||
    Boolean(searchHitMap[session.id]);

  const visibleSessions = useMemo(
    () =>
      sessions
        .filter((session) => (filter === "archived" ? !!session.archived : !session.archived))
        .filter(matchesQuery),
    [sessions, filter, normalizedQuery, searchHitMap]
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

  const canReorderWorkspaces =
    normalizedQuery === "" && editingSessionId === null && workspaceGroups.length > 1;

  const resetWorkspaceDrag = () => {
    setDraggingWorkspaceId(null);
    setDropTarget(null);
  };

  const commitWorkspaceDrop = (
    sourceId: string,
    targetId: string,
    position: "before" | "after"
  ) => {
    if (!sourceId || !targetId || sourceId === targetId) return;
    const ids = workspaces.map((w) => w.id).filter((id) => id !== sourceId);
    const targetIdx = ids.indexOf(targetId);
    if (targetIdx === -1) return;
    const insertIdx = position === "after" ? targetIdx + 1 : targetIdx;
    ids.splice(insertIdx, 0, sourceId);
    void reorderWorkspaces(ids);
  };

  const toggleGroup = (key: string) => {
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleNewTask = () => {
    const activeSession = sessions.find((session) => session.id === activeSessionId);
    requestNewSession({
      workspaceId: activeWorkspaceId || activeSession?.workspaceId,
      workDir: activeSession?.workDir,
      model: activeSession?.model,
      onCreated: () => setActiveNavTab("sessions"),
    });
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
  }, [sessions, activeSessionId, activeWorkspaceId, workspaces]);

  const handleSelectSession = async (id: string) => {
    setActiveNavTab("sessions");
    await setActiveSession(id);
  };

  const handleNewInWorkspace = (workspaceId: string) => {
    requestNewSession({
      workspaceId,
      onCreated: () => setActiveNavTab("sessions"),
    });
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
            size={14}
            className="flex-shrink-0 text-[var(--ui-accent-blue)] animate-spin"
          />
        ) : (
          <MessageSquare
            size={14}
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
            className="flex-1 min-w-0 h-6 px-1 text-xs rounded bg-[var(--ui-card-inner-bg)] text-[var(--ui-text-primary)] border border-blue-500 outline-none"
          />
        ) : (
          <>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-normal truncate">
                {session.title || "新的 Agent 会话"}
              </div>
              {normalizedQuery &&
                searchHitMap[session.id]?.matchType === "message" &&
                searchHitMap[session.id]?.matchSnippet && (
                  <div className="text-[10px] text-[var(--ui-text-faint)] truncate mt-0.5">
                    {searchHitMap[session.id].matchSnippet}
                  </div>
                )}
            </div>
            <span className="text-[11px] text-[var(--ui-text-faint)] flex-shrink-0 group-hover/session:hidden">
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
                <Pencil size={12} />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  requestDeleteSession(session);
                }}
                className="p-0.5 rounded text-[var(--ui-text-faint)] hover:text-[var(--ui-accent-rose)] hover:bg-[var(--ui-accent-rose-soft)]"
                title="删除会话"
              >
                <Trash2 size={12} />
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
    const workspaceId = group.workspaceId;
    const isDraggable = Boolean(workspaceId && canReorderWorkspaces);
    const isDragging = Boolean(workspaceId && draggingWorkspaceId === workspaceId);
    const isDropBefore = Boolean(
      workspaceId && dropTarget?.workspaceId === workspaceId && dropTarget.position === "before"
    );
    const isDropAfter = Boolean(
      workspaceId && dropTarget?.workspaceId === workspaceId && dropTarget.position === "after"
    );

    return (
      <div
        key={group.key}
        draggable={isDraggable}
        onDragStart={(e) => {
          if (!isDraggable || !workspaceId) return;
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData(WORKSPACE_DRAG_MIME, workspaceId);
          e.dataTransfer.setData("text/plain", workspaceId);
          setDraggingWorkspaceId(workspaceId);
        }}
        onDragOver={(e) => {
          if (
            !isDraggable ||
            !workspaceId ||
            !draggingWorkspaceId ||
            draggingWorkspaceId === workspaceId ||
            !e.dataTransfer.types.includes(WORKSPACE_DRAG_MIME)
          ) {
            return;
          }
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          const rect = e.currentTarget.getBoundingClientRect();
          const position: "before" | "after" =
            e.clientY < rect.top + rect.height / 2 ? "before" : "after";
          setDropTarget((prev) =>
            prev?.workspaceId === workspaceId && prev.position === position
              ? prev
              : { workspaceId, position }
          );
        }}
        onDragLeave={(e) => {
          if (
            !workspaceId ||
            e.currentTarget.contains(e.relatedTarget as Node | null)
          ) {
            return;
          }
          setDropTarget((prev) => (prev?.workspaceId === workspaceId ? null : prev));
        }}
        onDrop={(e) => {
          if (!isDraggable || !workspaceId) return;
          if (!e.dataTransfer.types.includes(WORKSPACE_DRAG_MIME)) return;
          e.preventDefault();
          const sourceId = e.dataTransfer.getData(WORKSPACE_DRAG_MIME) || draggingWorkspaceId || "";
          const rect = e.currentTarget.getBoundingClientRect();
          const position: "before" | "after" =
            e.clientY < rect.top + rect.height / 2 ? "before" : "after";
          commitWorkspaceDrop(sourceId, workspaceId, position);
          resetWorkspaceDrag();
        }}
        onDragEnd={resetWorkspaceDrag}
        className={`relative mb-0.5 transition-opacity ${isDragging ? "opacity-45" : ""}`}
      >
        {isDropBefore && (
          <div className="pointer-events-none absolute -top-0.5 left-2 right-2 h-0.5 rounded-full bg-blue-400 z-10" />
        )}
        <div
          onClick={() => toggleGroup(group.key)}
          className={`group/ws mx-1.5 flex items-center gap-1.5 pl-1.5 pr-1 py-1.5 rounded-lg transition-colors ${
            isDraggable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"
          } ${
            isCurrentActive
              ? "text-[var(--ui-text-primary)] bg-[var(--ui-accent-blue-soft)]/40 font-medium"
              : "text-[var(--ui-text-secondary)] hover:bg-[var(--ui-chip-bg)]"
          }`}
        >
          {isExpanded ? (
            <ChevronDown size={13} className="text-[var(--ui-text-faint)] flex-shrink-0" />
          ) : (
            <ChevronRight size={13} className="text-[var(--ui-text-faint)] flex-shrink-0" />
          )}
          <FolderGit2 size={15} className={isCurrentActive ? "text-blue-400 flex-shrink-0" : "text-[var(--ui-accent-blue)] flex-shrink-0"} />
          <span className="flex-1 min-w-0 text-xs font-medium truncate">{group.name}</span>
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
        {isDropAfter && (
          <div className="pointer-events-none absolute -bottom-0.5 left-2 right-2 h-0.5 rounded-full bg-blue-400 z-10" />
        )}
      </div>
    );
  };

  const navClass = (tab: "workspaces" | "tools") =>
    `w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg transition-colors ${
      activeNavTab === tab
        ? "bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)]"
        : "text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-chip-bg)]"
    }`;

  const initial = (username || "本").trim().charAt(0).toUpperCase();

  if (leftSidebarCollapsed) {
    const railBtnClass = (active: boolean) =>
      `w-9 h-9 flex items-center justify-center rounded-lg transition-colors ${
        active
          ? "bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)]"
          : "text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-chip-bg)]"
      }`;

    return (
      <aside className="relative w-14 h-full bg-[var(--ui-panel-bg)] backdrop-blur-xl backdrop-saturate-150 border-r border-[color:var(--ui-divider-hairline)] flex flex-col items-center flex-shrink-0 select-none">
        {/* 顶部留出 macOS 原生红绿灯安全间距与窗口拖拽区 */}
        <div className="h-9 w-full titlebar-drag flex-shrink-0" />

        {/* 收起态：仅展示一列图标 */}
        <div className="flex-1 w-full py-2 flex flex-col items-center gap-1.5 titlebar-no-drag">
          <button
            onClick={toggleLeftSidebarCollapsed}
            className="w-9 h-9 flex items-center justify-center rounded-lg text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-chip-bg)] transition-colors"
            title="展开左侧菜单"
          >
            <PanelLeftOpen size={16} />
          </button>

          <div className="w-6 h-px bg-[var(--ui-divider-hairline)] my-0.5" />

          <button
            onClick={handleNewTask}
            className="w-9 h-9 flex items-center justify-center rounded-lg text-[var(--ui-text-primary)] hover:bg-[var(--ui-chip-bg)] transition-colors"
            title="新建任务 (⌘N)"
          >
            <Plus size={16} className="text-[var(--ui-text-muted)]" />
          </button>

          <button
            onClick={() => setActiveNavTab("workspaces")}
            className={railBtnClass(activeNavTab === "workspaces")}
            title="工作空间"
          >
            <FolderGit2 size={16} />
          </button>

          <button
            onClick={() => setActiveNavTab("tools")}
            className={railBtnClass(activeNavTab === "tools")}
            title="工具与技能"
          >
            <Wrench size={16} />
          </button>
        </div>

        <div className="border-t border-[color:var(--ui-divider-hairline)] w-full py-2.5 flex flex-col items-center gap-2 flex-shrink-0 titlebar-no-drag">
          <div
            className="w-7 h-7 rounded-full bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)] flex items-center justify-center text-[11px] font-bold"
            title={username}
          >
            {initial}
          </div>
          <button
            onClick={() => openSettings()}
            className={railBtnClass(settingsOpen)}
            title="设置"
          >
            <Settings size={15} />
          </button>
        </div>
      </aside>
    );
  }

  return (
    <aside
      ref={sidebarRef as React.RefObject<HTMLElement>}
      style={{
        width: liveSidebarWidth != null ? `${liveSidebarWidth}px` : leftSidebarWidth,
        maxWidth: "40vw",
      }}
      className="relative h-full bg-[var(--ui-panel-bg)] backdrop-blur-xl backdrop-saturate-150 border-r border-[color:var(--ui-divider-hairline)] flex flex-col flex-shrink-0 select-none"
    >
      {/* 顶部留出 macOS 原生红绿灯安全间距与窗口拖拽区 */}
      <div className="h-9 w-full titlebar-drag flex-shrink-0 flex items-center justify-end px-2">
        <button
          onClick={toggleLeftSidebarCollapsed}
          className="w-6 h-6 flex items-center justify-center rounded-md text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-chip-bg)] transition-colors titlebar-no-drag"
          title="收起为图标列"
        >
          <PanelLeftClose size={14} />
        </button>
      </div>

      <div className="p-2.5 pb-2 space-y-0.5 border-b border-[color:var(--ui-divider-hairline)] titlebar-no-drag">
        <button
          onClick={handleNewTask}
          className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-[var(--ui-text-primary)] hover:bg-[var(--ui-chip-bg)] transition-colors"
        >
          <Plus size={15} className="text-[var(--ui-text-muted)]" />
          <span className="flex-1 text-left text-xs font-medium">新建任务</span>
          <span className="text-[10px] text-[var(--ui-text-faint)] font-mono">⌘N</span>
        </button>

        <button
          onClick={() => window.dispatchEvent(new CustomEvent("omcx-open-command-palette"))}
          className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-chip-bg)] transition-colors"
          title="全局搜索会话与快捷命令 (⌘K)"
        >
          <Search size={14} className="text-[var(--ui-text-muted)]" />
          <span className="flex-1 text-left text-xs font-medium">快速检索</span>
          <span className="text-[10px] text-[var(--ui-text-faint)] font-mono">⌘K</span>
        </button>

        <button onClick={() => setActiveNavTab("workspaces")} className={navClass("workspaces")}>
          <FolderGit2 size={15} />
          <span className="text-xs font-medium">工作空间</span>
        </button>

        <button onClick={() => setActiveNavTab("tools")} className={navClass("tools")}>
          <Wrench size={15} />
          <span className="text-xs font-medium">工具与技能</span>
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
              <div className="absolute right-0 top-7 z-50 w-28 py-1 rounded-lg bg-[var(--ui-popover-bg)] backdrop-blur-xl backdrop-saturate-150 border border-[color:var(--ui-border-subtle)] shadow-[var(--ui-popover-shadow)]">
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
            placeholder="搜索任务标题或消息内容..."
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
      {deleteSessionModal}
      {newSessionModal}
    </aside>
  );
};

export default LeftSidebar;
