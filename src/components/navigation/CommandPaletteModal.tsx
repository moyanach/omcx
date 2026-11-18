import React, { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  Search,
  MessageSquare,
  Plus,
  FolderGit2,
  Wrench,
  Settings,
  PanelLeft,
  Terminal,
  FileDiff,
  CornerDownLeft,
  X,
  CalendarClock,
} from "lucide-react";
import { useChatStore } from "@/stores/chatStore";
import { useAppStore } from "@/stores/appStore";
import { formatRelativeTime } from "@/lib/relativeTime";

interface PaletteItem {
  id: string;
  group: "动作" | "会话" | "工作空间";
  title: string;
  subtitle?: string;
  shortcut?: string;
  icon: React.ReactNode;
  onSelect: () => void;
}

const CommandPaletteModal: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [dbHits, setDbHits] = useState<
    Array<{
      sessionId: string;
      title: string;
      updatedAt?: number;
      matchType: "title" | "message";
      matchSnippet?: string;
    }>
  >([]);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const {
    sessions,
    workspaces,
    activeSessionId,
    setActiveSession,
    addSession,
    addSessionInWorkspace,
    openTerminalInWorkbench,
    openDiffInWorkbench,
  } = useChatStore(
    useShallow((s) => ({
      sessions: s.sessions,
      workspaces: s.workspaces,
      activeSessionId: s.activeSessionId,
      setActiveSession: s.setActiveSession,
      addSession: s.addSession,
      addSessionInWorkspace: s.addSessionInWorkspace,
      openTerminalInWorkbench: s.openTerminalInWorkbench,
      openDiffInWorkbench: s.openDiffInWorkbench,
    }))
  );

  const { setActiveNavTab, openSettings, toggleLeftSidebarCollapsed } = useAppStore(
    useShallow((s) => ({
      setActiveNavTab: s.setActiveNavTab,
      openSettings: s.openSettings,
      toggleLeftSidebarCollapsed: s.toggleLeftSidebarCollapsed,
    }))
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      } else if (e.key === "Escape" && open) {
        e.preventDefault();
        setOpen(false);
      }
    };
    const onCustomOpen = () => setOpen(true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("omcx-open-command-palette", onCustomOpen);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("omcx-open-command-palette", onCustomOpen);
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setDbHits([]);
      setActiveIndex(0);
      return;
    }
    const timer = window.setTimeout(() => {
      inputRef.current?.focus();
    }, 10);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const clean = query.trim();
    if (!clean || !window.electronAPI?.dbSearchSessions) {
      setDbHits([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const res = await window.electronAPI.dbSearchSessions(clean, 30);
        if (!cancelled && Array.isArray(res)) {
          setDbHits(res);
        }
      } catch {
        if (!cancelled) setDbHits([]);
      }
    }, 140);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, query]);

  const items = useMemo<PaletteItem[]>(() => {
    const q = query.trim().toLowerCase();
    const closeAnd = (fn: () => void) => () => {
      setOpen(false);
      fn();
    };

    const rawActionItems: PaletteItem[] = [
      {
        id: "act_new_session",
        group: "动作",
        title: "新建任务会话",
        subtitle: "在当前工作空间快速启动一个新对话",
        shortcut: "⌘N",
        icon: <Plus size={14} className="text-[var(--ui-accent-blue)]" />,
        onSelect: closeAnd(() => {
          const cur = sessions.find((s) => s.id === activeSessionId);
          void addSession({
            workspaceId: cur?.workspaceId || null,
            workDir: cur?.workDir || null,
            model: cur?.model,
          });
          setActiveNavTab("sessions");
        }),
      },
      {
        id: "act_automations",
        group: "动作",
        title: "打开定时任务",
        subtitle: "查看后台定时执行收件箱、Cron 规则与 Webhook 推送",
        icon: <CalendarClock size={14} className="text-[var(--ui-accent-blue)]" />,
        onSelect: closeAnd(() => setActiveNavTab("automations")),
      },
      {
        id: "act_workspaces",
        group: "动作",
        title: "打开工作空间管理",
        subtitle: "切换或管理绑定目录与 Git Worktree",
        icon: <FolderGit2 size={14} className="text-[var(--ui-accent-amber)]" />,
        onSelect: closeAnd(() => setActiveNavTab("workspaces")),
      },
      {
        id: "act_tools",
        group: "动作",
        title: "打开工具与技能中心",
        subtitle: "查看 MCP 连接器、Skills、Subagents 与 Hooks",
        icon: <Wrench size={14} className="text-[var(--ui-accent-emerald)]" />,
        onSelect: closeAnd(() => setActiveNavTab("tools")),
      },
      {
        id: "act_terminal",
        group: "动作",
        title: "打开集成终端",
        subtitle: "在右侧工作台拉起交互式 PTY 终端",
        shortcut: "⌃`",
        icon: <Terminal size={14} className="text-[var(--ui-accent-emerald)]" />,
        onSelect: closeAnd(() => {
          setActiveNavTab("sessions");
          openTerminalInWorkbench();
        }),
      },
      {
        id: "act_diff",
        group: "动作",
        title: "查看代码变更对比 (Git Diff)",
        subtitle: "在右侧工作台检查当前工作区改动",
        shortcut: "⌃⇧G",
        icon: <FileDiff size={14} className="text-[var(--ui-accent-amber)]" />,
        onSelect: closeAnd(() => {
          setActiveNavTab("sessions");
          openDiffInWorkbench();
        }),
      },
      {
        id: "act_toggle_sidebar",
        group: "动作",
        title: "折叠 / 展开左侧任务栏",
        icon: <PanelLeft size={14} className="text-[var(--ui-text-muted)]" />,
        onSelect: closeAnd(() => toggleLeftSidebarCollapsed()),
      },
      {
        id: "act_settings",
        group: "动作",
        title: "打开系统设置",
        subtitle: "模型配置、推理策略、外观与上下文参数",
        icon: <Settings size={14} className="text-[var(--ui-text-muted)]" />,
        onSelect: closeAnd(() => openSettings()),
      },
    ];
    const actionItems: PaletteItem[] = rawActionItems.filter(
      (item) =>
        !q ||
        item.title.toLowerCase().includes(q) ||
        (item.subtitle || "").toLowerCase().includes(q)
    );

    const hitById = new Map(dbHits.map((h) => [h.sessionId, h]));
    const sessionById = new Map(sessions.map((s) => [s.id, s]));
    const sessionItems: PaletteItem[] = [];
    const seenIds = new Set<string>();

    const sortedSessions = [...sessions]
      .filter((s) => s.sessionType !== "automation")
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    for (const sess of sortedSessions) {
      const hit = hitById.get(sess.id);
      const titleMatch = !q || (sess.title || "").toLowerCase().includes(q);
      if (!titleMatch && !hit) continue;
      seenIds.add(sess.id);
      const ws = workspaces.find((w) => w.id === sess.workspaceId);
      const loc = ws?.name || sess.workDir?.split(/[\\/]/).filter(Boolean).pop() || "";
      const snippet = hit?.matchSnippet
        ? `${loc ? `${loc} · ` : ""}${hit.matchSnippet}`
        : `${loc ? `${loc} · ` : ""}${formatRelativeTime(sess.updatedAt)}`;
      sessionItems.push({
        id: `sess_${sess.id}`,
        group: "会话",
        title: sess.title || "新的 Agent 会话",
        subtitle: snippet,
        icon: <MessageSquare size={14} className="text-[var(--ui-accent-blue)]" />,
        onSelect: closeAnd(() => {
          setActiveNavTab("sessions");
          void setActiveSession(sess.id);
        }),
      });
      if (!q && sessionItems.length >= 10) break;
    }

    if (q) {
      for (const hit of dbHits) {
        if (seenIds.has(hit.sessionId)) continue;
        const sess = sessionById.get(hit.sessionId);
        if (!sess) continue;
        seenIds.add(hit.sessionId);
        sessionItems.push({
          id: `sess_${sess.id}`,
          group: "会话",
          title: sess.title || hit.title || "新的 Agent 会话",
          subtitle: hit.matchSnippet || formatRelativeTime(sess.updatedAt),
          icon: <MessageSquare size={14} className="text-[var(--ui-accent-blue)]" />,
          onSelect: closeAnd(() => {
            setActiveNavTab("sessions");
            void setActiveSession(sess.id);
          }),
        });
      }
    }

    const wsItems: PaletteItem[] = workspaces
      .filter((w) => !q || w.name.toLowerCase().includes(q))
      .slice(0, 6)
      .map((w) => ({
        id: `ws_${w.id}`,
        group: "工作空间",
        title: `在「${w.name}」新建任务`,
        subtitle: w.folders?.[0]?.path || "",
        icon: <FolderGit2 size={14} className="text-[var(--ui-accent-sky)]" />,
        onSelect: closeAnd(() => {
          setActiveNavTab("sessions");
          void addSessionInWorkspace(w.id);
        }),
      }));

    return q
      ? [...sessionItems, ...actionItems, ...wsItems]
      : [...actionItems, ...sessionItems, ...wsItems];
  }, [
    query,
    dbHits,
    sessions,
    workspaces,
    activeSessionId,
    addSession,
    addSessionInWorkspace,
    setActiveSession,
    setActiveNavTab,
    openSettings,
    toggleLeftSidebarCollapsed,
    openTerminalInWorkbench,
    openDiffInWorkbench,
  ]);

  useEffect(() => {
    setActiveIndex(0);
  }, [items.length, query]);

  useEffect(() => {
    if (!open || !listRef.current) return;
    const activeEl = listRef.current.querySelector(`[data-palette-idx="${activeIndex}"]`);
    if (activeEl instanceof HTMLElement) {
      activeEl.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex, open]);

  if (!open) return null;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.nativeEvent as any)?.isComposing || (e as any).keyCode === 229) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (items.length > 0 ? (i + 1) % items.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (items.length > 0 ? (i - 1 + items.length) % items.length : 0));
    } else if (e.key === "Enter" && items[activeIndex]) {
      e.preventDefault();
      items[activeIndex].onSelect();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div
      onClick={() => setOpen(false)}
      className="fixed inset-0 z-[99990] bg-black/50 backdrop-blur-[2px] flex items-start justify-center pt-[13vh] px-4 select-none"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        className="w-full max-w-[600px] rounded-2xl bg-[var(--ui-popover-bg)] backdrop-blur-2xl backdrop-saturate-150 border border-[color:var(--ui-border-subtle)] shadow-[var(--ui-popover-shadow)] overflow-hidden flex flex-col"
      >
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-[color:var(--ui-divider-hairline)]">
          <Search size={15} className="text-[var(--ui-accent-blue)] flex-shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索历史会话标题、消息全文或快捷命令..."
            className="flex-1 bg-transparent text-sm text-[var(--ui-text-primary)] placeholder-[var(--ui-text-faint)] outline-none"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="p-1 rounded-md text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-chip-hover-bg)]"
              title="清空"
            >
              <X size={13} />
            </button>
          )}
          <span className="px-1.5 py-0.5 rounded text-[10px] font-mono text-[var(--ui-text-faint)] bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)]">
            ESC
          </span>
        </div>

        <div ref={listRef} className="max-h-[420px] overflow-y-auto py-1.5 custom-scrollbar">
          {items.length === 0 ? (
            <div className="py-10 text-center text-xs text-[var(--ui-text-faint)]">
              未找到匹配的会话、消息或命令
            </div>
          ) : (
            items.map((item, idx) => {
              const showHeader = idx === 0 || items[idx - 1].group !== item.group;
              const isSelected = idx === activeIndex;
              return (
                <React.Fragment key={item.id}>
                  {showHeader && (
                    <div className="px-4 pt-2 pb-1 text-[10px] font-semibold text-[var(--ui-text-faint)] uppercase tracking-wider">
                      {item.group}
                    </div>
                  )}
                  <button
                    type="button"
                    data-palette-idx={idx}
                    onMouseEnter={() => setActiveIndex(idx)}
                    onClick={item.onSelect}
                    className={`w-full px-3.5 py-2 flex items-center gap-3 text-left transition-colors cursor-pointer ${
                      isSelected
                        ? "bg-[var(--ui-accent-blue-soft)] text-[var(--ui-text-primary)]"
                        : "text-[var(--ui-text-secondary)] hover:bg-[var(--ui-block-hover-bg)]"
                    }`}
                  >
                    <div className="w-6 h-6 rounded-lg bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)] flex items-center justify-center flex-shrink-0">
                      {item.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium text-[var(--ui-text-primary)] truncate">
                        {item.title}
                      </div>
                      {item.subtitle && (
                        <div className="text-[11px] text-[var(--ui-text-faint)] truncate mt-0.5">
                          {item.subtitle}
                        </div>
                      )}
                    </div>
                    {item.shortcut ? (
                      <span className="text-[10px] font-mono text-[var(--ui-text-faint)] px-1.5 py-0.5 rounded bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)] flex-shrink-0">
                        {item.shortcut}
                      </span>
                    ) : isSelected ? (
                      <CornerDownLeft size={12} className="text-[var(--ui-accent-blue)] flex-shrink-0" />
                    ) : null}
                  </button>
                </React.Fragment>
              );
            })
          )}
        </div>

        <div className="px-4 py-2 border-t border-[color:var(--ui-divider-hairline)] bg-[var(--ui-code-header-bg)] flex items-center justify-between text-[10.5px] text-[var(--ui-text-faint)]">
          <span>↑↓ 选择 · ↵ 执行</span>
          <span className="font-mono">⌘K 全局面板</span>
        </div>
      </div>
    </div>
  );
};

export default CommandPaletteModal;
