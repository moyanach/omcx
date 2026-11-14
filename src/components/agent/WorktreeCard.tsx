import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderGit2,
  FolderOpen,
  GitMerge,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import { useChatStore } from '@/stores/chatStore';
import { ThemedSelect } from '@/components/common/ThemedSelect';

interface WorktreeEntry {
  path: string;
  head?: string;
  branch?: string;
  sourceBranch?: string;
  detached?: boolean;
  locked?: boolean;
  isMain?: boolean;
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

export const WorktreeCard: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [items, setItems] = useState<WorktreeEntry[]>([]);
  const [branches, setBranches] = useState<string[]>([]);
  const [currentMainBranch, setCurrentMainBranch] = useState('');
  const [branch, setBranch] = useState('');
  const [base, setBase] = useState('');
  const [message, setMessage] = useState('');
  const [mergeTargetEntry, setMergeTargetEntry] = useState<WorktreeEntry | null>(null);
  const [mergeBranch, setMergeBranch] = useState('');
  const [autoCommit, setAutoCommit] = useState(true);
  const [removeAfterMerge, setRemoveAfterMerge] = useState(true);
  const [selectedFolderPath, setSelectedFolderPath] = useState('');

  // 多目录创建弹窗状态
  const [multiModalOpen, setMultiModalOpen] = useState(false);
  const [multiLoading, setMultiLoading] = useState(false);
  const [dirChecks, setDirChecks] = useState<DirCheckItem[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [multiBranch, setMultiBranch] = useState('');
  const [multiBase, setMultiBase] = useState('');
  const [multiError, setMultiError] = useState('');

  const {
    sessions,
    activeSessionId,
    activeWorkspaceId,
    workspaces,
    addSession,
    setSessionWorkDir,
  } = useChatStore(
    useShallow((s) => ({
      sessions: s.sessions,
      activeSessionId: s.activeSessionId,
      activeWorkspaceId: s.activeWorkspaceId,
      workspaces: s.workspaces,
      addSession: s.addSession,
      setSessionWorkDir: s.setSessionWorkDir,
    }))
  );
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const sessionWorkDir = activeSession?.workDir || '';

  const currentWorkspace = useMemo(
    () =>
      workspaces.find(
        (ws) =>
          ws.id === activeSession?.workspaceId ||
          ws.id === activeWorkspaceId ||
          ws.folders.some((f) => f.path === sessionWorkDir)
      ) || workspaces[0],
    [workspaces, activeSession?.workspaceId, activeWorkspaceId, sessionWorkDir]
  );

  const isMultiFolderWorkspace = Boolean(currentWorkspace && currentWorkspace.folders.length > 1);

  useEffect(() => {
    if (!currentWorkspace?.folders?.length) {
      setSelectedFolderPath('');
      return;
    }
    const matched = currentWorkspace.folders.find((f) => f.path === sessionWorkDir);
    if (matched) {
      setSelectedFolderPath(matched.path);
    } else if (!currentWorkspace.folders.some((f) => f.path === selectedFolderPath)) {
      const primary = currentWorkspace.folders.find((f) => f.isPrimary) || currentWorkspace.folders[0];
      setSelectedFolderPath(primary?.path || '');
    }
  }, [currentWorkspace, sessionWorkDir, selectedFolderPath]);

  const workDir =
    (isMultiFolderWorkspace && !sessionWorkDir.includes('/worktrees/') ? selectedFolderPath : '') ||
    (isMultiFolderWorkspace && selectedFolderPath && sessionWorkDir.includes('/worktrees/')
      ? selectedFolderPath
      : sessionWorkDir) ||
    sessionWorkDir;

  const load = useCallback(async () => {
    if (!workDir || !window.electronAPI?.listGitWorktrees) {
      setItems([]);
      setBranches([]);
      return;
    }
    setLoading(true);
    try {
      const [res, branchRes] = await Promise.all([
        window.electronAPI.listGitWorktrees(workDir),
        window.electronAPI.listGitBranches ? window.electronAPI.listGitBranches(workDir) : Promise.resolve(null),
      ]);
      if (res?.success) {
        setItems(Array.isArray(res.worktrees) ? res.worktrees : []);
      } else {
        setItems([]);
        setMessage(res?.error || '读取工作树失败');
      }
      if (branchRes?.success) {
        setBranches(Array.isArray(branchRes.branches) ? branchRes.branches : []);
        setCurrentMainBranch(branchRes.currentMainBranch || '');
      }
    } catch (err: any) {
      setMessage(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [workDir]);

  useEffect(() => {
    if (isOpen) load();
  }, [isOpen, load]);

  const handleCreate = async () => {
    if (!workDir || busy) return;
    if (isMultiFolderWorkspace && currentWorkspace) {
      setMultiBranch(branch.trim());
      setMultiBase(base.trim() || 'HEAD');
      setMultiError('');
      setMultiModalOpen(true);
      setMultiLoading(true);
      try {
        if (window.electronAPI?.inspectGitDirectories) {
          const res = await window.electronAPI.inspectGitDirectories(currentWorkspace.folders);
          const list: DirCheckItem[] = Array.isArray(res?.folders) ? res.folders : [];
          setDirChecks(list);
          // 默认全选所有有效 Git 目录
          setSelectedPaths(list.filter((d) => d.isGit).map((d) => d.path));
        } else {
          const fallback = currentWorkspace.folders.map((f) => ({
            path: f.path,
            name: f.name,
            isPrimary: f.isPrimary,
            isGit: true,
          }));
          setDirChecks(fallback);
          setSelectedPaths(fallback.map((d) => d.path));
        }
      } catch (err: any) {
        setMultiError(err?.message || String(err));
      } finally {
        setMultiLoading(false);
      }
      return;
    }

    setBusy('create');
    setMessage('');
    try {
      const res = await window.electronAPI.createGitWorktree({
        workDir,
        branch: branch.trim(),
        base: base.trim() || 'HEAD',
      });
      if (!res?.success) {
        setMessage(res?.error || '创建工作树失败');
        return;
      }
      setMessage(`已创建隔离工作树：${res.branch}`);
      setBranch('');
      setBase('');
      await load();
      // 直接在隔离目录中开启新会话，避免污染主工作区
      if (addSession) {
        const newId = await addSession({ workDir: res.path, model: activeSession?.model });
        if (newId) setMessage(`已创建隔离工作树 ${res.branch}，并切换到新会话`);
      }
    } catch (err: any) {
      setMessage(err?.message || String(err));
    } finally {
      setBusy('');
    }
  };

  const toggleMultiPath = (targetPath: string) => {
    setSelectedPaths((prev) =>
      prev.includes(targetPath) ? prev.filter((p) => p !== targetPath) : [...prev, targetPath]
    );
  };

  const handleConfirmMultiCreate = async () => {
    if (busy || selectedPaths.length === 0) return;
    const chosen = dirChecks.filter((d) => d.isGit && selectedPaths.includes(d.path));
    if (chosen.length === 0) {
      setMultiError('请至少选择一个有效的 Git 目录');
      return;
    }
    setBusy('create-multi');
    setMultiError('');
    try {
      const res = await window.electronAPI.createMultiGitWorktrees({
        folders: chosen.map((d) => ({ path: d.path, name: d.name, isPrimary: d.isPrimary })),
        branch: multiBranch.trim(),
        base: multiBase.trim() || 'HEAD',
      });
      if (!res?.success) {
        setMultiError(res?.error || '批量创建工作树失败');
        return;
      }
      const createdItems = Array.isArray(res.items) ? res.items : [];
      const primaryItem = createdItems.find((i: any) => i.isPrimary) || createdItems[0];
      if (addSession && primaryItem?.worktreePath) {
        const newId = await addSession({
          workDir: primaryItem.worktreePath,
          model: activeSession?.model,
        });
        if (newId && window.electronAPI?.saveSessionWorktreeGroup) {
          await window.electronAPI.saveSessionWorktreeGroup(newId, createdItems);
        }
      }
      setMultiModalOpen(false);
      setBranch('');
      setBase('');
      setMessage(`已为 ${createdItems.length} 个目录创建隔离工作树（分支：${res.branch}），并切换到新会话`);
      await load();
    } catch (err: any) {
      setMultiError(err?.message || String(err));
    } finally {
      setBusy('');
    }
  };

  const openMergePanel = (entry: WorktreeEntry) => {
    const candidateBranches = branches.filter((b) => b !== entry.branch);
    const preferred =
      (entry.sourceBranch && candidateBranches.includes(entry.sourceBranch) && entry.sourceBranch) ||
      (currentMainBranch && candidateBranches.includes(currentMainBranch) && currentMainBranch) ||
      candidateBranches.find((b) => b === 'main' || b === 'master') ||
      candidateBranches[0] ||
      '';
    setMergeTargetEntry(entry);
    setMergeBranch(preferred);
    setAutoCommit(true);
    setRemoveAfterMerge(true);
    setMessage('');
  };

  const handleMerge = async () => {
    if (!workDir || !mergeTargetEntry || !mergeBranch || busy) return;
    if (!window.electronAPI?.mergeGitWorktree) {
      setMessage('当前版本不支持工作树合并接口');
      return;
    }
    setBusy(`merge:${mergeTargetEntry.path}`);
    setMessage('');
    try {
      const res = await window.electronAPI.mergeGitWorktree({
        workDir,
        sourcePath: mergeTargetEntry.path,
        targetBranch: mergeBranch,
        autoCommit,
        removeAfterMerge,
      });
      if (!res?.success) {
        setMessage(res?.error || '合并失败');
        return;
      }
      const parts = [`已将 ${res.sourceBranch} 合并到 ${res.targetBranch}`];
      if (res.committedBeforeMerge) parts.push('（已自动提交未保存改动）');
      if (res.removed) parts.push('，并已清理工作树');
      if (res.removeWarning) parts.push(`；但清理失败：${res.removeWarning}`);
      setMessage(parts.join(''));
      const removedPath = mergeTargetEntry.path;
      setMergeTargetEntry(null);
      if (res.removed && res.repoRoot && activeSessionId && sessionWorkDir === removedPath) {
        await setSessionWorkDir(activeSessionId, res.repoRoot);
      } else {
        await load();
      }
    } catch (err: any) {
      setMessage(err?.message || String(err));
    } finally {
      setBusy('');
    }
  };

  const handleRemove = async (entry: WorktreeEntry, force = false) => {
    if (!workDir || busy) return;
    if (!force) {
      const confirmed = window.confirm(
        `确认删除工作树？\n\n分支：${entry.branch || '(detached)'}\n路径：${entry.path}\n\n未提交的改动将随工作树一起删除。`
      );
      if (!confirmed) return;
    }
    setBusy(entry.path);
    setMessage('');
    try {
      let res = await window.electronAPI.removeGitWorktree(workDir, entry.path, force);
      if (!res?.success && !force) {
        const errText = String(res?.error || '');
        const canForceRemove = /modified|untracked|未提交|强制删除|--force/i.test(errText);
        if (!canForceRemove) {
          setMessage(errText || '删除工作树失败');
          return;
        }
        const retry = window.confirm(
          `删除失败：${errText || '工作树包含未提交改动'}\n\n是否强制删除并丢弃其中的未提交改动？`
        );
        if (!retry) {
          setMessage(errText || '删除失败');
          return;
        }
        res = await window.electronAPI.removeGitWorktree(workDir, entry.path, true);
      }
      if (!res?.success) {
        setMessage(res?.error || '删除工作树失败');
        return;
      }
      setMessage('已删除工作树');
      if (res.repoRoot && activeSessionId && sessionWorkDir === entry.path) {
        await setSessionWorkDir(activeSessionId, res.repoRoot);
      } else {
        await load();
      }
    } catch (err: any) {
      setMessage(err?.message || String(err));
    } finally {
      setBusy('');
    }
  };

  return (
    <div className='border-b border-[color:var(--ui-divider-hairline)] last:border-b-0'>
      <button
        onClick={() => setIsOpen((v) => !v)}
        className='w-full px-4 py-2.5 flex items-center gap-2 hover:bg-[var(--ui-block-hover-bg)] transition-colors'
      >
        {isOpen ? (
          <ChevronDown size={12} className='text-[var(--ui-text-faint)]' />
        ) : (
          <ChevronRight size={12} className='text-[var(--ui-text-faint)]' />
        )}
        <FolderGit2 size={13} className='text-[var(--ui-accent-blue)]' />
        <span className='text-[11px] font-semibold text-[var(--ui-text-secondary)]'>
          隔离工作树
        </span>
        <span className='ml-auto text-[10px] font-mono text-[var(--ui-text-faint)]'>
          {items.length > 0 ? `${items.length} 个` : 'Worktree'}
        </span>
        {loading && <Loader2 size={11} className='animate-spin text-[var(--ui-text-faint)]' />}
      </button>

      {isOpen && (
        <div className='px-3 pb-3 space-y-2 border-t border-[color:var(--ui-divider-hairline)] pt-2'>
          {!workDir ? (
            <p className='text-[10.5px] text-[var(--ui-text-faint)] py-2'>
              当前会话未绑定工作目录
            </p>
          ) : (
            <>
              {isMultiFolderWorkspace && currentWorkspace && (
                <div className='flex items-center gap-1.5'>
                  <span className='text-[10px] text-[var(--ui-text-faint)] flex-shrink-0'>
                    查看目录：
                  </span>
                  <ThemedSelect
                    value={selectedFolderPath}
                    onChange={(val) => {
                      setSelectedFolderPath(val);
                      setMergeTargetEntry(null);
                    }}
                    options={currentWorkspace.folders.map((f) => ({
                      value: f.path,
                      label: `${f.name}${f.isPrimary ? ' (主)' : ''}`,
                    }))}
                    className='flex-1 min-w-0'
                  />
                </div>
              )}

              <div className='flex items-center gap-1.5'>
                <input
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  placeholder='分支名（留空自动生成）'
                  className='flex-1 min-w-0 h-7 px-2 rounded-lg bg-[var(--ui-input-bg)] border border-[color:var(--ui-border-hairline)] text-[10.5px] font-mono text-[var(--ui-text-secondary)] outline-none focus:border-[var(--ui-accent-blue-border)]'
                />
                <input
                  value={base}
                  onChange={(e) => setBase(e.target.value)}
                  placeholder='基线 (HEAD)'
                  className='w-24 h-7 px-2 rounded-lg bg-[var(--ui-input-bg)] border border-[color:var(--ui-border-hairline)] text-[10.5px] font-mono text-[var(--ui-text-secondary)] outline-none focus:border-[var(--ui-accent-blue-border)]'
                />
                <button
                  onClick={handleCreate}
                  disabled={Boolean(busy)}
                  className='h-7 px-2 rounded-lg bg-[var(--ui-accent-blue-soft)] border border-[color:var(--ui-accent-blue-border)] text-[10.5px] text-[var(--ui-accent-blue)] hover:brightness-110 disabled:opacity-50 flex items-center gap-1 flex-shrink-0'
                  title='创建 Git 工作树并在其中开启新会话'
                >
                  {busy === 'create' ? (
                    <Loader2 size={11} className='animate-spin' />
                  ) : (
                    <Plus size={11} />
                  )}
                  创建
                </button>
                <button
                  onClick={load}
                  disabled={loading}
                  className='p-1.5 rounded-lg bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)] text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] disabled:opacity-50 flex-shrink-0'
                  title='刷新工作树列表'
                >
                  <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
                </button>
              </div>

              {items.length === 0 && !loading ? (
                <p className='text-[10.5px] text-[var(--ui-text-faint)] py-2'>
                  暂无工作树。创建后 Agent 的改动会隔离在独立目录中。
                </p>
              ) : (
                <div className='max-h-[180px] overflow-y-auto custom-scrollbar space-y-1 pr-0.5'>
                  {items.map((entry) => (
                    <div
                      key={entry.path}
                      className='rounded-md bg-[var(--ui-block-bg)] px-2 py-1.5'
                    >
                      <div className='flex items-center gap-1.5 min-w-0'>
                        <span className='text-[10.5px] font-mono text-[var(--ui-text-secondary)] truncate'>
                          {entry.branch || (entry.detached ? '(detached)' : '(unknown)')}
                        </span>
                        {entry.isMain && (
                          <span className='text-[9px] px-1 rounded bg-[var(--ui-accent-emerald-soft)] text-[var(--ui-accent-emerald)] flex-shrink-0'>
                            主
                          </span>
                        )}
                        <div className='ml-auto flex items-center gap-1 flex-shrink-0'>
                          <button
                            onClick={() => window.electronAPI?.showInFolder?.(entry.path)}
                            className='p-1 rounded hover:bg-[var(--ui-block-hover-bg)] text-[var(--ui-text-faint)] hover:text-[var(--ui-text-primary)]'
                            title='在 Finder 中打开'
                          >
                            <FolderOpen size={11} />
                          </button>
                          {!entry.isMain && entry.branch && (
                            <button
                              onClick={() => openMergePanel(entry)}
                              disabled={Boolean(busy)}
                              className='p-1 rounded hover:bg-[var(--ui-accent-blue-soft)] text-[var(--ui-text-faint)] hover:text-[var(--ui-accent-blue)] disabled:opacity-40'
                              title='一键合并到目标分支'
                            >
                              <GitMerge size={11} />
                            </button>
                          )}
                          {!entry.isMain && (
                            <button
                              onClick={() => handleRemove(entry)}
                              disabled={Boolean(busy)}
                              className='p-1 rounded hover:bg-rose-500/10 text-[var(--ui-text-faint)] hover:text-rose-400 disabled:opacity-40'
                              title='删除工作树'
                            >
                              {busy === entry.path ? (
                                <Loader2 size={11} className='animate-spin' />
                              ) : (
                                <Trash2 size={11} />
                              )}
                            </button>
                          )}
                        </div>
                      </div>
                      {!entry.isMain && entry.sourceBranch && (
                        <p className='text-[9.5px] font-mono text-[var(--ui-text-faint)] truncate mt-0.5'>
                          来源分支：{entry.sourceBranch}
                        </p>
                      )}
                      <p
                        className='text-[9.5px] font-mono text-[var(--ui-text-faint)] truncate mt-0.5'
                        title={entry.path}
                      >
                        {entry.path}
                      </p>
                    </div>
                  ))}
                </div>
              )}

              {mergeTargetEntry && (
                <div className='rounded-lg border border-[color:var(--ui-accent-blue-border)] bg-[var(--ui-block-bg)] p-2.5 space-y-2'>
                  <div className='flex items-center justify-between gap-2'>
                    <span className='text-[10.5px] font-medium text-[var(--ui-text-secondary)] truncate'>
                      合并 <span className='font-mono'>{mergeTargetEntry.branch}</span> 到：
                    </span>
                    <button
                      onClick={() => setMergeTargetEntry(null)}
                      className='text-[10px] text-[var(--ui-text-faint)] hover:text-[var(--ui-text-primary)]'
                    >
                      取消
                    </button>
                  </div>
                  <ThemedSelect
                    value={mergeBranch}
                    onChange={setMergeBranch}
                    placeholder='选择目标分支'
                    options={branches
                      .filter((b) => b !== mergeTargetEntry.branch)
                      .map((b) => ({
                        value: b,
                        label: `${b}${
                          mergeTargetEntry.sourceBranch === b
                            ? ' (创建来源)'
                            : currentMainBranch === b
                              ? ' (主工作区当前)'
                              : ''
                        }`,
                      }))}
                    className='w-full'
                  />
                  <label className='flex items-center gap-1.5 text-[10px] text-[var(--ui-text-muted)] cursor-pointer select-none'>
                    <input
                      type='checkbox'
                      checked={autoCommit}
                      onChange={(e) => setAutoCommit(e.target.checked)}
                      className='rounded border-[color:var(--ui-border-hairline)]'
                    />
                    合并前自动提交该工作树未保存改动
                  </label>
                  <label className='flex items-center gap-1.5 text-[10px] text-[var(--ui-text-muted)] cursor-pointer select-none'>
                    <input
                      type='checkbox'
                      checked={removeAfterMerge}
                      onChange={(e) => setRemoveAfterMerge(e.target.checked)}
                      className='rounded border-[color:var(--ui-border-hairline)]'
                    />
                    合并成功后自动删除该工作树
                  </label>
                  <button
                    onClick={handleMerge}
                    disabled={!mergeBranch || Boolean(busy)}
                    className='w-full h-7 rounded-md bg-[var(--ui-accent-blue-soft)] border border-[color:var(--ui-accent-blue-border)] text-[10.5px] font-medium text-[var(--ui-accent-blue)] hover:brightness-110 disabled:opacity-50 flex items-center justify-center gap-1.5'
                  >
                    {busy.startsWith('merge:') ? (
                      <Loader2 size={11} className='animate-spin' />
                    ) : (
                      <GitMerge size={11} />
                    )}
                    一键合并到 {mergeBranch || '目标分支'}
                  </button>
                </div>
              )}
            </>
          )}

          {message && (
            <p className='text-[10px] text-[var(--ui-text-muted)] leading-relaxed break-words'>
              {message}
            </p>
          )}
        </div>
      )}

      {multiModalOpen && (
        <div
          className='fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-sm p-4'
          onClick={() => !busy && setMultiModalOpen(false)}
        >
          <div
            className='w-full max-w-md rounded-xl border border-[color:var(--ui-border-hairline)] bg-[var(--ui-panel-bg)] shadow-2xl p-4 space-y-3'
            onClick={(e) => e.stopPropagation()}
          >
            <div className='flex items-center justify-between gap-2'>
              <div className='flex items-center gap-2 text-[var(--ui-text-primary)]'>
                <FolderGit2 size={15} className='text-[var(--ui-accent-blue)]' />
                <h3 className='text-[13px] font-semibold'>创建多目录隔离工作树</h3>
              </div>
              <button
                onClick={() => !busy && setMultiModalOpen(false)}
                disabled={Boolean(busy)}
                className='p-1 rounded-md text-[var(--ui-text-faint)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-block-hover-bg)]'
              >
                <X size={14} />
              </button>
            </div>

            <p className='text-[11px] text-[var(--ui-text-muted)] leading-relaxed'>
              选择要纳入隔离工作树的仓库目录（默认全选有效 Git 仓库；任一目录创建失败将自动全部回滚）：
            </p>

            <div className='max-h-[190px] overflow-y-auto custom-scrollbar space-y-1.5 pr-0.5'>
              {multiLoading ? (
                <div className='py-6 flex items-center justify-center gap-2 text-[11px] text-[var(--ui-text-faint)]'>
                  <Loader2 size={13} className='animate-spin' />
                  正在检测工作空间 Git 目录...
                </div>
              ) : (
                dirChecks.map((item) => {
                  const checked = item.isGit && selectedPaths.includes(item.path);
                  return (
                    <label
                      key={item.path}
                      className={`flex items-start gap-2 rounded-lg border px-2.5 py-2 transition-colors ${
                        item.isGit
                          ? 'border-[color:var(--ui-border-hairline)] bg-[var(--ui-block-bg)] cursor-pointer hover:bg-[var(--ui-block-hover-bg)]'
                          : 'border-[color:var(--ui-border-hairline)] bg-[var(--ui-block-bg)]/50 opacity-55 cursor-not-allowed'
                      }`}
                    >
                      <input
                        type='checkbox'
                        checked={checked}
                        disabled={!item.isGit || Boolean(busy)}
                        onChange={() => item.isGit && toggleMultiPath(item.path)}
                        className='mt-0.5 rounded border-[color:var(--ui-border-hairline)]'
                      />
                      <div className='min-w-0 flex-1'>
                        <div className='flex items-center gap-1.5'>
                          <Folder size={12} className='text-[var(--ui-accent-blue)] flex-shrink-0' />
                          <span className='text-[11.5px] font-medium text-[var(--ui-text-primary)] truncate'>
                            {item.name}
                          </span>
                          {item.isPrimary && (
                            <span className='px-1.5 py-0.2 rounded text-[9px] bg-[var(--ui-chip-bg)] text-[var(--ui-text-secondary)] border border-[color:var(--ui-border-hairline)] flex-shrink-0'>
                              主要
                            </span>
                          )}
                          {item.isGit && item.currentBranch && (
                            <span className='ml-auto text-[10px] font-mono text-[var(--ui-text-faint)] truncate max-w-[110px]'>
                              {item.currentBranch}
                            </span>
                          )}
                          {!item.isGit && (
                            <span className='ml-auto text-[10px] text-amber-400 flex-shrink-0'>
                              {item.error || '非 Git 仓库'}
                            </span>
                          )}
                        </div>
                        <p
                          className='text-[10px] font-mono text-[var(--ui-text-faint)] truncate mt-0.5'
                          title={item.path}
                        >
                          {item.path}
                        </p>
                      </div>
                    </label>
                  );
                })
              )}
            </div>

            <div className='grid grid-cols-3 gap-2'>
              <input
                value={multiBranch}
                onChange={(e) => setMultiBranch(e.target.value)}
                disabled={Boolean(busy)}
                placeholder='统一分支名（留空自动生成）'
                className='col-span-2 h-8 px-2.5 rounded-lg bg-[var(--ui-input-bg)] border border-[color:var(--ui-border-hairline)] text-[11px] font-mono text-[var(--ui-text-secondary)] outline-none focus:border-[var(--ui-accent-blue-border)]'
              />
              <input
                value={multiBase}
                onChange={(e) => setMultiBase(e.target.value)}
                disabled={Boolean(busy)}
                placeholder='基线 (HEAD)'
                className='col-span-1 h-8 px-2.5 rounded-lg bg-[var(--ui-input-bg)] border border-[color:var(--ui-border-hairline)] text-[11px] font-mono text-[var(--ui-text-secondary)] outline-none focus:border-[var(--ui-accent-blue-border)]'
              />
            </div>

            {multiError && (
              <p className='text-[11px] text-rose-400 leading-relaxed break-words'>{multiError}</p>
            )}

            <div className='flex items-center justify-between pt-1'>
              <span className='text-[10.5px] text-[var(--ui-text-faint)]'>
                已选 {selectedPaths.length} / {dirChecks.filter((d) => d.isGit).length} 个 Git 目录
              </span>
              <div className='flex items-center gap-2'>
                <button
                  onClick={() => setMultiModalOpen(false)}
                  disabled={Boolean(busy)}
                  className='h-8 px-3 rounded-lg border border-[color:var(--ui-border-hairline)] bg-[var(--ui-chip-bg)] text-[11.5px] text-[var(--ui-text-secondary)] hover:bg-[var(--ui-block-hover-bg)] disabled:opacity-50'
                >
                  取消
                </button>
                <button
                  onClick={handleConfirmMultiCreate}
                  disabled={Boolean(busy) || multiLoading || selectedPaths.length === 0}
                  className='h-8 px-3 rounded-lg bg-[var(--ui-accent-blue-soft)] border border-[color:var(--ui-accent-blue-border)] text-[11.5px] font-medium text-[var(--ui-accent-blue)] hover:brightness-110 disabled:opacity-50 flex items-center gap-1.5'
                >
                  {busy === 'create-multi' ? (
                    <Loader2 size={12} className='animate-spin' />
                  ) : (
                    <Plus size={12} />
                  )}
                  创建并切换会话
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default WorktreeCard;
