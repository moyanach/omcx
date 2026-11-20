import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useShallow } from 'zustand/react/shallow';
import {
  Check,
  Folder,
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
  branches?: string[];
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
  const { sessions, activeSessionId, activeWorkspaceId, workspaces, addSession } = useChatStore(
    useShallow((s) => ({
      sessions: s.sessions,
      activeSessionId: s.activeSessionId,
      activeWorkspaceId: s.activeWorkspaceId,
      workspaces: s.workspaces,
      addSession: s.addSession,
    }))
  );

  const [pending, setPending] = useState<PendingNewSessionState | null>(null);
  const [activeTab, setActiveTab] = useState<NewSessionTab>('direct');
  const [inspecting, setInspecting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  // 多目录 Git 信息状态
  const [dirChecks, setDirChecks] = useState<DirCheckItem[]>([]);

  // 「新建分支」表单（按目录勾选与选择基准分支）
  const [newBranchName, setNewBranchName] = useState('');
  const [selectedBranchPaths, setSelectedBranchPaths] = useState<string[]>([]);
  const [branchBaseByPath, setBranchBaseByPath] = useState<Record<string, string>>({});

  // 「新建 Worktree」表单（按目录勾选与选择基准分支）
  const [wtBranchName, setWtBranchName] = useState('');
  const [selectedWtPaths, setSelectedWtPaths] = useState<string[]>([]);
  const [wtBaseByPath, setWtBaseByPath] = useState<Record<string, string>>({});

  const loadGitContext = useCallback(
    async (
      workDir: string,
      folders: Array<{ path: string; name: string; isPrimary?: boolean }>
    ) => {
      if (!workDir && folders.length === 0) {
        setDirChecks([]);
        setSelectedBranchPaths([]);
        setBranchBaseByPath({});
        setSelectedWtPaths([]);
        setWtBaseByPath({});
        return;
      }

      setInspecting(true);
      try {
        const rawTargets =
          folders.length > 0
            ? folders
            : [
                {
                  path: workDir,
                  name: workDir.split(/[\\/]/).filter(Boolean).pop() || workDir,
                  isPrimary: true,
                },
              ];
        // 主目录排在第一位，保持多目录列表顺序清晰
        const folderTargets = [...rawTargets].sort(
          (a, b) => Number(Boolean(b.isPrimary)) - Number(Boolean(a.isPrimary))
        );

        let checked: DirCheckItem[] = [];
        const dirRes = window.electronAPI?.inspectGitDirectories
          ? await window.electronAPI.inspectGitDirectories(folderTargets).catch(() => null)
          : null;

        if (dirRes?.success && Array.isArray(dirRes.folders)) {
          checked = dirRes.folders;
        } else if (window.electronAPI?.listGitBranches) {
          checked = await Promise.all(
            folderTargets.map(async (f) => {
              const bRes = await window.electronAPI.listGitBranches(f.path).catch(() => null);
              const list = bRes?.success && Array.isArray(bRes.branches) ? bRes.branches : [];
              const cur = bRes?.currentMainBranch || list[0] || '';
              return {
                path: f.path,
                name: f.name,
                isPrimary: f.isPrimary,
                isGit: Boolean(bRes?.success),
                repoRoot: bRes?.repoRoot,
                currentBranch: cur,
                branches: list,
              };
            })
          );
        }

        // 若部分 Git 目录未附带 branches（向后兼容旧接口），按需补充一次
        const enriched = await Promise.all(
          checked.map(async (item) => {
            if (!item.isGit) return item;
            if (Array.isArray(item.branches) && item.branches.length > 0) return item;
            if (window.electronAPI?.listGitBranches) {
              const bRes = await window.electronAPI.listGitBranches(item.path).catch(() => null);
              if (bRes?.success && Array.isArray(bRes.branches)) {
                return {
                  ...item,
                  currentBranch: item.currentBranch || bRes.currentMainBranch || bRes.branches[0] || '',
                  branches: bRes.branches,
                };
              }
            }
            return {
              ...item,
              branches: item.currentBranch ? [item.currentBranch] : [],
            };
          })
        );

        const validPaths = enriched.filter((d) => d.isGit).map((d) => d.path);
        const initialBaseMap: Record<string, string> = {};
        for (const d of enriched) {
          if (d.isGit) {
            initialBaseMap[d.path] = d.currentBranch || d.branches?.[0] || '';
          }
        }

        setDirChecks(enriched);
        setSelectedBranchPaths(validPaths);
        setBranchBaseByPath(initialBaseMap);
        setSelectedWtPaths(validPaths);
        setWtBaseByPath({});
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
      setDirChecks([]);
      setSelectedBranchPaths([]);
      setBranchBaseByPath({});
      setSelectedWtPaths([]);
      setWtBaseByPath({});

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

  const toggleBranchPath = (targetPath: string) => {
    setSelectedBranchPaths((prev) =>
      prev.includes(targetPath) ? prev.filter((p) => p !== targetPath) : [...prev, targetPath]
    );
  };

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

    const validGitDirs = dirChecks.filter((d) => d.isGit);
    const isMultiMode = pending.folders.length > 1;

    if (activeTab === 'branch') {
      const targetBranch = newBranchName.trim();
      if (validGitDirs.length === 0) {
        setErrorMsg('当前工作空间下没有有效的 Git 仓库，无法创建分支');
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

      const chosen = isMultiMode
        ? validGitDirs.filter((d) => selectedBranchPaths.includes(d.path))
        : [validGitDirs[0]];
      if (chosen.length === 0) {
        setErrorMsg('请至少选择一个有效的 Git 目录');
        return;
      }

      // 按 repoRoot 去重，避免同一个 Git 仓库下的多个子目录重复建分支报错
      const uniqueTargets: DirCheckItem[] = [];
      const seenRoots = new Set<string>();
      for (const dir of chosen) {
        const key = dir.repoRoot || dir.path;
        if (seenRoots.has(key)) continue;
        seenRoots.add(key);
        uniqueTargets.push(dir);
      }

      // 前置冲突检测：若某目录已存在同名分支，先拦截避免部分成功部分失败
      const conflicts = uniqueTargets.filter((d) => (d.branches || []).includes(targetBranch));
      if (conflicts.length > 0) {
        setErrorMsg(
          `分支「${targetBranch}」在以下目录中已存在：${conflicts.map((d) => d.name).join('、')}`
        );
        return;
      }

      setSubmitting(true);
      try {
        // 每次 gitCreateBranchAt 均经 gitIpc.js 广播 workspace-changed 事件总线，自动刷新 Git 图谱/Diff/工作区状态
        let createdCount = 0;
        for (const dir of uniqueTargets) {
          const startPoint = branchBaseByPath[dir.path] || dir.currentBranch || 'HEAD';
          const res = await window.electronAPI.gitCreateBranchAt(dir.path, targetBranch, startPoint);
          if (!res?.success) {
            if (createdCount > 0) {
              void loadGitContext(pending.workDir, pending.folders);
            }
            setErrorMsg(`目录「${dir.name}」创建并切换分支失败：${res?.error || '未知错误'}`);
            return;
          }
          createdCount += 1;
        }
        const createdId = await addSession({
          workspaceId: pending.workspaceId,
          workDir: pending.workDir || uniqueTargets[0].path,
          model: pending.model,
        });
        const cb = pending.onCreated;
        setPending(null);
        if (createdId && cb) cb(createdId);
      } catch (err: any) {
        void loadGitContext(pending.workDir, pending.folders);
        setErrorMsg(err?.message || '创建分支失败');
      } finally {
        setSubmitting(false);
      }
      return;
    }

    // activeTab === 'worktree'
    if (validGitDirs.length === 0) {
      setErrorMsg('当前工作空间下没有有效的 Git 仓库，无法创建 Worktree');
      return;
    }

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
          folders: chosen.map((d) => ({
            path: d.path,
            name: d.name,
            isPrimary: d.isPrimary,
            base: wtBaseByPath[d.path]?.trim() || '',
          })),
          branch: wtBranchName.trim(),
          base: 'HEAD',
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
        base: wtBaseByPath[targetDir]?.trim() || 'HEAD',
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
    branchBaseByPath,
    dirChecks,
    loadGitContext,
    newBranchName,
    pending,
    selectedBranchPaths,
    selectedWtPaths,
    submitting,
    wtBaseByPath,
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
  const hasGitRepo = validGitDirs.length > 0;
  const isMultiFolders = (pending?.folders.length || 0) > 1;

  // 尚未完成 Git 检测前，优先用 pending.folders 占位，避免弹窗高度闪烁
  const displayDirs: DirCheckItem[] =
    dirChecks.length > 0
      ? dirChecks
      : (pending?.folders || []).map((f) => ({
          path: f.path,
          name: f.name,
          isPrimary: f.isPrimary,
          isGit: false,
        }));

  const buildBranchBaseOptions = (d: DirCheckItem): SelectOption[] => {
    const list =
      d.branches && d.branches.length > 0
        ? d.branches
        : d.currentBranch
          ? [d.currentBranch]
          : [];
    return list.map((b) => ({
      value: b,
      label: b === d.currentBranch ? `${b}（当前）` : b,
    }));
  };

  const buildWtBaseOptions = (d: DirCheckItem): SelectOption[] => {
    const list =
      d.branches && d.branches.length > 0
        ? d.branches
        : d.currentBranch
          ? [d.currentBranch]
          : [];
    return [
      {
        value: '',
        label: d.currentBranch ? `HEAD (${d.currentBranch})` : '当前 HEAD',
      },
      ...list.map((b) => ({
        value: b,
        label: b === d.currentBranch ? `${b}（当前）` : b,
      })),
    ];
  };

  const modalNode = pending ? (
    <div
      className="fixed inset-0 z-[99999] flex items-center justify-center bg-[var(--ui-modal-overlay)] backdrop-blur-sm p-4 titlebar-no-drag"
      onClick={closeModal}
    >
      <div
        className="w-full max-w-lg max-h-[86vh] flex flex-col rounded-xl border border-[color:var(--ui-border-subtle)] bg-[var(--ui-panel-bg)] shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
          {/* 弹窗标题栏 */}
          <div className="px-4 py-3 border-b border-[color:var(--ui-divider-hairline)] flex items-center justify-between flex-shrink-0">
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

          <div className="p-4 space-y-3.5 text-xs overflow-y-auto custom-scrollbar flex-1 min-h-0">
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

            {/* 目标工作空间与多目录分支选择卡片 */}
            <div className="rounded-lg border border-[color:var(--ui-border-hairline)] bg-[var(--ui-block-bg)] overflow-hidden">
              {/* 工作空间汇总头 */}
              <div className="px-3 py-2 border-b border-[color:var(--ui-divider-hairline)] flex items-center justify-between gap-2 bg-[var(--ui-card-header-bg)]/40">
                <div className="flex items-center gap-1.5 min-w-0">
                  <FolderGit2 size={13} className="text-[var(--ui-text-muted)] flex-shrink-0" />
                  <span className="text-[11px] font-medium text-[var(--ui-text-primary)] truncate">
                    {pending.workspaceName}
                  </span>
                  {displayDirs.length > 1 && (
                    <span className="px-1.5 py-0.2 rounded text-[9.5px] font-mono bg-[var(--ui-chip-bg)] text-[var(--ui-text-muted)] border border-[color:var(--ui-border-hairline)] flex-shrink-0">
                      {displayDirs.length} 个目录
                    </span>
                  )}
                </div>

                {inspecting ? (
                  <span className="inline-flex items-center gap-1 text-[10px] text-[var(--ui-text-faint)] flex-shrink-0">
                    <Loader2 size={10} className="animate-spin" />
                    检测 Git
                  </span>
                ) : activeTab === 'branch' && isMultiFolders && hasGitRepo ? (
                  <span className="text-[10px] text-[var(--ui-text-faint)] flex-shrink-0">
                    已选 {selectedBranchPaths.length}/{validGitDirs.length} · 右侧选基于分支
                  </span>
                ) : activeTab === 'worktree' && isMultiFolders && validGitDirs.length > 0 ? (
                  <span className="text-[10px] text-[var(--ui-text-faint)] flex-shrink-0">
                    已选 {selectedWtPaths.length}/{validGitDirs.length} · 右侧选基准点
                  </span>
                ) : activeTab === 'branch' && hasGitRepo ? (
                  <span className="text-[10px] text-[var(--ui-text-faint)] flex-shrink-0">
                    右侧选择基于分支
                  </span>
                ) : activeTab === 'worktree' && validGitDirs.length > 0 ? (
                  <span className="text-[10px] text-[var(--ui-text-faint)] flex-shrink-0">
                    右侧选择基准点
                  </span>
                ) : null}
              </div>

              {/* 目录列表（单/多目录统一渲染，分支控件均在每行右侧） */}
              {displayDirs.length === 0 ? (
                <div className="px-3 py-2.5 text-[10.5px] text-[var(--ui-text-faint)]">
                  当前未绑定本地工作目录
                </div>
              ) : (
                <div className="max-h-48 overflow-y-auto custom-scrollbar divide-y divide-[color:var(--ui-divider-hairline)]">
                  {displayDirs.map((d) => {
                    const showCheckbox =
                      isMultiFolders && (activeTab === 'branch' || activeTab === 'worktree');
                    const isChecked =
                      activeTab === 'branch'
                        ? selectedBranchPaths.includes(d.path)
                        : selectedWtPaths.includes(d.path);
                    const canSelect = showCheckbox && d.isGit && !submitting;

                    return (
                      <div
                        key={d.path}
                        onClick={() => {
                          if (!canSelect) return;
                          if (activeTab === 'branch') toggleBranchPath(d.path);
                          else toggleWtPath(d.path);
                        }}
                        className={`px-3 py-2 flex items-center justify-between gap-2.5 transition-colors ${
                          canSelect ? 'cursor-pointer hover:bg-[var(--ui-block-hover-bg)]' : ''
                        } ${showCheckbox && !d.isGit && !inspecting ? 'opacity-50' : ''}`}
                      >
                        <div className="flex items-start gap-2 min-w-0 flex-1">
                          {showCheckbox ? (
                            <span
                              className={`mt-0.5 w-3.5 h-3.5 rounded flex items-center justify-center border flex-shrink-0 ${
                                isChecked && d.isGit
                                  ? 'bg-[var(--ui-accent-blue)] border-[var(--ui-accent-blue)] text-white'
                                  : 'border-[color:var(--ui-border-subtle)]'
                              }`}
                            >
                              {isChecked && d.isGit && <Check size={10} />}
                            </span>
                          ) : (
                            <Folder size={13} className="text-[var(--ui-text-muted)] flex-shrink-0 mt-0.5" />
                          )}

                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span className="text-[11px] font-medium text-[var(--ui-text-primary)] truncate">
                                {d.name}
                              </span>
                              {isMultiFolders && d.isPrimary && (
                                <span className="px-1.5 py-0.2 rounded text-[9px] bg-[var(--ui-chip-bg)] text-[var(--ui-text-secondary)] border border-[color:var(--ui-border-hairline)] flex-shrink-0">
                                  主要
                                </span>
                              )}
                            </div>
                            <div
                              className="text-[10px] font-mono text-[var(--ui-text-faint)] truncate"
                              title={d.path}
                            >
                              {d.path}
                            </div>
                          </div>
                        </div>

                        {/* 右侧分支控制区（对齐图三红框位置） */}
                        <div
                          className="flex-shrink-0 max-w-[190px]"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {inspecting ? (
                            <span className="text-[10px] text-[var(--ui-text-faint)]">...</span>
                          ) : !d.isGit ? (
                            <span className="text-[10px] text-[var(--ui-text-faint)]">
                              {d.error || '非 Git 仓库'}
                            </span>
                          ) : activeTab === 'direct' ? (
                            <span
                              title={`当前分支: ${d.currentBranch || 'HEAD'}`}
                              className="inline-flex items-center gap-1 h-6 px-2 rounded-md text-[10px] font-mono bg-[var(--ui-chip-bg)] text-[var(--ui-accent-blue)] border border-[color:var(--ui-border-hairline)] max-w-full"
                            >
                              <GitBranch size={10} className="flex-shrink-0" />
                              <span className="truncate">{d.currentBranch || 'HEAD'}</span>
                            </span>
                          ) : activeTab === 'branch' ? (
                            <ThemedSelect
                              compact
                              searchable
                              align="right"
                              menuMinWidth={240}
                              prefixIcon={<GitBranch size={10} className="text-[var(--ui-accent-blue)]" />}
                              value={branchBaseByPath[d.path] ?? d.currentBranch ?? ''}
                              options={buildBranchBaseOptions(d)}
                              onChange={(val) =>
                                setBranchBaseByPath((prev) => ({ ...prev, [d.path]: val }))
                              }
                              placeholder="基于分支"
                              disabled={submitting || (isMultiFolders && !isChecked)}
                            />
                          ) : (
                            <ThemedSelect
                              compact
                              searchable
                              align="right"
                              menuMinWidth={240}
                              prefixIcon={<GitBranch size={10} className="text-[var(--ui-accent-blue)]" />}
                              value={wtBaseByPath[d.path] ?? ''}
                              options={buildWtBaseOptions(d)}
                              onChange={(val) =>
                                setWtBaseByPath((prev) => ({ ...prev, [d.path]: val }))
                              }
                              placeholder="当前 HEAD"
                              disabled={submitting || (isMultiFolders && !isChecked)}
                            />
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Tab 1: 直接新建 */}
            {activeTab === 'direct' && (
              <div className="px-3 py-2.5 rounded-lg border border-[color:var(--ui-border-hairline)] bg-[var(--ui-block-bg)]/60 text-[11px] text-[var(--ui-text-secondary)] leading-relaxed">
                将在当前工作空间与各目录当前分支上直接开启新会话，不切换分支也不创建额外目录。按{' '}
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
          <div className="px-4 py-3 border-t border-[color:var(--ui-divider-hairline)] bg-[var(--ui-block-bg)]/50 flex items-center justify-end gap-2 flex-shrink-0">
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

  const newSessionModal =
    modalNode && typeof document !== 'undefined' ? createPortal(modalNode, document.body) : null;

  return {
    requestNewSession,
    newSessionModal,
  };
}
