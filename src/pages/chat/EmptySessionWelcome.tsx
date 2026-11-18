import React, { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  Briefcase,
  Code2,
  FolderGit2,
  Check,
  Plus,
  GitBranch,
  ArrowRight,
  CalendarClock,
  Layers,
  FileText,
  FileSpreadsheet,
  FolderKanban,
  Workflow,
  FileSearch,
  ShieldCheck,
  Bug,
  Compass,
  MessageSquare,
} from "lucide-react";
import { useChatStore } from "@/stores/chatStore";
import { useAppStore } from "@/stores/appStore";

export interface EmptySessionWelcomeProps {
  onPrefillPrompt: (text: string, options?: { trigger?: "@" | "/" }) => void;
  onOpenInspector?: () => void;
}

interface StarterCard {
  id: string;
  title: string;
  desc: string;
  prompt: string;
  tag?: string;
  icon: React.ReactNode;
}

const CODE_STARTERS: StarterCard[] = [
  {
    id: "arch",
    title: "架构与符号脉络",
    desc: "用符号索引梳理核心模块与数据流",
    prompt: "请梳理当前项目的核心目录结构、关键模块职责与主要数据流。",
    tag: "repo_map",
    icon: <Compass size={14} />,
  },
  {
    id: "spec",
    title: "需求规划",
    desc: "先拆解需求边界与技术方案再落地",
    prompt: "/spec ",
    tag: "/spec",
    icon: <Layers size={14} />,
  },
  {
    id: "review",
    title: "代码审查",
    desc: "按 P0/P1/P2 审计缺陷、安全与并发",
    prompt: "@reviewer 请对当前项目近期的改动或核心链路进行代码与安全审查：",
    tag: "@reviewer",
    icon: <ShieldCheck size={14} />,
  },
  {
    id: "debug",
    title: "问题排查定位",
    desc: "结合源码分析报错根因并给出最小修复",
    prompt: "帮我排查以下报错或异常行为的根因，并先说明原因再确认修改方案：",
    tag: "Debug",
    icon: <Bug size={14} />,
  },
];

const WORK_STARTERS: StarterCard[] = [
  {
    id: "read-doc",
    title: "文档解析提炼",
    desc: "读取 PDF / Word / Excel / PPT 汇总要点",
    prompt: "请读取当前工作目录里的文档内容，提炼核心结论、关键数据与待办事项：",
    tag: "read_document",
    icon: <FileSearch size={14} />,
  },
  {
    id: "gen-doc",
    title: "生成交付文档",
    desc: "整理结构化汇报并导出 Word / Excel / PPT",
    prompt: "请帮我根据以下信息整理成结构化报告，并导出为可交付的文档：",
    tag: "generate_document",
    icon: <FileSpreadsheet size={14} />,
  },
  {
    id: "organize",
    title: "目录整理盘点",
    desc: "先盘点文件分类并出归档方案再执行",
    prompt: "请先扫描当前工作目录的文件结构与类型分布，给出一份清晰的归类整理方案后再执行。",
    tag: "Work",
    icon: <FolderKanban size={14} />,
  },
  {
    id: "workflow",
    title: "连接器与汇总",
    desc: "结合 MCP 连接器整理周报或巡检模板",
    prompt: "请结合当前可用的工具与连接器，帮我梳理并生成一份工作进度汇总：",
    tag: "Connectors",
    icon: <Workflow size={14} />,
  },
];

function formatDayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** OMCX 双引擎像素轨道小徽章 */
const OmcxModeBadge: React.FC<{ mode: "code" | "work" }> = ({ mode }) => {
  const isWork = mode === "work";
  const primary = isWork ? "var(--ui-accent-purple, #c084fc)" : "var(--ui-accent-blue, #60a5fa)";
  const accent = isWork ? "var(--ui-accent-amber, #fbbf24)" : "var(--ui-accent-sky, #38bdf8)";

  return (
    <div className="relative inline-flex items-center justify-center select-none">
      <svg
        width="34"
        height="26"
        viewBox="0 0 34 26"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        {/* 顶角天线 / 脉冲点 */}
        <rect x="7" y="1" width="2" height="3" rx="0.8" fill={accent} opacity="0.85" />
        <rect x="25" y="1" width="2" height="3" rx="0.8" fill={accent} opacity="0.85" />
        {/* 机身主体 */}
        <rect x="4" y="4" width="26" height="16" rx="4" fill={primary} opacity="0.92" />
        {/* 内嵌屏幕 */}
        <rect x="7" y="7" width="20" height="10" rx="2.5" fill="rgba(15, 23, 42, 0.22)" />
        {/* 像素眼睛 / 核心标识 */}
        {isWork ? (
          <>
            <rect x="10.5" y="10" width="3" height="4" rx="1" fill="#ffffff" />
            <rect x="20.5" y="10" width="3" height="4" rx="1" fill="#ffffff" />
            <rect x="15.5" y="12.5" width="3" height="1.5" rx="0.75" fill={accent} />
          </>
        ) : (
          <>
            <path
              d="M12 10L10 12L12 14"
              stroke="#ffffff"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M22 10L24 12L22 14"
              stroke="#ffffff"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <rect x="16" y="9.5" width="2" height="5" rx="1" fill={accent} />
          </>
        )}
        {/* 底座支撑脚 */}
        <rect x="8" y="20" width="4" height="4" rx="1" fill={primary} opacity="0.72" />
        <rect x="22" y="20" width="4" height="4" rx="1" fill={primary} opacity="0.72" />
      </svg>
    </div>
  );
};

