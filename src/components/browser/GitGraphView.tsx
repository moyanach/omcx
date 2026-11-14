import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  AlertCircle,
  Archive,
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  ChevronDown,
  Copy,
  Download,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  Loader2,
  RefreshCw,
  Search,
  Undo2,
  X,
} from "lucide-react";
import { useChatStore } from "@/stores/chatStore";

import {
  CommitDetail,
  GitGraphCommit,
  GRAPH_PAD_X,
  LANE_WIDTH,
  ROW_HEIGHT,
  WorkingTreeChanges,
  buildGraphLayout,
} from "./gitGraph/graphLayout";
import { UncommittedChangesRow } from "./gitGraph/UncommittedChangesRow";
import { GraphCommitRow } from "./gitGraph/GraphCommitRow";
import { CommitDetailDrawer } from "./gitGraph/CommitDetailDrawer";

export const GitGraphView: React.FC<{ refreshKey?: number }> = ({ refreshKey }) => {
  const {
    sessions,
    activeSessionId,
    workspaces,
    activeWorkspaceId,
    fetchWorkspaces,
    refreshGitStatus,
    notifyGitUpdated,
  } = useChatStore(
    useShallow((s) => ({
      sessions: s.sessions,
      activeSessionId: s.activeSessionId,
      workspaces: s.workspaces,
      activeWorkspaceId: s.activeWorkspaceId,
      fetchWorkspaces: s.fetchWorkspaces,
      refreshGitStatus: s.refreshGitStatus,
      notifyGitUpdated: s.notifyGitUpdated,
    }))
  );
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const sessionWorkDir = activeSession?.workDir || "";

  useEffect(() => {
    fetchWorkspaces();
  }, [fetchWorkspaces]);

  // 解析当前工作空间多目录（主目录优先）
  const workspaceFolders = useMemo(() => {
    const matchedWs = workspaces.find(
      (ws) =>
        ws.id === activeSession?.workspaceId ||
        ws.id === activeWorkspaceId ||
        ws.folders?.some((f) => f.path === sessionWorkDir)
    );
    if (matchedWs && Array.isArray(matchedWs.folders) && matchedWs.folders.length > 0) {
      return [...matchedWs.folders].sort((a, b) => Number(Boolean(b.isPrimary)) - Number(Boolean(a.isPrimary)));
    }
    if (sessionWorkDir) {
      return [
        {
          id: "session-root",
          name: sessionWorkDir.split(/[\\/]/).filter(Boolean).pop() || sessionWorkDir,
          path: sessionWorkDir,
          isPrimary: true,
        },
      ];
    }
    return [];
  }, [workspaces, activeSession?.workspaceId, activeWorkspaceId, sessionWorkDir]);

  const primaryDir = useMemo(() => {
    return (
      workspaceFolders.find((f) => f.isPrimary)?.path ||
      sessionWorkDir ||
      workspaceFolders[0]?.path ||
      ""
    );
  }, [workspaceFolders, sessionWorkDir]);

  const [selectedDir, setSelectedDir] = useState<string>(primaryDir);
  const [dirMenuOpen, setDirMenuOpen] = useState(false);
  const dirMenuRef = useRef<HTMLDivElement | null>(null);

  // 当切换会话或工作空间时，若当前选中目录不在新工作空间内则重置为主目录
  useEffect(() => {
    if (!selectedDir || !workspaceFolders.some((f) => f.path === selectedDir)) {
      setSelectedDir(primaryDir);
    }
  }, [workspaceFolders, primaryDir, selectedDir]);

  // 点击外部关闭目录切换浮层
  useEffect(() => {
    if (!dirMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (dirMenuRef.current && !dirMenuRef.current.contains(e.target as Node)) {
        setDirMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [dirMenuOpen]);

  const workDir = selectedDir || primaryDir;
  const activeFolder = workspaceFolders.find((f) => f.path === workDir);

  const [scope, setScope] = useState<"all" | "current">("all");
  const [limit, setLimit] = useState(150);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [isGit, setIsGit] = useState(true);
  const [currentBranch, setCurrentBranch] = useState("");
  const [uncommittedCount, setUncommittedCount] = useState(0);
  const [commits, setCommits] = useState<GitGraphCommit[]>([]);
  const [hasMore, setHasMore] = useState(false);

  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  // 工作区暂存 / 提交 / 同步 / 合并操作状态
  const [changesOpen, setChangesOpen] = useState(false);
  const [wtChanges, setWtChanges] = useState<WorkingTreeChanges>({
    staged: [],
    unstaged: [],
    stashCount: 0,
  });
  const [commitMsg, setCommitMsg] = useState("");
  const [opBusy, setOpBusy] = useState("");
  const [opBanner, setOpBanner] = useState<{ ok: boolean; text: string } | null>(null);

  // Merge 浮层状态
  const [mergeOpen, setMergeOpen] = useState(false);
  const [localBranches, setLocalBranches] = useState<string[]>([]);
  const [mergeSource, setMergeSource] = useState("");
  const mergeMenuRef = useRef<HTMLDivElement | null>(null);

  // 从提交创建分支状态
  const [branchAtHash, setBranchAtHash] = useState<string | null>(null);
  const [branchAtName, setBranchAtName] = useState("");

  useEffect(() => {
    if (!mergeOpen) return;
    const onDown = (e: MouseEvent) => {
      if (mergeMenuRef.current && !mergeMenuRef.current.contains(e.target as Node)) {
        setMergeOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [mergeOpen]);

  const fetchGraph = useCallback(async () => {
    if (!workDir || !window.electronAPI?.getWorkspaceGitGraph) {
      setIsGit(false);
      setCommits([]);
      setWtChanges({ staged: [], unstaged: [], stashCount: 0 });
      return;
    }
    setLoading(true);
    try {
      const [res, wtRes, brRes] = await Promise.all([
        window.electronAPI.getWorkspaceGitGraph(workDir, limit, scope),
        window.electronAPI.getWorkingTreeChanges
          ? window.electronAPI.getWorkingTreeChanges(workDir)
          : Promise.resolve(null),
        window.electronAPI.getWorkspaceBranches
          ? window.electronAPI.getWorkspaceBranches(workDir)
          : Promise.resolve(null),
      ]);
      if (!res?.isGit) {
        setIsGit(false);
        setCommits([]);
        setWtChanges({ staged: [], unstaged: [], stashCount: 0 });
      } else {
        setIsGit(true);
        setCurrentBranch(res.currentBranch || "");
        setUncommittedCount(Number(res.uncommittedCount) || 0);
        setCommits(Array.isArray(res.commits) ? res.commits : []);
        setHasMore(Boolean(res.hasMore));
        if (wtRes?.success) {
          setWtChanges({
            staged: Array.isArray(wtRes.staged) ? wtRes.staged : [],
            unstaged: Array.isArray(wtRes.unstaged) ? wtRes.unstaged : [],
            stashCount: Number(wtRes.stashCount) || 0,
          });
        }
        if (brRes?.success && Array.isArray(brRes.branches)) {
          setLocalBranches(brRes.branches.map((b: any) => b.name).filter(Boolean));
        }
      }
    } finally {
      setLoading(false);
    }
  }, [workDir, limit, scope]);

  const refreshAll = useCallback(async () => {
    await fetchGraph();
    if (workDir && refreshGitStatus) {
      refreshGitStatus(workDir);
    }
    notifyGitUpdated();
  }, [fetchGraph, workDir, refreshGitStatus, notifyGitUpdated]);

  const runGitAction = async (
    key: string,
    fn: () => Promise<any>,
    successFallback: string
  ) => {
    if (!workDir || opBusy) return;
    setOpBusy(key);
    setOpBanner(null);
    try {
      const res = await fn();
      if (res && res.success === false) {
        setOpBanner({ ok: false, text: res.error || "操作失败" });
        return false;
      }
      setOpBanner({ ok: true, text: res?.message || successFallback });
      await refreshAll();
      return true;
    } catch (err: any) {
      setOpBanner({ ok: false, text: err?.message || String(err) });
      return false;
    } finally {
      setOpBusy("");
    }
  };

  const handleStageFile = (filePath: string) =>
    runGitAction(`stage:${filePath}`, () => window.electronAPI.stageGitFile(workDir, filePath), `已暂存 ${filePath}`);

  const handleUnstageFile = (filePath: string) =>
    runGitAction(`unstage:${filePath}`, () => window.electronAPI.unstageGitFile(workDir, filePath), `已取消暂存 ${filePath}`);

  const handleStageAll = () =>
    runGitAction("stage-all", () => window.electronAPI.stageAllGitChanges(workDir), "已暂存全部变更");

  const handleDiscardFile = async (filePath: string) => {
    if (!window.confirm(`确认丢弃文件更改？\n\n${filePath}\n\n此操作不可恢复。`)) return;
    await runGitAction(`discard:${filePath}`, () => window.electronAPI.discardGitFile(workDir, filePath), `已丢弃 ${filePath} 的更改`);
  };

  const handleCommit = async (alsoPush = false) => {
    const msg = commitMsg.trim();
    if (!msg) {
      setOpBanner({ ok: false, text: "请输入提交信息" });
      return;
    }
    if (wtChanges.staged.length === 0 && wtChanges.unstaged.length > 0) {
      // 若暂存区为空但存在未暂存文件，先全部暂存再提交
      const stagedOk = await runGitAction("stage-all", () => window.electronAPI.stageAllGitChanges(workDir), "已全部暂存");
      if (!stagedOk) return;
    }
    const ok = await runGitAction(
      "commit",
      () => window.electronAPI.commitStagedGitChanges(workDir, msg),
      "提交成功"
    );
    if (ok) {
      setCommitMsg("");
      if (alsoPush) {
        await runGitAction("push", () => window.electronAPI.gitPush(workDir), "推送成功");
      }
    }
  };

  const handleConfirmMerge = async () => {
    if (!mergeSource) return;
    const ok = await runGitAction(
      "merge",
      () => window.electronAPI.gitMergeBranch(workDir, mergeSource),
      `已合并 ${mergeSource}`
    );
    if (ok) {
      setMergeOpen(false);
    }
  };

  const handleCreateBranchAtCommit = async () => {
    if (!branchAtHash || !branchAtName.trim()) return;
    const ok = await runGitAction(
      "create-branch-at",
      () => window.electronAPI.gitCreateBranchAt(workDir, branchAtName.trim(), branchAtHash),
      `已基于 ${branchAtHash.slice(0, 7)} 创建分支 ${branchAtName.trim()}`
    );
    if (ok) {
      setBranchAtHash(null);
      setBranchAtName("");
    }
  };

  useEffect(() => {
    fetchGraph();
  }, [fetchGraph, refreshKey]);

  const handleSelectCommit = async (hash: string) => {
    if (selectedHash === hash) {
      setSelectedHash(null);
      setDetail(null);
      return;
    }
    setSelectedHash(hash);
    if (!workDir || !window.electronAPI?.getWorkspaceGitCommitDetail) return;
    setLoadingDetail(true);
    try {
      const res = await window.electronAPI.getWorkspaceGitCommitDetail(workDir, hash);
      setDetail(res || null);
    } finally {
      setLoadingDetail(false);
    }
  };

  const filteredCommits = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commits;
    return commits.filter(
      (c) =>
        c.subject.toLowerCase().includes(q) ||
        c.author.toLowerCase().includes(q) ||
        c.shortHash.toLowerCase().includes(q) ||
        c.refs.some((r) => r.name.toLowerCase().includes(q))
    );
  }, [commits, query]);

  const laidOutRows = useMemo(() => buildGraphLayout(filteredCommits), [filteredCommits]);
  const maxLanes = useMemo(
    () => laidOutRows.reduce((acc, r) => Math.max(acc, r.maxLaneCount), 1),
    [laidOutRows]
  );
  const graphWidth = Math.max(36, GRAPH_PAD_X * 2 + (maxLanes - 1) * LANE_WIDTH + 8);
  const laneX = (laneIdx: number) => GRAPH_PAD_X + laneIdx * LANE_WIDTH;
  const midY = ROW_HEIGHT / 2;

  const handleSelectDir = (nextPath: string) => {
    setDirMenuOpen(false);
    if (nextPath === workDir) return;
    setSelectedDir(nextPath);
    setSelectedHash(null);
    setDetail(null);
  };

  if (!workDir && workspaceFolders.length === 0) {
    return (
      <div className="flex-1 h-full flex flex-col items-center justify-center gap-2 bg-[var(--ui-stage-bg)] text-[var(--ui-text-muted)] text-xs select-none p-6">
        <GitBranch size={28} className="opacity-35" />
        <span>请先为当前会话绑定工作目录</span>
      </div>
    );
  }

  return (
    <div className="flex-1 h-full flex flex-col overflow-hidden bg-[var(--ui-stage-bg)] select-none">
      {/* 顶部栏（左上角目录切换 + 纯只读控制） */}
      <div className="h-10 px-3 flex items-center gap-2 border-b border-[color:var(--ui-divider-hairline)] bg-[var(--ui-panel-bg)] backdrop-blur-md flex-shrink-0 relative z-20">
        {/* 左上角多目录切换器 */}
        <div ref={dirMenuRef} className="relative flex-shrink-0">
          {workspaceFolders.length > 1 ? (
            <button
              onClick={() => setDirMenuOpen((prev) => !prev)}
              className="h-7 px-2 rounded-lg bg-[var(--ui-chip-bg)] hover:bg-[var(--ui-chip-hover-bg)] border border-[color:var(--ui-border-hairline)] flex items-center gap-1.5 text-xs font-medium text-[var(--ui-text-primary)] transition-colors"
              title={workDir}
            >
              <FolderGit2 size={13} className="text-[var(--ui-accent-blue)] flex-shrink-0" />
              <span className="max-w-[110px] truncate">
                {activeFolder?.name || workDir.split(/[\\/]/).filter(Boolean).pop()}
              </span>
              {activeFolder?.isPrimary && (
                <span className="px-1 py-0 rounded text-[9px] bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)] font-mono">
                  主
                </span>
              )}
              <ChevronDown size={12} className="text-[var(--ui-text-muted)]" />
            </button>
          ) : (
            <div className="flex items-center gap-1.5 text-xs font-semibold text-[var(--ui-text-primary)]">
              <GitBranch size={13} className="text-[var(--ui-accent-blue)]" />
              <span>{activeFolder?.name || "Graph"}</span>
            </div>
          )}

          {dirMenuOpen && workspaceFolders.length > 1 && (
            <div className="absolute left-0 top-8 z-50 w-72 py-1.5 rounded-xl bg-[var(--ui-popover-bg)] backdrop-blur-xl backdrop-saturate-150 border border-[color:var(--ui-border-subtle)] shadow-[var(--ui-popover-shadow)]">
              <div className="px-3 py-1 text-[10px] font-mono text-[var(--ui-text-faint)] border-b border-[color:var(--ui-divider-hairline)] mb-1">
                工作空间目录 ({workspaceFolders.length})
              </div>
              <div className="max-h-60 overflow-y-auto custom-scrollbar">
                {workspaceFolders.map((folder) => {
                  const isActive = folder.path === workDir;
                  return (
                    <button
                      key={folder.path}
                      onClick={() => handleSelectDir(folder.path)}
                      className={`w-full px-3 py-1.5 text-left flex items-center gap-2 transition-colors ${
                        isActive
                          ? "bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)]"
                          : "hover:bg-[var(--ui-block-hover-bg)] text-[var(--ui-text-primary)]"
                      }`}
                    >
                      <FolderGit2 size={13} className="flex-shrink-0 opacity-80" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 text-xs font-medium">
                          <span className="truncate">{folder.name}</span>
                          {folder.isPrimary && (
                            <span className="px-1 rounded text-[9px] bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)] border border-[color:var(--ui-accent-blue-border)] font-mono flex-shrink-0">
                              主目录
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] font-mono text-[var(--ui-text-faint)] truncate">
                          {folder.path}
                        </div>
                      </div>
                      {isActive && <Check size={13} className="flex-shrink-0" />}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {currentBranch && isGit && (
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[var(--ui-chip-bg)] text-[var(--ui-text-muted)] border border-[color:var(--ui-border-hairline)] flex-shrink-0 max-w-[100px] truncate">
            {currentBranch}
          </span>
        )}

        {/* 范围切换：全部分支 vs 当前分支 */}
        <div className="flex items-center rounded-lg bg-[var(--ui-card-inner-bg)] p-0.5 border border-[color:var(--ui-border-hairline)] flex-shrink-0">
          <button
            onClick={() => setScope("all")}
            className={`px-2 py-0.5 rounded-md text-[10.5px] transition-colors ${
              scope === "all"
                ? "bg-[var(--ui-chip-hover-bg)] text-[var(--ui-text-primary)] font-medium"
                : "text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)]"
            }`}
          >
            全部分支
          </button>
          <button
            onClick={() => setScope("current")}
            className={`px-2 py-0.5 rounded-md text-[10.5px] transition-colors ${
              scope === "current"
                ? "bg-[var(--ui-chip-hover-bg)] text-[var(--ui-text-primary)] font-medium"
                : "text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)]"
            }`}
          >
            当前分支
          </button>
        </div>

        {/* 过滤搜索 */}
        <div className="ui-focus-ring flex-1 min-w-0 h-7 rounded-lg bg-[var(--ui-input-bg)] border border-[color:var(--ui-border-hairline)] flex items-center px-2 gap-1.5">
          <Search size={11.5} className="text-[var(--ui-text-faint)] flex-shrink-0" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="过滤分支、提交说明、作者..."
            className="flex-1 min-w-0 bg-transparent outline-none text-[11px] text-[var(--ui-text-primary)] placeholder:text-[var(--ui-text-faint)]"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              className="text-[var(--ui-text-faint)] hover:text-[var(--ui-text-primary)]"
            >
              <X size={11} />
            </button>
          )}
        </div>

        <button
          onClick={refreshAll}
          disabled={loading}
          className="p-1.5 rounded-lg text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-block-hover-bg)] transition-colors flex-shrink-0"
          title="刷新提交图谱"
        >
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {/* 独立 Git 操作工具栏（Fetch / Pull / Push / Merge / Stash / Add & Commit） */}
      {isGit && (
        <div className="px-3 py-1.5 flex items-center flex-wrap gap-1 border-b border-[color:var(--ui-divider-hairline)] bg-[var(--ui-panel-bg)]/70 backdrop-blur-md flex-shrink-0 relative z-10">
          <button
            onClick={() => setChangesOpen((v) => !v)}
            className={`h-6 px-2 rounded-md text-[10.5px] border flex items-center gap-1 transition-colors ${
              changesOpen
                ? "bg-[var(--ui-accent-blue-soft)] border-[color:var(--ui-accent-blue-border)] text-[var(--ui-accent-blue)] font-medium"
                : "bg-[var(--ui-chip-bg)] border-[color:var(--ui-border-hairline)] text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-chip-hover-bg)]"
            }`}
            title="展开/收起工作区暂存 (Add) 与提交 (Commit) 面板"
          >
            <GitCommitHorizontal size={11} />
            <span>Add / Commit</span>
            {(wtChanges.staged.length + wtChanges.unstaged.length || uncommittedCount) > 0 && (
              <span className="px-1 rounded-full bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)] text-[9.5px] font-mono">
                {wtChanges.staged.length + wtChanges.unstaged.length || uncommittedCount}
              </span>
            )}
          </button>

          <button
            onClick={() => runGitAction("fetch", () => window.electronAPI.gitFetch(workDir), "Fetch 完成")}
            disabled={Boolean(opBusy)}
            className="h-6 px-2 rounded-md text-[10.5px] bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)] text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-chip-hover-bg)] disabled:opacity-40 flex items-center gap-1 transition-colors"
            title="Fetch 同步远端分支"
          >
            {opBusy === "fetch" ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
            <span>Fetch</span>
          </button>

          <button
            onClick={() => runGitAction("pull", () => window.electronAPI.gitPull(workDir), "Pull 完成")}
            disabled={Boolean(opBusy)}
            className="h-6 px-2 rounded-md text-[10.5px] bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)] text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-chip-hover-bg)] disabled:opacity-40 flex items-center gap-1 transition-colors"
            title="Pull 拉取当前分支"
          >
            {opBusy === "pull" ? <Loader2 size={11} className="animate-spin" /> : <ArrowDownToLine size={11} />}
            <span>Pull</span>
          </button>

          <button
            onClick={() => runGitAction("push", () => window.electronAPI.gitPush(workDir), "Push 完成")}
            disabled={Boolean(opBusy)}
            className="h-6 px-2 rounded-md text-[10.5px] bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)] text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-chip-hover-bg)] disabled:opacity-40 flex items-center gap-1 transition-colors"
            title="Push 推送当前分支"
          >
            {opBusy === "push" ? <Loader2 size={11} className="animate-spin" /> : <ArrowUpFromLine size={11} />}
            <span>Push</span>
          </button>

          <div ref={mergeMenuRef} className="relative">
            <button
              onClick={() => {
                const candidates = localBranches.filter((b) => b !== currentBranch);
                setMergeSource((prev) => (candidates.includes(prev) ? prev : candidates[0] || ""));
                setMergeOpen((v) => !v);
              }}
              disabled={Boolean(opBusy) || localBranches.filter((b) => b !== currentBranch).length === 0}
              className="h-6 px-2 rounded-md text-[10.5px] bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)] text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-chip-hover-bg)] disabled:opacity-40 flex items-center gap-1 transition-colors"
              title="Merge 合并分支到当前分支"
            >
              {opBusy === "merge" ? <Loader2 size={11} className="animate-spin" /> : <GitMerge size={11} />}
              <span>Merge</span>
            </button>

            {mergeOpen && (
              <div className="absolute left-0 top-7 z-50 w-64 p-2.5 rounded-xl bg-[var(--ui-popover-bg)] backdrop-blur-xl backdrop-saturate-150 border border-[color:var(--ui-border-subtle)] shadow-[var(--ui-popover-shadow)] space-y-2">
                <div className="text-[11px] font-medium text-[var(--ui-text-primary)]">
                  合并到 <span className="font-mono text-[var(--ui-accent-blue)]">{currentBranch || "当前分支"}</span>
                </div>
                <div className="max-h-40 overflow-y-auto custom-scrollbar space-y-0.5">
                  {localBranches
                    .filter((b) => b !== currentBranch)
                    .map((b) => (
                      <button
                        key={b}
                        onClick={() => setMergeSource(b)}
                        className={`w-full px-2 py-1 rounded-md text-left text-[11px] font-mono flex items-center justify-between transition-colors ${
                          mergeSource === b
                            ? "bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)]"
                            : "text-[var(--ui-text-secondary)] hover:bg-[var(--ui-block-hover-bg)]"
                        }`}
                      >
                        <span className="truncate">{b}</span>
                        {mergeSource === b && <Check size={11} />}
                      </button>
                    ))}
                </div>
                <div className="flex items-center justify-end gap-1.5 pt-1 border-t border-[color:var(--ui-divider-hairline)]">
                  <button
                    onClick={() => setMergeOpen(false)}
                    className="px-2 py-1 rounded text-[10.5px] text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)]"
                  >
                    取消
                  </button>
                  <button
                    onClick={handleConfirmMerge}
                    disabled={!mergeSource || Boolean(opBusy)}
                    className="px-2.5 py-1 rounded bg-[var(--ui-accent-blue-soft)] border border-[color:var(--ui-accent-blue-border)] text-[10.5px] font-medium text-[var(--ui-accent-blue)] hover:brightness-110 disabled:opacity-50"
                  >
                    确认合并
                  </button>
                </div>
              </div>
            )}
          </div>

          {uncommittedCount > 0 && (
            <button
              onClick={() => runGitAction("stash-push", () => window.electronAPI.gitStashAction(workDir, "push"), "已 Stash 暂存")}
              disabled={Boolean(opBusy)}
              className="h-6 px-2 rounded-md text-[10.5px] bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)] text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-chip-hover-bg)] disabled:opacity-40 flex items-center gap-1 transition-colors"
              title="Stash 暂存当前未提交改动"
            >
              {opBusy === "stash-push" ? <Loader2 size={11} className="animate-spin" /> : <Archive size={11} />}
              <span>Stash</span>
            </button>
          )}
          {wtChanges.stashCount > 0 && (
            <button
              onClick={() => runGitAction("stash-pop", () => window.electronAPI.gitStashAction(workDir, "pop"), "已恢复 Stash")}
              disabled={Boolean(opBusy)}
              className="h-6 px-2 rounded-md text-[10.5px] bg-[var(--ui-accent-blue-soft)] border border-[color:var(--ui-accent-blue-border)] text-[var(--ui-accent-blue)] hover:brightness-110 disabled:opacity-40 flex items-center gap-1 transition-colors"
              title={`Stash Pop 恢复最新暂存（共 ${wtChanges.stashCount} 条）`}
            >
              {opBusy === "stash-pop" ? <Loader2 size={11} className="animate-spin" /> : <Undo2 size={11} />}
              <span>Pop({wtChanges.stashCount})</span>
            </button>
          )}

          {/* 选中提交的操作按钮（统一收拢到顶部工具栏） */}
          <div className="h-3.5 w-px bg-[var(--ui-divider-hairline)] mx-0.5 flex-shrink-0" />

          <button
            onClick={() => {
              if (!selectedHash) return;
              setBranchAtHash((prev) => (prev === selectedHash ? null : selectedHash));
              setBranchAtName("");
            }}
            disabled={!selectedHash || Boolean(opBusy)}
            className={`h-6 px-2 rounded-md text-[10.5px] border flex items-center gap-1 transition-colors disabled:opacity-40 ${
              branchAtHash && branchAtHash === selectedHash
                ? "bg-[var(--ui-accent-blue-soft)] border-[color:var(--ui-accent-blue-border)] text-[var(--ui-accent-blue)] font-medium"
                : "bg-[var(--ui-chip-bg)] border-[color:var(--ui-border-hairline)] text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-chip-hover-bg)]"
            }`}
            title={selectedHash ? `基于提交 ${selectedHash.slice(0, 7)} 新建分支并切换` : "请先在下方图谱选中一个提交"}
          >
            <GitBranch size={11} />
            <span>建分支</span>
          </button>

          <button
            onClick={() =>
              selectedHash &&
              runGitAction(
                "cherry-pick",
                () => window.electronAPI.gitCherryPick(workDir, selectedHash),
                `已 Cherry-pick ${selectedHash.slice(0, 7)}`
              )
            }
            disabled={!selectedHash || Boolean(opBusy)}
            className="h-6 px-2 rounded-md text-[10.5px] bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)] text-[var(--ui-text-secondary)] hover:text-[var(--ui-accent-blue)] hover:bg-[var(--ui-chip-hover-bg)] disabled:opacity-40 flex items-center gap-1 transition-colors"
            title={selectedHash ? `将提交 ${selectedHash.slice(0, 7)} Cherry-pick 到当前分支` : "请先在下方图谱选中一个提交"}
          >
            {opBusy === "cherry-pick" ? <Loader2 size={11} className="animate-spin" /> : <GitCommitHorizontal size={11} />}
            <span>Cherry-pick</span>
          </button>

          <button
            onClick={() => {
              if (!selectedHash) return;
              navigator.clipboard?.writeText(selectedHash);
              setOpBanner({ ok: true, text: `已复制 Hash：${selectedHash.slice(0, 7)}` });
            }}
            disabled={!selectedHash}
            className="h-6 px-2 rounded-md text-[10.5px] bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)] text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-chip-hover-bg)] disabled:opacity-40 flex items-center gap-1 transition-colors"
            title={selectedHash ? `复制完整 Commit Hash (${selectedHash.slice(0, 7)})` : "请先在下方图谱选中一个提交"}
          >
            <Copy size={11} />
            <span>复制</span>
          </button>
        </div>
      )}

      {/* 顶部工具栏内展开的「基于选中提交建分支」输入条 */}
      {isGit && branchAtHash && (
        <div className="px-3 py-1.5 border-b border-[color:var(--ui-divider-hairline)] bg-[var(--ui-block-bg)] flex items-center gap-1.5 flex-shrink-0">
          <input
            type="text"
            value={branchAtName}
            onChange={(e) => setBranchAtName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreateBranchAtCommit();
              if (e.key === "Escape") setBranchAtHash(null);
            }}
            autoFocus
            placeholder={`输入基于 ${branchAtHash.slice(0, 7)} 的新分支名...`}
            className="flex-1 h-6 px-2 rounded bg-[var(--ui-input-bg)] border border-[color:var(--ui-border-hairline)] text-[10.5px] font-mono text-[var(--ui-text-primary)] outline-none"
          />
          <button
            onClick={handleCreateBranchAtCommit}
            disabled={!branchAtName.trim() || Boolean(opBusy)}
            className="h-6 px-2 rounded bg-[var(--ui-accent-blue-soft)] border border-[color:var(--ui-accent-blue-border)] text-[10px] text-[var(--ui-accent-blue)] disabled:opacity-40"
          >
            创建
          </button>
          <button
            onClick={() => setBranchAtHash(null)}
            className="h-6 px-1.5 text-[10px] text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)]"
          >
            取消
          </button>
        </div>
      )}

      {/* 操作反馈横条 */}
      {opBanner && (
        <div
          className={`px-3 py-1.5 text-[11px] flex items-center justify-between gap-2 border-b border-[color:var(--ui-divider-hairline)] flex-shrink-0 ${
            opBanner.ok
              ? "bg-[var(--ui-accent-emerald-soft)] text-[var(--ui-accent-emerald)]"
              : "bg-rose-500/10 text-rose-400"
          }`}
        >
          <div className="flex items-center gap-1.5 min-w-0">
            {opBanner.ok ? <Check size={12} className="flex-shrink-0" /> : <AlertCircle size={12} className="flex-shrink-0" />}
            <span className="truncate" title={opBanner.text}>
              {opBanner.text}
            </span>
          </div>
          <button onClick={() => setOpBanner(null)} className="opacity-70 hover:opacity-100 flex-shrink-0">
            <X size={11} />
          </button>
        </div>
      )}

      {/* 主图谱列表 */}
      {!isGit ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-[var(--ui-text-muted)] text-xs p-6">
          <GitBranch size={26} className="opacity-35" />
          <span>当前目录不是 Git 仓库，可在左上角切换其他目录</span>
          <span className="text-[10.5px] font-mono text-[var(--ui-text-faint)] max-w-full truncate">
            {workDir}
          </span>
        </div>
      ) : (
      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
        {/* Uncommitted Changes 首行（存在未提交变更时展示，可点击展开进行 Add / Commit） */}
        {(uncommittedCount > 0 || wtChanges.staged.length > 0 || wtChanges.unstaged.length > 0) && !query.trim() && (
          <UncommittedChangesRow
            graphWidth={graphWidth}
            laneX={laneX}
            midY={midY}
            changesOpen={changesOpen}
            setChangesOpen={setChangesOpen}
            uncommittedCount={uncommittedCount}
            wtChanges={wtChanges}
            opBusy={opBusy}
            commitMsg={commitMsg}
            setCommitMsg={setCommitMsg}
            handleStageAll={handleStageAll}
            handleStageFile={handleStageFile}
            handleUnstageFile={handleUnstageFile}
            handleDiscardFile={handleDiscardFile}
            handleCommit={handleCommit}
          />
        )}

        {loading && commits.length === 0 ? (
          <div className="h-48 flex items-center justify-center gap-2 text-xs text-[var(--ui-text-muted)]">
            <Loader2 size={15} className="animate-spin" />
            <span>正在加载多分支提交图谱...</span>
          </div>
        ) : laidOutRows.length === 0 ? (
          <div className="h-48 flex items-center justify-center text-xs text-[var(--ui-text-faint)]">
            {query ? "无匹配的提交记录" : "暂无提交记录"}
          </div>
        ) : (
          laidOutRows.map((row) => (
            <GraphCommitRow
              key={row.commit.hash}
              row={row}
              isSelected={selectedHash === row.commit.hash}
              graphWidth={graphWidth}
              midY={midY}
              laneX={laneX}
              opBusy={opBusy}
              workDir={workDir}
              onSelectCommit={handleSelectCommit}
              onSwitchBranch={(checkoutTarget) =>
                runGitAction(
                  `checkout:${checkoutTarget}`,
                  () => window.electronAPI.checkoutWorkspaceBranch(workDir, checkoutTarget, false),
                  `已切换到分支 ${checkoutTarget}`
                )
              }
            />
          ))
        )}

        {hasMore && !query.trim() && (
          <div className="py-2.5 flex justify-center">
            <button
              onClick={() => setLimit((prev) => prev + 150)}
              disabled={loading}
              className="px-3 py-1 rounded-lg bg-[var(--ui-chip-bg)] hover:bg-[var(--ui-chip-hover-bg)] border border-[color:var(--ui-border-hairline)] text-[11px] text-[var(--ui-text-secondary)] transition-colors"
            >
              加载更多提交
            </button>
          </div>
        )}
      </div>
      )}


      {/* 底部只读提交详情抽屉 */}
      {selectedHash && (
        <CommitDetailDrawer
          selectedHash={selectedHash}
          detail={detail}
          loadingDetail={loadingDetail}
          onClose={() => {
            setSelectedHash(null);
            setDetail(null);
            setBranchAtHash(null);
          }}
        />
      )}
    </div>
  );
};

export default GitGraphView;
