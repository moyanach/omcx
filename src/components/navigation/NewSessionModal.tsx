import React, { useCallback, useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  Check,
  FolderGit2,
  GitBranch,
  GitFork,
  Info,
  Loader2,
  MessageSquarePlus,
  X,
} from 'lucide-react';
import { useChatStore } from '@/stores/chatStore';
import { ThemedSelect, type SelectOption } from '@/components/common/ThemedSelect';

type NewSessionTab = 'direct' | 'branch' | 'worktree';

export interface RequestNewSessionOptions {
  workspaceId?: string;
  workDir?: string;
  model?: string;
  onCreated?: (sessionId: string) => void;
}

interface DirCheckItem {
  path: string;
  name: string;
  isPrimary?: boolean;
  isGit: boolean;
  repoRoot?: string;
  currentBranch?: string;
  error?: string;
}

interface PendingNewSessionState {
  workspaceId?: string;
  workspaceName: string;
  workDir: string;
  model?: string;
  folders: Array<{ path: string; name: string; isPrimary?: boolean }>;
  onCreated?: (sessionId: string) => void;
}

const TAB_ITEMS: Array<{ id: NewSessionTab; label: string; icon: React.ReactNode }> = [
  { id: 'direct', label: '直接新建', icon: <MessageSquarePlus size={13} /> },
  { id: 'branch', label: '新建分支', icon: <GitBranch size={13} /> },
  { id: 'worktree', label: '新建 Worktree', icon: <GitFork size={13} /> },
];

