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
} from "lucide-react";
import { useChatStore, type Session } from "@/stores/chatStore";
import { useAppStore } from "@/stores/appStore";
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
    workspaces,
    setActiveSession,
    addSession,
    addSessionInWorkspace,
    deleteSession,
    updateSessionTitle,
  } = useChatStore();
  const { activeNavTab, setActiveNavTab } = useAppStore();

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
    const coveredPaths = new Set<string>();
    workspaces.forEach((workspace) => {
      workspace.folders.forEach((folder) => coveredPaths.add(folder.path));
    });

    const groups: ProjectGroup[] = workspaces.map((workspace) => {
      const groupSessions = visibleSessions
        .filter(
          (session) =>
            session.workDir &&
            workspace.folders.some((folder) => folder.path === session.workDir)
        )
        .sort(byUpdated);
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

    const pseudoMap = new Map<string, Session[]>();
    visibleSessions.forEach((session) => {
      if (!session.workDir || coveredPaths.has(session.workDir)) return;
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

    const unassignedSessions = visibleSessions
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
    await addSession({ workDir: activeSession?.workDir, model: activeSession?.model });
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

    return (
      <div
        key={session.id}
        onClick={() => !isEditing && handleSelectSession(session.id)}
        className={`group/session mx-1.5 flex items-center gap-2 pl-7 pr-2 py-1.5 rounded-lg cursor-pointer transition-colors ${
          isActive
            ? "bg-blue-500/10 text-blue-400"
            : "text-neutral-400 hover:text-neutral-200 hover:bg-neutral-500/10"
        }`}
      >
        <MessageSquare
          size={12}
          className={`flex-shrink-0 ${isActive ? "text-blue-400" : "text-neutral-600"}`}
        />

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
            className="flex-1 min-w-0 h-5 px-1 text-[11px] rounded bg-[#202020] text-neutral-100 border border-blue-500 outline-none"
          />
        ) : (
          <>
            <span className="flex-1 min-w-0 text-[11px] truncate tracking-tight">
              {session.title || "新的 Agent 会话"}
            </span>
            <span className="text-[10px] text-neutral-600 flex-shrink-0 group-hover/session:hidden">
              {formatRelativeTime(session.updatedAt)}
            </span>
            <div className="hidden group-hover/session:flex items-center gap-0.5 flex-shrink-0">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  startRename(session);
                }}
                className="p-0.5 rounded text-neutral-500 hover:text-neutral-200 hover:bg-neutral-500/20"
                title="重命名"
              >
                <Pencil size={10} />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  deleteSession(session.id);
                }}
                className="p-0.5 rounded text-neutral-500 hover:text-rose-400 hover:bg-rose-500/10"
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

    return (
      <div key={group.key} className="mb-0.5">
        <div
          onClick={() => toggleGroup(group.key)}
          className="group/ws mx-1.5 flex items-center gap-1.5 pl-1.5 pr-1 py-1.5 rounded-lg cursor-pointer text-neutral-300 hover:bg-neutral-500/10 transition-colors"
        >
          {isExpanded ? (
            <ChevronDown size={12} className="text-neutral-500 flex-shrink-0" />
          ) : (
            <ChevronRight size={12} className="text-neutral-500 flex-shrink-0" />
          )}
          <FolderGit2 size={14} className="text-blue-400/80 flex-shrink-0" />
          <span className="flex-1 min-w-0 text-xs font-medium truncate">{group.name}</span>
          {group.workspaceId && group.canCreate && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleNewInWorkspace(group.workspaceId as string);
              }}
              className="w-5 h-5 flex items-center justify-center rounded-md text-neutral-400 hover:text-white hover:bg-neutral-500/20 transition-colors"
              title="在此工作空间新建会话"
            >
              <Plus size={13} />
            </button>
          )}
        </div>

        {isExpanded && group.sessions.map(renderSession)}
        {isExpanded && group.sessions.length === 0 && (
          <div className="pl-9 pr-3 py-1 text-[10px] text-neutral-600">暂无会话</div>
        )}
      </div>
    );
  };

  const navClass = (tab: "workspaces" | "tools") =>
    `w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg transition-colors ${
      activeNavTab === tab
        ? "bg-blue-500/10 text-blue-300"
        : "text-neutral-300 hover:text-neutral-100 hover:bg-neutral-500/10"
    }`;

  const initial = (username || "本").trim().charAt(0).toUpperCase();

  return (
    <aside className="w-[280px] h-full bg-[#141414] border-r border-[#222222] flex flex-col flex-shrink-0 select-none">
      {/* 顶部留出 macOS 原生红绿灯安全间距与窗口拖拽区 */}
      <div className="h-9 w-full titlebar-drag flex-shrink-0" />

      <div className="p-2.5 pb-2 space-y-0.5 border-b border-[#202020] titlebar-no-drag">
        <button
          onClick={handleNewTask}
          className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-neutral-200 hover:bg-neutral-500/10 transition-colors"
        >
          <Plus size={15} className="text-neutral-400" />
          <span className="flex-1 text-left text-xs font-medium">新建任务</span>
          <span className="text-[10px] text-neutral-500 font-mono">⌘N</span>
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
        <span className="text-[11px] font-semibold text-neutral-500 tracking-wide">
          任务列表
        </span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => setSearchOpen((open) => !open)}
            className={`w-6 h-6 flex items-center justify-center rounded-md transition-colors ${
              searchOpen ? "text-blue-400 bg-blue-500/10" : "text-neutral-500 hover:text-neutral-200 hover:bg-neutral-500/10"
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
                filterOpen ? "text-blue-400 bg-blue-500/10" : "text-neutral-500 hover:text-neutral-200 hover:bg-neutral-500/10"
              }`}
              title="筛选任务"
            >
              <SlidersHorizontal size={13} />
            </button>
            {filterOpen && (
              <div className="absolute right-0 top-7 z-50 w-28 py-1 rounded-lg bg-[#1f1f1f] border border-[#333333] shadow-2xl">
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
                    className="w-full flex items-center justify-between px-2.5 py-1.5 text-[11px] text-neutral-300 hover:bg-neutral-500/10"
                  >
                    <span>{option.label}</span>
                    {filter === option.value && <Check size={11} className="text-blue-400" />}
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
            className="w-full h-7 px-2 text-[11px] rounded-lg bg-[#1c1c1c] border border-[#2e2e2e] text-neutral-200 placeholder-neutral-600 outline-none focus:border-blue-500/60"
          />
        </div>
      )}

      <div className="flex-1 overflow-y-auto pb-3 custom-scrollbar">
        <div className="px-3 pt-2 pb-1 text-[10px] font-semibold text-neutral-600 tracking-wide uppercase">
          项目
        </div>
        {workspaceGroups.length === 0 && standaloneGroups.length === 0 ? (
          <div className="px-3 py-2 text-[11px] text-neutral-600">
            {normalizedQuery ? "未找到匹配项目" : "暂无项目"}
          </div>
        ) : (
          <>
            {workspaceGroups.map(renderGroup)}
            {standaloneGroups.map(renderGroup)}
          </>
        )}

        <div className="px-3 pt-4 pb-1 text-[10px] font-semibold text-neutral-600 tracking-wide uppercase">
          任务
        </div>
        {unassigned.length === 0 ? (
          <div className="px-3 py-1.5 text-[11px] text-neutral-600">
            {normalizedQuery ? "未找到匹配任务" : "暂无任务"}
          </div>
        ) : (
          unassigned.map(renderSession)
        )}
      </div>

      <div className="border-t border-[#202020] p-3 flex items-center gap-2.5 flex-shrink-0">
        <div className="w-7 h-7 rounded-full bg-blue-500/15 text-blue-400 flex items-center justify-center text-[11px] font-bold flex-shrink-0">
          {initial}
        </div>
        <span className="flex-1 min-w-0 text-xs text-neutral-300 truncate">{username}</span>
        <button
          onClick={() => setActiveNavTab("settings")}
          className={`w-6 h-6 flex items-center justify-center rounded-md transition-colors ${
            activeNavTab === "settings"
              ? "text-blue-400 bg-blue-500/10"
              : "text-neutral-500 hover:text-neutral-200 hover:bg-neutral-500/10"
          }`}
          title="设置"
        >
          <Settings size={15} />
        </button>
      </div>
    </aside>
  );
};

export default LeftSidebar;