export const EmptySessionWelcome: React.FC<EmptySessionWelcomeProps> = ({
  onPrefillPrompt,
  onOpenInspector,
}) => {
  const {
    sessions,
    activeSessionId,
    workspaces,
    gitStatus,
    skills,
    mcpServers,
    setSessionWorkspace,
    openWorkspaceModal,
  } = useChatStore(
    useShallow((s) => ({
      sessions: s.sessions,
      activeSessionId: s.activeSessionId,
      workspaces: s.workspaces,
      gitStatus: s.gitStatus,
      skills: s.skills,
      mcpServers: s.mcpServers,
      setSessionWorkspace: s.setSessionWorkspace,
      openWorkspaceModal: s.openWorkspaceModal,
    }))
  );

  const { unreadAutomationRuns, setActiveNavTab, setActiveView } = useAppStore(
    useShallow((s) => ({
      unreadAutomationRuns: s.unreadAutomationRuns,
      setActiveNavTab: s.setActiveNavTab,
      setActiveView: s.setActiveView,
    }))
  );

  const [showAllWorkspaces, setShowAllWorkspaces] = useState(false);

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const agentMode: "code" | "work" = activeSession?.agentMode === "work" ? "work" : "code";

  // 计算当前会话匹配到的工作空间
  const matchedWorkspace = useMemo(() => {
    if (!activeSession) return null;
    if (activeSession.workspaceId) {
      const byId = workspaces.find((w) => w.id === activeSession.workspaceId);
      if (byId) return byId;
    }
    if (activeSession.workDir) {
      return (
        workspaces.find((w) => w.folders.some((f) => f.path === activeSession.workDir)) || null
      );
    }
    return null;
  }, [activeSession, workspaces]);

  const currentWorkDirName = useMemo(() => {
    if (matchedWorkspace) return matchedWorkspace.name;
    if (activeSession?.workDir) {
      return activeSession.workDir.split(/[\\/]/).filter(Boolean).pop() || activeSession.workDir;
    }
    return "日常问答";
  }, [matchedWorkspace, activeSession?.workDir]);

  // 近 16 周（112 天）本地会话活跃热力图
  const heatmapData = useMemo(() => {
    const WEEKS = 16;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const countsByDay = new Map<string, number>();
    let totalRecentCount = 0;

    // 算出本周一作为最后一周的起点（列对齐周一~周日）
    const dayOfWeek = (today.getDay() + 6) % 7; // Mon=0 ... Sun=6
    const gridStart = new Date(today);
    gridStart.setDate(today.getDate() - dayOfWeek - (WEEKS - 1) * 7);
    const gridStartMs = gridStart.getTime();

    for (const sess of sessions) {
      if (sess.sessionType === "automation") continue;
      const ts = Number(sess.updatedAt || 0);
      if (!ts || ts < gridStartMs) continue;
      const key = formatDayKey(new Date(ts));
      countsByDay.set(key, (countsByDay.get(key) || 0) + 1);
      totalRecentCount += 1;
    }

    const weeks: Array<{
      monthLabel?: string;
      days: Array<{ key: string; count: number; future: boolean }>;
    }> = [];

    let lastMonth = -1;
    for (let w = 0; w < WEEKS; w++) {
      const days: Array<{ key: string; count: number; future: boolean }> = [];
      let monthLabel: string | undefined;
      for (let d = 0; d < 7; d++) {
        const cellDate = new Date(gridStart);
        cellDate.setDate(gridStart.getDate() + w * 7 + d);
        const key = formatDayKey(cellDate);
        const future = cellDate.getTime() > today.getTime();
        if (d === 0) {
          const m = cellDate.getMonth();
          if (m !== lastMonth && w < WEEKS - 1) {
            monthLabel = `${m + 1}月`;
            lastMonth = m;
          }
        }
        days.push({
          key,
          count: future ? 0 : countsByDay.get(key) || 0,
          future,
        });
      }
      weeks.push({ monthLabel, days });
    }

    return { weeks, totalRecentCount };
  }, [sessions]);

  const enabledSkillsCount = useMemo(
    () => (skills || []).filter((s) => s.enabled !== false).length,
    [skills]
  );
  const enabledMcpsCount = useMemo(
    () => (mcpServers || []).filter((m) => m.enabled).length,
    [mcpServers]
  );

  const visibleWorkspaces = showAllWorkspaces ? workspaces : workspaces.slice(0, 4);
  const starters = agentMode === "work" ? WORK_STARTERS : CODE_STARTERS;

  const hasUncommittedGit =
    agentMode === "code" &&
    Boolean(activeSession?.workDir) &&
    Boolean(gitStatus?.isGit) &&
    (gitStatus?.modifiedFiles?.length || 0) > 0;

  const handleSelectWorkspaceRow = async (
    workspaceId: string | null,
    workDir: string | null
  ) => {
    if (!activeSessionId) return;
    await setSessionWorkspace(activeSessionId, workspaceId, workDir);
    onPrefillPrompt("");
  };

  const handleContinueUncommitted = () => {
    const count = gitStatus?.modifiedFiles?.length || 0;
    const sampleFiles = (gitStatus?.modifiedFiles || [])
      .slice(0, 5)
      .map((f) => f.path)
      .join("、");
    const branchText = gitStatus?.branch ? `（分支 ${gitStatus.branch}）` : "";
    onPrefillPrompt(
      `请查看当前工作区未提交的 ${count} 个改动文件${branchText}${sampleFiles ? `（如 ${sampleFiles}）` : ""}，梳理改动要点并协助检查或收尾。`
    );
  };

  const getHeatCellClass = (count: number, future: boolean) => {
    if (future) return "opacity-0 pointer-events-none";
    if (count === 0) return "bg-[var(--ui-chip-bg)]";
    if (count === 1) return "bg-blue-500/35";
    if (count === 2) return "bg-blue-500/60";
    return "bg-blue-500/90";
  };

  return (
    <div className="my-auto mx-auto w-full max-w-[560px] py-5 px-2 flex flex-col gap-3.5 select-none animate-in fade-in duration-200">
      {/* 1. 顶部身份区：OMCX 徽章与模式定位 */}
      <div className="flex flex-col items-center text-center gap-1.5 pb-0.5">
        <OmcxModeBadge mode={agentMode} />
        <div className="flex items-center gap-2 mt-0.5">
          <h2 className="text-[17px] font-semibold tracking-tight text-[var(--ui-text-primary)]">
            {agentMode === "work" ? "不止于编码 · 通用工作台" : "工程编码与自主工作台"}
          </h2>
        </div>
        <p className="text-xs text-[var(--ui-text-muted)] flex items-center gap-1.5 flex-wrap justify-center">
          <span className="inline-flex items-center gap-1 text-[var(--ui-text-secondary)] font-medium">
            {agentMode === "work" ? <Briefcase size={11} /> : <Code2 size={11} />}
            <span>{currentWorkDirName}</span>
          </span>
          {agentMode === "code" && gitStatus?.isGit && gitStatus.branch && (
            <>
              <span className="text-[var(--ui-text-faint)]">·</span>
              <span className="inline-flex items-center gap-1 font-mono text-[11px] text-[var(--ui-text-muted)]">
                <GitBranch size={11} />
                <span>{gitStatus.branch}</span>
              </span>
            </>
          )}
          <span className="text-[var(--ui-text-faint)]">·</span>
          <span>
            {agentMode === "work"
              ? "原生办公文档解析生成、资料整理与连接器协同"
              : "多轮自主编码、符号索引、规格规划与并发子代理"}
          </span>
        </p>
      </div>

      {/* 2. 工作区快切卡 + 动态上下文延续条 */}
      <div className="flex flex-col gap-2">
        <div className="rounded-xl bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-hairline)] overflow-hidden">
          <div className="divide-y divide-[color:var(--ui-divider-hairline)]">
            {/* 无目录日常问答 */}
            <button
              type="button"
              onClick={() => handleSelectWorkspaceRow(null, null)}
              className="w-full px-3.5 py-2 flex items-center justify-between gap-2 text-left hover:bg-[var(--ui-card-hover-bg)] transition-colors cursor-pointer"
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <MessageSquare
                  size={13}
                  className={
                    !activeSession?.workDir && !activeSession?.workspaceId
                      ? "text-[var(--ui-accent-blue)] flex-shrink-0"
                      : "text-[var(--ui-text-muted)] flex-shrink-0"
                  }
                />
                <span className="text-xs font-medium text-[var(--ui-text-primary)] truncate">
                  日常问答
                </span>
                <span className="text-[11px] text-[var(--ui-text-faint)] truncate">
                  不绑定本地目录
                </span>
              </div>
              {!activeSession?.workDir && !activeSession?.workspaceId && (
                <Check size={13} className="text-[var(--ui-accent-blue)] flex-shrink-0" />
              )}
            </button>

            {/* 已有工作空间列表 */}
            {visibleWorkspaces.map((ws) => {
              const primary = ws.folders.find((f) => f.isPrimary) || ws.folders[0];
              const isSelected =
                matchedWorkspace?.id === ws.id ||
                (!matchedWorkspace && primary?.path && activeSession?.workDir === primary.path);
              return (
                <button
                  key={ws.id}
                  type="button"
                  onClick={() => handleSelectWorkspaceRow(ws.id, primary?.path || null)}
                  className="w-full px-3.5 py-2 flex items-center justify-between gap-2 text-left hover:bg-[var(--ui-card-hover-bg)] transition-colors cursor-pointer"
                  title={primary?.path || ws.name}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <FolderGit2
                      size={13}
                      className={
                        isSelected
                          ? "text-[var(--ui-accent-blue)] flex-shrink-0"
                          : "text-[var(--ui-text-muted)] flex-shrink-0"
                      }
                    />
                    <span className="text-xs font-medium text-[var(--ui-text-primary)] truncate">
                      {ws.name}
                    </span>
                    {primary?.path && (
                      <span className="text-[11px] font-mono text-[var(--ui-text-faint)] truncate">
                        {primary.path}
                      </span>
                    )}
                  </div>
                  {isSelected && (
                    <Check size={13} className="text-[var(--ui-accent-blue)] flex-shrink-0" />
                  )}
                </button>
              );
            })}
          </div>

          {/* 底部操作条 */}
          <div className="px-3.5 py-1.5 bg-[var(--ui-card-header-bg)] border-t border-[color:var(--ui-divider-hairline)] flex items-center justify-between text-[11px]">
            <button
              type="button"
              onClick={() => openWorkspaceModal()}
              className="inline-flex items-center gap-1.5 text-[var(--ui-text-secondary)] hover:text-[var(--ui-accent-blue)] transition-colors cursor-pointer"
            >
              <Plus size={12} />
              <span>{activeSession?.workDir ? "管理当前工作空间目录" : "绑定本地工作目录"}</span>
            </button>
            {workspaces.length > 4 && (
              <button
                type="button"
                onClick={() => setShowAllWorkspaces((prev) => !prev)}
                className="text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] transition-colors cursor-pointer"
              >
                {showAllWorkspaces ? "收起" : `全部 ${workspaces.length} 个工作空间`}
              </button>
            )}
          </div>
        </div>

        {/* 动态上下文延续条：未提交 Git 改动 */}
        {hasUncommittedGit && gitStatus && (
          <button
            type="button"
            onClick={handleContinueUncommitted}
            className="w-full px-3.5 py-2 rounded-xl bg-[var(--ui-card-bg)] hover:bg-[var(--ui-card-hover-bg)] border border-[color:var(--ui-border-hairline)] flex items-center justify-between gap-2 text-xs transition-colors cursor-pointer group"
          >
            <div className="flex items-center gap-2 min-w-0">
              <FileText size={13} className="text-[var(--ui-accent-amber)] flex-shrink-0" />
              <span className="text-[var(--ui-text-primary)] font-medium truncate">
                继续处理未提交改动
              </span>
              <span className="text-[11px] text-[var(--ui-text-muted)] flex-shrink-0">
                {gitStatus.modifiedFiles.length} 个文件
              </span>
              {(gitStatus.insertions > 0 || gitStatus.deletions > 0) && (
                <span className="text-[11px] font-mono flex items-center gap-1 flex-shrink-0">
                  <span className="text-emerald-500">+{gitStatus.insertions}</span>
                  <span className="text-rose-500">-{gitStatus.deletions}</span>
                </span>
              )}
            </div>
            <ArrowRight
              size={13}
              className="text-[var(--ui-text-faint)] group-hover:text-[var(--ui-text-primary)] group-hover:translate-x-0.5 transition-all flex-shrink-0"
            />
          </button>
        )}

        {/* 动态上下文延续条：定时任务收件箱未读 */}
        {unreadAutomationRuns > 0 && (
          <button
            type="button"
            onClick={() => {
              setActiveView("chat");
              setActiveNavTab("automations");
            }}
            className="w-full px-3.5 py-2 rounded-xl bg-[var(--ui-accent-blue-soft)] hover:opacity-90 border border-[color:var(--ui-accent-blue-border)] flex items-center justify-between gap-2 text-xs transition-opacity cursor-pointer group"
          >
            <div className="flex items-center gap-2 min-w-0">
              <CalendarClock size={13} className="text-[var(--ui-accent-blue)] flex-shrink-0" />
              <span className="text-[var(--ui-text-primary)] font-medium truncate">
                有 {unreadAutomationRuns} 条定时任务结果待审阅
              </span>
            </div>
            <ArrowRight
              size={13}
              className="text-[var(--ui-accent-blue)] group-hover:translate-x-0.5 transition-transform flex-shrink-0"
            />
          </button>
        )}
      </div>

      {/* 3. 本地会话活跃热力图（近 16 周纯本地数据） */}
      <div className="rounded-xl bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-hairline)] px-3.5 py-2.5 flex flex-col gap-2">
        <div className="flex items-center justify-between text-[11px]">
          <div className="flex items-center gap-2">
            <span className="font-medium text-[var(--ui-text-secondary)]">本地会话活跃度</span>
            <span className="text-[var(--ui-text-faint)]">
              近 16 周 {heatmapData.totalRecentCount} 次任务
            </span>
          </div>
          <div className="flex items-center gap-2 text-[var(--ui-text-muted)]">
            <span>{enabledSkillsCount} 技能</span>
            <span className="text-[var(--ui-text-faint)]">·</span>
            <span>{enabledMcpsCount} 连接器</span>
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <div className="grid gap-[3px]" style={{ gridTemplateColumns: "repeat(16, minmax(0, 1fr))" }}>
            {heatmapData.weeks.map((week, wIdx) => (
              <div key={wIdx} className="flex flex-col gap-[3px]">
                {week.days.map((day) => (
                  <div
                    key={day.key}
                    title={day.future ? "" : `${day.key} · ${day.count} 次任务`}
                    className={`w-full aspect-square rounded-[2px] transition-colors ${getHeatCellClass(
                      day.count,
                      day.future
                    )}`}
                  />
                ))}
              </div>
            ))}
          </div>
          <div
            className="grid gap-[3px] text-[10px] text-[var(--ui-text-faint)] pt-0.5"
            style={{ gridTemplateColumns: "repeat(16, minmax(0, 1fr))" }}
          >
            {heatmapData.weeks.map((week, wIdx) => (
              <div key={wIdx} className="truncate leading-none">
                {week.monthLabel || ""}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 4. 按 Code / Work 模式自适应的 4 枚起手任务卡 */}
      <div className="grid grid-cols-2 gap-2">
        {starters.map((card) => (
          <button
            key={card.id}
            type="button"
            onClick={() => onPrefillPrompt(card.prompt)}
            className="p-2.5 rounded-xl bg-[var(--ui-card-bg)] hover:bg-[var(--ui-card-hover-bg)] border border-[color:var(--ui-border-hairline)] text-left flex flex-col gap-1 transition-colors cursor-pointer group"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--ui-text-primary)]">
                <span className="text-[var(--ui-accent-blue)] group-hover:scale-105 transition-transform">
                  {card.icon}
                </span>
                <span>{card.title}</span>
              </div>
              {card.tag && (
                <span className="px-1.5 py-0.5 rounded bg-[var(--ui-chip-bg)] text-[10px] font-mono text-[var(--ui-text-muted)]">
                  {card.tag}
                </span>
              )}
            </div>
            <p className="text-[11px] text-[var(--ui-text-muted)] leading-snug line-clamp-1">
              {card.desc}
            </p>
          </button>
        ))}
      </div>

      {/* 5. 底部轻量快捷键与能力提示 */}
      <div className="flex items-center justify-center flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--ui-text-faint)] pt-0.5">
        <button
          type="button"
          onClick={() => onPrefillPrompt("@", { trigger: "@" })}
          className="hover:text-[var(--ui-text-primary)] transition-colors cursor-pointer"
        >
          <span className="font-mono text-[var(--ui-text-secondary)]">@</span> 引用文件/技能/子代理
        </button>
        <span>·</span>
        <button
          type="button"
          onClick={() => onPrefillPrompt("/", { trigger: "/" })}
          className="hover:text-[var(--ui-text-primary)] transition-colors cursor-pointer"
        >
          <span className="font-mono text-[var(--ui-text-secondary)]">/</span> 斜杠命令
        </button>
        <span>·</span>
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent("omcx-open-command-palette"))}
          className="hover:text-[var(--ui-text-primary)] transition-colors cursor-pointer"
        >
          <span className="font-mono text-[var(--ui-text-secondary)]">⌘K</span> 全局搜索
        </button>
        {onOpenInspector && (
          <>
            <span>·</span>
            <button
              type="button"
              onClick={onOpenInspector}
              className="hover:text-[var(--ui-text-primary)] transition-colors cursor-pointer"
            >
              右栏 产物与连接器
            </button>
          </>
        )}
      </div>
    </div>
  );
};

export default EmptySessionWelcome;