export function useNewSessionModal() {
  const { sessions, activeSessionId, activeWorkspaceId, workspaces, addSession, notifyGitUpdated } = useChatStore(
    useShallow((s) => ({
      sessions: s.sessions,
      activeSessionId: s.activeSessionId,
      activeWorkspaceId: s.activeWorkspaceId,
      workspaces: s.workspaces,
      addSession: s.addSession,
      notifyGitUpdated: s.notifyGitUpdated,
    }))
  );

  const [pending, setPending] = useState<PendingNewSessionState | null>(null);
  const [activeTab, setActiveTab] = useState<NewSessionTab>('direct');
  const [inspecting, setInspecting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  // Git 信息状态
  const [branches, setBranches] = useState<string[]>([]);
  const [currentMainBranch, setCurrentMainBranch] = useState('');
  const [dirChecks, setDirChecks] = useState<DirCheckItem[]>([]);

  // 「新建分支」表单
  const [newBranchName, setNewBranchName] = useState('');
  const [baseBranch, setBaseBranch] = useState('');

  // 「新建 Worktree」表单
  const [wtBranchName, setWtBranchName] = useState('');
  const [wtBaseBranch, setWtBaseBranch] = useState('');
  const [selectedWtPaths, setSelectedWtPaths] = useState<string[]>([]);

  const loadGitContext = useCallback(
    async (
      workDir: string,
      folders: Array<{ path: string; name: string; isPrimary?: boolean }>
    ) => {
      if (!workDir && folders.length === 0) {
        setBranches([]);
        setCurrentMainBranch('');
        setDirChecks([]);
        setSelectedWtPaths([]);
        return;
      }

      setInspecting(true);
      try {
        const folderTargets =
          folders.length > 0
            ? folders
            : [
                {
                  path: workDir,
                  name: workDir.split(/[\\/]/).filter(Boolean).pop() || workDir,
                  isPrimary: true,
                },
              ];

        const [branchRes, dirRes] = await Promise.all([
          workDir && window.electronAPI?.listGitBranches
            ? window.electronAPI.listGitBranches(workDir).catch(() => null)
            : Promise.resolve(null),
          window.electronAPI?.inspectGitDirectories
            ? window.electronAPI.inspectGitDirectories(folderTargets).catch(() => null)
            : Promise.resolve(null),
        ]);

        const branchList =
          branchRes?.success && Array.isArray(branchRes.branches) ? branchRes.branches : [];
        const currentBranch = branchRes?.currentMainBranch || branchList[0] || '';
        setBranches(branchList);
        setCurrentMainBranch(currentBranch);
        setBaseBranch(currentBranch);
        setWtBaseBranch('');

        if (dirRes?.success && Array.isArray(dirRes.folders)) {
          const checked: DirCheckItem[] = dirRes.folders;
          setDirChecks(checked);
          setSelectedWtPaths(checked.filter((d) => d.isGit).map((d) => d.path));
        } else {
          const isGitRepo = Boolean(branchRes?.success && branchList.length > 0);
          const fallback: DirCheckItem[] = folderTargets.map((f) => ({
            path: f.path,
            name: f.name,
            isPrimary: f.isPrimary,
            isGit: isGitRepo,
            currentBranch,
          }));
          setDirChecks(fallback);
          setSelectedWtPaths(isGitRepo ? fallback.map((d) => d.path) : []);
        }
      } finally {
        setInspecting(false);
      }
    },
    []
  );

  const requestNewSession = useCallback(
    (options?: RequestNewSessionOptions) => {
      const activeSession = sessions.find((s) => s.id === activeSessionId);
      const targetWorkspaceId = options?.workspaceId ?? activeWorkspaceId ?? activeSession?.workspaceId;
      const targetWorkspace = targetWorkspaceId
        ? workspaces.find((w) => w.id === targetWorkspaceId)
        : undefined;

      const wsPrimaryFolder =
        targetWorkspace?.folders?.find((f) => f.isPrimary) || targetWorkspace?.folders?.[0];
      const resolvedWorkDir =
        options?.workDir ?? wsPrimaryFolder?.path ?? activeSession?.workDir ?? '';
      const resolvedFolders = targetWorkspace?.folders?.length
        ? targetWorkspace.folders
        : resolvedWorkDir
          ? [
              {
                path: resolvedWorkDir,
                name: resolvedWorkDir.split(/[\\/]/).filter(Boolean).pop() || resolvedWorkDir,
                isPrimary: true,
              },
            ]
          : [];

      const workspaceName =
        targetWorkspace?.name ||
        (resolvedWorkDir
          ? resolvedWorkDir.split(/[\\/]/).filter(Boolean).pop() || resolvedWorkDir
          : '默认会话（未绑定工作区）');

      setActiveTab('direct');
      setErrorMsg('');
      setNewBranchName('');
      setWtBranchName('');
      setBaseBranch('');
      setWtBaseBranch('');
      setBranches([]);
      setCurrentMainBranch('');
      setDirChecks([]);
      setSelectedWtPaths([]);

      setPending({
        workspaceId: targetWorkspaceId,
        workspaceName,
        workDir: resolvedWorkDir,
        model: options?.model ?? activeSession?.model,
        folders: resolvedFolders,
        onCreated: options?.onCreated,
      });

      void loadGitContext(resolvedWorkDir, resolvedFolders);
    },
    [activeSessionId, activeWorkspaceId, loadGitContext, sessions, workspaces]
  );

  const closeModal = useCallback(() => {
    if (submitting) return;
    setPending(null);
    setErrorMsg('');
  }, [submitting]);

  const toggleWtPath = (targetPath: string) => {
    setSelectedWtPaths((prev) =>
      prev.includes(targetPath) ? prev.filter((p) => p !== targetPath) : [...prev, targetPath]
    );
  };

  const handleConfirm = useCallback(async () => {
    if (!pending || submitting) return;
    setErrorMsg('');

    if (activeTab === 'direct') {
      setSubmitting(true);
      try {
        const createdId = await addSession({
          workspaceId: pending.workspaceId,
          workDir: pending.workDir || undefined,
          model: pending.model,
        });
        const cb = pending.onCreated;
        setPending(null);
        if (createdId && cb) cb(createdId);
      } catch (err: any) {
        setErrorMsg(err?.message || '新建会话失败');
      } finally {
        setSubmitting(false);
      }
      return;
    }

    if (activeTab === 'branch') {
      const targetBranch = newBranchName.trim();
      if (!pending.workDir) {
        setErrorMsg('当前未绑定工作目录，请先使用「直接新建」');
        return;
      }
      if (!targetBranch) {
        setErrorMsg('请输入新分支名称');
        return;
      }
      if (!window.electronAPI?.gitCreateBranchAt) {
        setErrorMsg('当前版本不支持创建分支接口');
        return;
      }

      setSubmitting(true);
      try {
        const res = await window.electronAPI.gitCreateBranchAt(
          pending.workDir,
          targetBranch,
          baseBranch || currentMainBranch || 'HEAD'
        );
        if (!res?.success) {
          setErrorMsg(res?.error || '创建并切换分支失败');
          return;
        }
        notifyGitUpdated();
        const createdId = await addSession({
          workspaceId: pending.workspaceId,
          workDir: pending.workDir,
          model: pending.model,
        });
        const cb = pending.onCreated;
        setPending(null);
        if (createdId && cb) cb(createdId);
      } catch (err: any) {
        setErrorMsg(err?.message || '创建分支失败');
      } finally {
        setSubmitting(false);
      }
      return;
    }

    // activeTab === 'worktree'
    const validGitDirs = dirChecks.filter((d) => d.isGit);
    if (validGitDirs.length === 0) {
      setErrorMsg('当前工作空间下没有有效的 Git 仓库，无法创建 Worktree');
      return;
    }

    const isMultiMode = pending.folders.length > 1;
    if (isMultiMode) {
      const chosen = validGitDirs.filter((d) => selectedWtPaths.includes(d.path));
      if (chosen.length === 0) {
        setErrorMsg('请至少选择一个有效的 Git 目录');
        return;
      }
      if (!window.electronAPI?.createMultiGitWorktrees) {
        setErrorMsg('当前版本不支持多目录 Worktree 创建接口');
        return;
      }
      setSubmitting(true);
      try {
        const res = await window.electronAPI.createMultiGitWorktrees({
          folders: chosen.map((d) => ({ path: d.path, name: d.name, isPrimary: d.isPrimary })),
          branch: wtBranchName.trim(),
          base: wtBaseBranch.trim() || 'HEAD',
        });
        if (!res?.success) {
          setErrorMsg(res?.error || '批量创建 Worktree 失败');
          return;
        }
        const createdItems = Array.isArray(res.items) ? res.items : [];
        const primaryItem = createdItems.find((i: any) => i.isPrimary) || createdItems[0];
        if (!primaryItem?.worktreePath) {
          setErrorMsg('Worktree 创建成功但未返回有效路径');
          return;
        }
        const createdId = await addSession({
          workDir: primaryItem.worktreePath,
          model: pending.model,
        });
        if (createdId && window.electronAPI?.saveSessionWorktreeGroup) {
          await window.electronAPI.saveSessionWorktreeGroup(createdId, createdItems);
        }
        const cb = pending.onCreated;
        setPending(null);
        if (createdId && cb) cb(createdId);
      } catch (err: any) {
        setErrorMsg(err?.message || '创建 Worktree 失败');
      } finally {
        setSubmitting(false);
      }
      return;
    }

    // 单目录 Worktree 创建
    const targetDir = validGitDirs[0].path || pending.workDir;
    if (!window.electronAPI?.createGitWorktree) {
      setErrorMsg('当前版本不支持创建 Worktree 接口');
      return;
    }
    setSubmitting(true);
    try {
      const res = await window.electronAPI.createGitWorktree({
        workDir: targetDir,
        branch: wtBranchName.trim(),
        base: wtBaseBranch.trim() || 'HEAD',
      });
      if (!res?.success) {
        setErrorMsg(res?.error || '创建 Worktree 失败');
        return;
      }
      const createdId = await addSession({
        workDir: res.path,
        model: pending.model,
      });
      const cb = pending.onCreated;
      setPending(null);
      if (createdId && cb) cb(createdId);
    } catch (err: any) {
      setErrorMsg(err?.message || '创建 Worktree 失败');
    } finally {
      setSubmitting(false);
    }
  }, [
    activeTab,
    addSession,
    baseBranch,
    currentMainBranch,
    dirChecks,
    newBranchName,
    pending,
    selectedWtPaths,
    submitting,
    wtBaseBranch,
    wtBranchName,
  ]);

  // 键盘快捷操作：Esc 关闭，直接新建 Tab 下 Enter 快捷确认
  useEffect(() => {
    if (!pending) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeModal();
      } else if (e.key === 'Enter' && activeTab === 'direct' && !submitting) {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
          e.preventDefault();
          void handleConfirm();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeTab, closeModal, handleConfirm, pending, submitting]);

  const validGitDirs = dirChecks.filter((d) => d.isGit);
  const hasGitRepo = validGitDirs.length > 0 && branches.length > 0;
  const isMultiFolders = (pending?.folders.length || 0) > 1;

  const baseBranchOptions: SelectOption[] = branches.map((b) => ({
    value: b,
    label: b === currentMainBranch ? `${b}（当前分支）` : b,
  }));

  const wtBaseOptions: SelectOption[] = [
    {
      value: '',
      label: currentMainBranch ? `当前 HEAD (${currentMainBranch})` : '当前 HEAD',
    },
    ...branches.map((b) => ({ value: b, label: b })),
  ];

  const newSessionModal = pending ? (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-sm p-4 titlebar-no-drag"
      onClick={closeModal}
    >
      <div
        className="w-full max-w-md rounded-xl border border-[color:var(--ui-border-subtle)] bg-[var(--ui-panel-bg)] shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 弹窗标题栏 */}
        <div className="px-4 py-3 border-b border-[color:var(--ui-divider-hairline)] flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <MessageSquarePlus size={15} className="text-[var(--ui-accent-blue)] flex-shrink-0" />
            <span className="text-xs font-semibold text-[var(--ui-text-primary)] truncate">
              新建会话
            </span>
          </div>
          <button
            onClick={closeModal}
            disabled={submitting}
            className="p-1 rounded-md text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-chip-bg)] transition-colors disabled:opacity-40"
            title="关闭"
          >
            <X size={14} />
          </button>
        </div>

        <div className="p-4 space-y-3.5 text-xs">
          {/* 提醒条：新功能建议独立分支或 Worktree */}
          <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-[var(--ui-accent-blue-soft)] border border-[color:var(--ui-accent-blue-border)] text-[var(--ui-text-secondary)]">
            <Info size={14} className="text-[var(--ui-accent-blue)] flex-shrink-0 mt-0.5" />
            <div className="text-[11px] leading-relaxed">
              开发新功能或实验性改动时，建议先<strong className="text-[var(--ui-text-primary)]">新建分支</strong>或使用
              <strong className="text-[var(--ui-text-primary)]"> Worktree </strong>隔离工作区，避免直接修改主分支。
            </div>
          </div>

          {/* 三个 Tab 切换 */}
          <div className="grid grid-cols-3 gap-1 p-1 rounded-lg bg-[var(--ui-block-bg)] border border-[color:var(--ui-border-hairline)]">
            {TAB_ITEMS.map((tab) => {
              const selected = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  disabled={submitting}
                  onClick={() => {
                    setActiveTab(tab.id);
                    setErrorMsg('');
                  }}
                  className={`flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-md text-[11px] font-medium transition-colors ${
                    selected
                      ? 'bg-[var(--ui-accent-blue)] text-white shadow-sm'
                      : 'text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-chip-bg)]'
                  }`}
                >
                  {tab.icon}
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </div>

          {/* 目标工作空间信息卡片 */}
          <div className="px-3 py-2 rounded-lg border border-[color:var(--ui-border-hairline)] bg-[var(--ui-block-bg)] space-y-1">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 min-w-0">
                <FolderGit2 size={13} className="text-[var(--ui-text-muted)] flex-shrink-0" />
                <span className="text-[11px] font-medium text-[var(--ui-text-primary)] truncate">
                  {pending.workspaceName}
                </span>
              </div>
              {inspecting ? (
                <span className="inline-flex items-center gap-1 text-[10px] text-[var(--ui-text-faint)]">
                  <Loader2 size={10} className="animate-spin" />
                  检测 Git
                </span>
              ) : currentMainBranch ? (
                <span className="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded bg-[var(--ui-chip-bg)] text-[var(--ui-accent-blue)] border border-[color:var(--ui-border-hairline)] max-w-[160px] truncate">
                  <GitBranch size={10} className="flex-shrink-0" />
                  <span className="truncate">{currentMainBranch}</span>
                </span>
              ) : (
                <span className="text-[10px] text-[var(--ui-text-faint)]">非 Git 仓库</span>
              )}
            </div>
            {pending.workDir && (
              <div className="text-[10px] font-mono text-[var(--ui-text-faint)] truncate">
                {pending.workDir}
              </div>
            )}
          </div>

          {/* Tab 1: 直接新建 */}
          {activeTab === 'direct' && (
            <div className="px-3 py-2.5 rounded-lg border border-[color:var(--ui-border-hairline)] bg-[var(--ui-block-bg)]/60 text-[11px] text-[var(--ui-text-secondary)] leading-relaxed">
              将在当前工作空间与当前分支上直接开启新会话，不切换分支也不创建额外目录。按{' '}
              <kbd className="px-1 py-0.5 text-[10px] font-mono rounded bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)] text-[var(--ui-text-primary)]">
                Enter
              </kbd>{' '}
              可快速确认。
            </div>
          )}

          {/* Tab 2: 新建分支 */}
          {activeTab === 'branch' && (
            <div className="space-y-3">
              {!inspecting && !hasGitRepo ? (
                <div className="px-3 py-2.5 rounded-lg border border-amber-500/25 bg-amber-500/10 text-[11px] text-amber-300 leading-relaxed">
                  当前工作目录未检测到有效的 Git 仓库，无法创建分支。请切换回「直接新建」，或先为工作空间绑定 Git 目录。
                </div>
              ) : (
                <>
                  <div className="space-y-1">
                    <label className="block text-[11px] font-medium text-[var(--ui-text-secondary)]">
                      基于分支
                    </label>
                    <ThemedSelect
                      value={baseBranch}
                      options={baseBranchOptions}
                      onChange={setBaseBranch}
                      placeholder="选择基准分支"
                      disabled={inspecting || submitting || baseBranchOptions.length === 0}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="block text-[11px] font-medium text-[var(--ui-text-secondary)]">
                      新分支名称 <span className="text-rose-400">*</span>
                    </label>
                    <input
                      type="text"
                      value={newBranchName}
                      onChange={(e) => setNewBranchName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !submitting) {
                          e.preventDefault();
                          void handleConfirm();
                        }
                      }}
                      autoFocus
                      placeholder="例如: feat/user-auth"
                      disabled={submitting}
                      className="w-full px-2.5 py-1.5 rounded-md border border-[color:var(--ui-border-hairline)] bg-[var(--ui-block-bg)] text-xs text-[var(--ui-text-primary)] placeholder:text-[var(--ui-text-faint)] focus:outline-none focus:border-[color:var(--ui-accent-blue)] font-mono"
                    />
                  </div>
                </>
              )}
            </div>
          )}

          {/* Tab 3: 新建 Worktree */}
          {activeTab === 'worktree' && (
            <div className="space-y-3">
              {!inspecting && validGitDirs.length === 0 ? (
                <div className="px-3 py-2.5 rounded-lg border border-amber-500/25 bg-amber-500/10 text-[11px] text-amber-300 leading-relaxed">
                  当前工作空间未检测到有效的 Git 仓库，无法创建隔离 Worktree。请切换回「直接新建」。
                </div>
              ) : (
                <>
                  {isMultiFolders && (
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-medium text-[var(--ui-text-secondary)]">
                          选择参与创建 Worktree 的仓库目录
                        </span>
                        <span className="text-[10px] text-[var(--ui-text-faint)]">
                          已选 {selectedWtPaths.length}/{validGitDirs.length}
                        </span>
                      </div>
                      <div className="max-h-32 overflow-y-auto space-y-1 pr-0.5">
                        {dirChecks.map((d) => {
                          const checked = selectedWtPaths.includes(d.path);
                          return (
                            <button
                              key={d.path}
                              type="button"
                              disabled={!d.isGit || submitting}
                              onClick={() => toggleWtPath(d.path)}
                              className={`w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-md border text-left transition-colors ${
                                !d.isGit
                                  ? 'opacity-45 cursor-not-allowed border-[color:var(--ui-border-hairline)] bg-[var(--ui-block-bg)]'
                                  : checked
                                    ? 'border-[color:var(--ui-accent-blue-border)] bg-[var(--ui-accent-blue-soft)]'
                                    : 'border-[color:var(--ui-border-hairline)] bg-[var(--ui-block-bg)] hover:bg-[var(--ui-block-hover-bg)]'
                              }`}
                            >
                              <div className="flex items-center gap-2 min-w-0">
                                <span
                                  className={`w-3.5 h-3.5 rounded flex items-center justify-center border flex-shrink-0 ${
                                    checked && d.isGit
                                      ? 'bg-[var(--ui-accent-blue)] border-[var(--ui-accent-blue)] text-white'
                                      : 'border-[color:var(--ui-border-subtle)]'
                                  }`}
                                >
                                  {checked && d.isGit && <Check size={10} />}
                                </span>
                                <span className="text-[11px] text-[var(--ui-text-primary)] truncate">
                                  {d.name}
                                </span>
                              </div>
                              <span className="text-[10px] font-mono text-[var(--ui-text-faint)] flex-shrink-0">
                                {d.isGit ? d.currentBranch || 'git' : '非 Git'}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  <div className="space-y-1">
                    <label className="block text-[11px] font-medium text-[var(--ui-text-secondary)]">
                      基准分支 / 提交点
                    </label>
                    <ThemedSelect
                      value={wtBaseBranch}
                      options={wtBaseOptions}
                      onChange={setWtBaseBranch}
                      placeholder="当前 HEAD"
                      disabled={inspecting || submitting}
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="block text-[11px] font-medium text-[var(--ui-text-secondary)]">
                      Worktree 分支名称（可选）
                    </label>
                    <input
                      type="text"
                      value={wtBranchName}
                      onChange={(e) => setWtBranchName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !submitting) {
                          e.preventDefault();
                          void handleConfirm();
                        }
                      }}
                      autoFocus
                      placeholder="留空自动生成分支，如 omcx/task-..."
                      disabled={submitting}
                      className="w-full px-2.5 py-1.5 rounded-md border border-[color:var(--ui-border-hairline)] bg-[var(--ui-block-bg)] text-xs text-[var(--ui-text-primary)] placeholder:text-[var(--ui-text-faint)] focus:outline-none focus:border-[color:var(--ui-accent-blue)] font-mono"
                    />
                  </div>
                </>
              )}
            </div>
          )}

          {errorMsg && (
            <div className="px-3 py-2 rounded-lg border border-rose-500/30 bg-rose-500/10 text-[11px] text-rose-400 leading-relaxed">
              {errorMsg}
            </div>
          )}
        </div>

        {/* 底部按钮 */}
        <div className="px-4 py-3 border-t border-[color:var(--ui-divider-hairline)] bg-[var(--ui-block-bg)]/50 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={closeModal}
            disabled={submitting}
            className="px-3 py-1.5 rounded-md border border-[color:var(--ui-border-hairline)] text-xs text-[var(--ui-text-secondary)] hover:bg-[var(--ui-chip-bg)] transition-colors disabled:opacity-40"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={
              submitting ||
              (activeTab === 'branch' && !hasGitRepo) ||
              (activeTab === 'worktree' && validGitDirs.length === 0)
            }
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md bg-[var(--ui-accent-blue)] hover:opacity-90 text-xs font-medium text-white transition-opacity disabled:opacity-45"
          >
            {submitting && <Loader2 size={12} className="animate-spin" />}
            <span>
              {activeTab === 'direct'
                ? '直接新建会话'
                : activeTab === 'branch'
                  ? '创建分支并新建会话'
                  : '创建 Worktree 并新建会话'}
            </span>
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return {
    requestNewSession,
    newSessionModal,
  };
}
