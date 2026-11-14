import React, { useState, useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  FolderGit2,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  GitBranch,
  Plus,
  Folder,
  Edit3,
  Layers,
} from 'lucide-react';
import { useChatStore, WorkspaceItem } from '@/stores/chatStore';
import EditWorkspaceModal, { WorkspaceData } from './EditWorkspaceModal';
import BranchSwitchPopover from './BranchSwitchPopover';

export const WorkspaceCard: React.FC = () => {
  const [isOpen, setIsOpen] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingWorkspace, setEditingWorkspace] = useState<WorkspaceData | null>(null);

  // 快速切换分支浮层目标
  const [popoverTarget, setPopoverTarget] = useState<{
    workDir: string;
    folderName: string;
    currentBranch?: string;
    anchorEl: HTMLElement | null;
  } | null>(null);

  const {
    activeSessionId,
    activeWorkspaceId,
    sessions,
    setSessionWorkDir,
    gitStatus,
    gitRevision,
    refreshGitStatus,
    workspaces,
    fetchWorkspaces,
    saveWorkspace,
    deleteWorkspace,
  } = useChatStore(
    useShallow((s) => ({
      activeSessionId: s.activeSessionId,
      activeWorkspaceId: s.activeWorkspaceId,
      sessions: s.sessions,
      setSessionWorkDir: s.setSessionWorkDir,
      gitStatus: s.gitStatus,
      gitRevision: s.gitRevision,
      refreshGitStatus: s.refreshGitStatus,
      workspaces: s.workspaces,
      fetchWorkspaces: s.fetchWorkspaces,
      saveWorkspace: s.saveWorkspace,
      deleteWorkspace: s.deleteWorkspace,
    }))
  );

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const currentWorkDir = activeSession?.workDir;

  const [folderGitMap, setFolderGitMap] = useState<
    Record<string, { isGit: boolean; branch?: string }>
  >({});
  const [worktreeInfo, setWorktreeInfo] = useState<{
    isManagedWorktree: boolean;
    path?: string;
    branch?: string;
    sourceBranch?: string;
    repoRoot?: string;
    groupEntries?: Array<{
      name: string;
      sourcePath: string;
      repoRoot: string;
      worktreePath: string;
      branch: string;
      sourceBranch?: string;
      isPrimary?: boolean;
    }>;
  } | null>(null);

  useEffect(() => {
    fetchWorkspaces();
  }, []);

  useEffect(() => {
    let alive = true;
    if (!currentWorkDir || !window.electronAPI?.inspectManagedWorktree) {
      setWorktreeInfo(null);
      return;
    }
    window.electronAPI
      .inspectManagedWorktree(currentWorkDir, activeSessionId || '')
      .then((res: any) => {
        if (!alive) return;
        if (res?.success && (res.isManagedWorktree || (Array.isArray(res.groupEntries) && res.groupEntries.length > 0))) {
          setWorktreeInfo(res);
        } else {
          setWorktreeInfo(null);
        }
      })
      .catch(() => {
        if (alive) setWorktreeInfo(null);
      });
    return () => {
      alive = false;
    };
  }, [currentWorkDir, activeSessionId]);

  // 匹配当前会话绑定的工作空间 (优先通过 session.workspaceId 或 activeWorkspaceId，降级匹配目录)
  const currentWorkspace = workspaces.find(
    (ws) =>
      ws.id === activeSession?.workspaceId ||
      ws.id === activeWorkspaceId ||
      ws.folders.some((f) => f.path === currentWorkDir)
  ) || workspaces[0];

  // 异步获取各工作空间目录当前的 Git 分支状态
  useEffect(() => {
    let alive = true;
    const loadFolderGitBranches = () => {
      if (currentWorkspace?.folders && window.electronAPI?.getWorkspaceGitStatus) {
        Promise.all(
          currentWorkspace.folders.map(async (folder) => {
            try {
              const status = await window.electronAPI.getWorkspaceGitStatus(folder.path);
              return [folder.path, status] as const;
            } catch {
              return [folder.path, { isGit: false }] as const;
            }
          })
        ).then((entries) => {
          if (!alive) return;
          const nextMap: Record<string, { isGit: boolean; branch?: string }> = {};
          for (const [folderPath, status] of entries) {
            nextMap[folderPath] = { isGit: !!status?.isGit, branch: status?.branch };
          }
          setFolderGitMap(nextMap);
        });
      }
    };

    loadFolderGitBranches();
    return () => {
      alive = false;
    };
  }, [currentWorkspace?.folders, currentWorkDir, activeSessionId, gitStatus?.branch, gitStatus?.isGit, gitRevision]);

  // 打开快速切换分支浮层 (完全对齐用户参考截图)
  const handleOpenBranchPopover = (
    e: React.MouseEvent<HTMLButtonElement>,
    workDir: string,
    folderName: string,
    currentBranch?: string
  ) => {
    e.stopPropagation();
    setPopoverTarget({
      workDir,
      folderName,
      currentBranch,
      anchorEl: e.currentTarget,
    });
  };

  // 分支切换成功后联动刷新本地映射与全局 Git 状态
  const handleBranchSwitched = (folderPath: string, newBranch: string) => {
    setFolderGitMap((prev) => ({
      ...prev,
      [folderPath]: { ...prev[folderPath], branch: newBranch, isGit: true },
    }));
    if (currentWorkDir && refreshGitStatus) {
      refreshGitStatus(currentWorkDir);
    }
  };

  // 打开编辑弹窗 (对应参考图 8)
  const handleOpenEditModal = (ws?: WorkspaceItem) => {
    const target = ws || currentWorkspace || {
      id: `ws_${Date.now()}`,
      name: '新项目工作区',
      folders: currentWorkDir
        ? [{ path: currentWorkDir, name: currentWorkDir.split(/[\\/]/).filter(Boolean).pop() || 'main', isPrimary: true }]
        : [],
    };
    setEditingWorkspace(target);
    setIsModalOpen(true);
  };

  // 保存工作空间 (来自图 8 弹窗)
  const handleSaveWorkspaceModal = async (updated: WorkspaceData) => {
    await saveWorkspace(updated);
    // 仅当当前会话明确归属于该工作空间时，若其目录不在新目录列表中，才平滑迁移到新主目录
    if (activeSessionId && activeSession?.workspaceId === updated.id) {
      const isPathStillValid = updated.folders.some((f) => f.path === currentWorkDir);
      if (!isPathStillValid) {
        const primary = updated.folders.find((f) => f.isPrimary) || updated.folders[0];
        if (primary) {
          await setSessionWorkDir(activeSessionId, primary.path);
        }
      }
    }
  };

  // 移除工作空间
  const handleDeleteWorkspaceModal = async (workspaceId: string) => {
    await deleteWorkspace(workspaceId);
  };

  return (
    <>
      <div className='border-b border-[color:var(--ui-divider-hairline)] transition-colors select-none last:border-b-0'>
        {/* 头部标题与操作区 */}
        <div className='flex items-center justify-between px-4 py-3'>
          <button
            onClick={() => setIsOpen(!isOpen)}
            className='flex items-center gap-2 text-left hover:text-[var(--ui-text-primary)] transition-colors flex-1'
          >
            <FolderGit2 size={15} className='text-[var(--ui-accent-blue)]' />
            <span className='font-semibold text-xs text-[var(--ui-text-primary)] tracking-wide uppercase'>
              当前工作空间
            </span>
            <div className='text-[var(--ui-text-faint)] ml-auto mr-2'>
              {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </div>
          </button>
          <div className='flex items-center gap-1'>
            {/* 图 8 编辑弹窗触发按钮 */}
            <button
              onClick={() => handleOpenEditModal()}
              className='w-6 h-6 flex items-center justify-center rounded-lg bg-[var(--ui-chip-bg)] text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-chip-hover-bg)] transition-colors border border-[color:var(--ui-border-hairline)]'
              title='配置工作空间多源文件夹'
            >
              <Edit3 size={12} />
            </button>
            <button
              onClick={() => handleOpenEditModal({ id: '', name: '新多目录工作空间', folders: [] })}
              className='w-6 h-6 flex items-center justify-center rounded-lg bg-[var(--ui-chip-bg)] text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-chip-hover-bg)] transition-colors border border-[color:var(--ui-border-hairline)]'
              title='新建多目录工作空间'
            >
              <Plus size={13} />
            </button>
          </div>
        </div>

        {/* 折叠内容（直接平铺融入监控面板，与上下文/连接器等卡片保持一致） */}
        {isOpen && (
          <div className='px-4 pb-3.5 pt-0.5 flex flex-col gap-2.5'>
            {worktreeInfo && (worktreeInfo.isManagedWorktree || (worktreeInfo.groupEntries?.length || 0) > 0) ? (
              <div className='flex flex-col gap-2'>
                <div className='flex items-center justify-between gap-2'>
                  <div className='flex items-center gap-2 min-w-0'>
                    <div className='w-6 h-6 rounded-md bg-[var(--ui-accent-blue-soft)] border border-[color:var(--ui-accent-blue-border)] flex items-center justify-center text-[var(--ui-accent-blue)] flex-shrink-0'>
                      <FolderGit2 size={13} />
                    </div>
                    <span
                      className='font-bold text-xs text-[var(--ui-text-primary)] truncate'
                      title={worktreeInfo.path || currentWorkDir}
                    >
                      {currentWorkspace ? `${currentWorkspace.name} · 隔离工作树` : '隔离工作树'}
                    </span>
                  </div>
                  <span className='px-2 py-0.5 rounded-full bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)] text-[10px] font-mono border border-[color:var(--ui-accent-blue-border)] flex-shrink-0'>
                    {worktreeInfo.groupEntries && worktreeInfo.groupEntries.length > 1
                      ? `${worktreeInfo.groupEntries.length} 个 Worktree`
                      : 'Worktree'}
                  </span>
                </div>

                {worktreeInfo.groupEntries && worktreeInfo.groupEntries.length > 0 ? (
                  <div className='flex flex-col gap-1 border-t border-[color:var(--ui-divider-hairline)] pt-2 max-h-[140px] overflow-y-auto custom-scrollbar pr-0.5'>
                    {worktreeInfo.groupEntries.map((item) => (
                      <div
                        key={item.worktreePath}
                        className='flex items-center justify-between py-1 px-1.5 rounded-md hover:bg-[var(--ui-block-hover-bg)] text-xs gap-2'
                      >
                        <div className='flex items-center gap-2 min-w-0'>
                          <Folder size={12} className='text-[var(--ui-accent-blue)] flex-shrink-0' />
                          <span
                            className='text-[11px] font-medium text-[var(--ui-text-secondary)] truncate'
                            title={item.worktreePath}
                          >
                            {item.name}
                          </span>
                          {item.isPrimary && (
                            <span className='px-1.5 py-0.2 rounded text-[9px] bg-[var(--ui-chip-bg)] text-[var(--ui-text-secondary)] border border-[color:var(--ui-border-hairline)] flex-shrink-0'>
                              主要
                            </span>
                          )}
                        </div>
                        <span
                          className='flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-mono text-[var(--ui-accent-blue)] bg-[var(--ui-accent-blue-soft)] border border-[color:var(--ui-accent-blue-border)] flex-shrink-0 max-w-[120px]'
                          title={`分支：${item.branch}\n路径：${item.worktreePath}`}
                        >
                          <GitBranch size={10} className='flex-shrink-0' />
                          <span className='truncate font-medium'>{item.branch}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className='flex flex-col gap-1 border-t border-[color:var(--ui-divider-hairline)] pt-2'>
                    <div className='flex items-center justify-between py-1 px-1.5 rounded-md bg-[var(--ui-block-hover-bg)]/40 text-xs gap-2'>
                      <div className='flex items-center gap-2 min-w-0'>
                        <Folder size={12} className='text-[var(--ui-accent-blue)] flex-shrink-0' />
                        <span
                          className='text-[11px] font-medium text-[var(--ui-text-secondary)] truncate'
                          title={worktreeInfo.path || currentWorkDir}
                        >
                          {(worktreeInfo.path || currentWorkDir || '')
                            .split(/[\\/]/)
                            .filter(Boolean)
                            .pop() || 'worktree'}
                        </span>
                        <span className='px-1.5 py-0.2 rounded text-[9px] bg-[var(--ui-accent-emerald-soft)] text-[var(--ui-accent-emerald)] flex-shrink-0'>
                          当前
                        </span>
                      </div>
                      {worktreeInfo.branch && (
                        <span
                          className='flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-mono text-[var(--ui-accent-blue)] bg-[var(--ui-accent-blue-soft)] border border-[color:var(--ui-accent-blue-border)] flex-shrink-0 max-w-[130px]'
                          title={`当前工作树分支：${worktreeInfo.branch}`}
                        >
                          <GitBranch size={10} className='flex-shrink-0' />
                          <span className='truncate font-medium'>{worktreeInfo.branch}</span>
                        </span>
                      )}
                    </div>
                    <p
                      className='text-[10px] font-mono text-[var(--ui-text-faint)] truncate px-1.5'
                      title={worktreeInfo.path || currentWorkDir}
                    >
                      {worktreeInfo.path || currentWorkDir}
                    </p>
                    {worktreeInfo.sourceBranch && (
                      <p className='text-[10px] text-[var(--ui-text-faint)] px-1.5'>
                        来源分支：<span className='font-mono'>{worktreeInfo.sourceBranch}</span>
                      </p>
                    )}
                  </div>
                )}
              </div>
            ) : currentWorkspace ? (
              <div className='flex flex-col gap-2.5'>
                <div className='flex items-center justify-between'>
                  <div className='flex items-center gap-2 min-w-0'>
                    <div className='w-6 h-6 rounded-md bg-[var(--ui-accent-blue-soft)] border border-[color:var(--ui-accent-blue-border)] flex items-center justify-center text-[var(--ui-accent-blue)] flex-shrink-0'>
                      <Layers size={13} />
                    </div>
                    <span className='font-bold text-xs text-[var(--ui-text-primary)] truncate' title={currentWorkspace.name}>
                      {currentWorkspace.name}
                    </span>
                  </div>

                  <div className='flex items-center gap-1.5'>
                    <span className='px-2 py-0.5 rounded-full bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)] text-[10px] font-mono border border-[color:var(--ui-accent-blue-border)]'>
                      {currentWorkspace.folders.length} 个源目录
                    </span>
                    <button
                      onClick={() => handleOpenEditModal(currentWorkspace)}
                      className='p-1 rounded text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)]'
                      title='编辑此工作空间'
                    >
                      <Edit3 size={11} />
                    </button>
                  </div>
                </div>

                {/* 挂载的源文件夹列表 */}
                <div className='flex flex-col gap-1 border-t border-[color:var(--ui-divider-hairline)] pt-2 max-h-[140px] overflow-y-auto custom-scrollbar pr-0.5'>
                  {currentWorkspace.folders.map((folder, idx) => (
                    <div
                      key={idx}
                      className='flex items-center justify-between py-1 px-1.5 rounded-md hover:bg-[var(--ui-block-hover-bg)] text-xs'
                    >
                      <div className='flex items-center gap-2 min-w-0 pr-1'>
                        <Folder size={12} className='text-[var(--ui-text-muted)] flex-shrink-0' />
                        <span className='text-[11px] font-medium text-[var(--ui-text-secondary)] truncate'>
                          {folder.name}
                        </span>
                        {folder.isPrimary && (
                          <span className='px-1.5 py-0.2 rounded text-[9px] bg-[var(--ui-chip-bg)] text-[var(--ui-text-secondary)] border border-[color:var(--ui-border-hairline)] flex-shrink-0'>
                            主要
                          </span>
                        )}
                      </div>

                      {/* 优先展示 Git 分支快速切换按钮；非 Git 项目降级展示路径 */}
                      {(() => {
                        const gitInfo = folderGitMap[folder.path];
                        if (gitInfo?.isGit && gitInfo.branch) {
                          const isActivePopover = popoverTarget?.workDir === folder.path;
                          return (
                            <button
                              type='button'
                              onClick={(e) =>
                                handleOpenBranchPopover(e, folder.path, folder.name, gitInfo.branch)
                              }
                              className={`flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-mono transition-all cursor-pointer flex-shrink-0 group/branch select-none border ${
                                isActivePopover
                                  ? 'bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)] border-[color:var(--ui-accent-blue-border)] shadow-sm'
                                  : 'text-[var(--ui-accent-blue)] border-transparent hover:bg-[var(--ui-accent-blue-soft)] hover:border-[color:var(--ui-accent-blue-border)]'
                              }`}
                              title={`当前 Git 分支: ${gitInfo.branch} (点击快速切换分支)`}
                            >
                              <GitBranch size={10} className='text-[var(--ui-accent-blue)] flex-shrink-0' />
                              <span className='truncate max-w-[100px] font-medium'>{gitInfo.branch}</span>
                              <ChevronDown
                                size={9}
                                className={`opacity-60 group-hover/branch:opacity-100 transition-transform duration-150 flex-shrink-0 ${
                                  isActivePopover ? 'rotate-180 opacity-100' : ''
                                }`}
                              />
                            </button>
                          );
                        }
                        return (
                          <span
                            className='text-[10px] text-[var(--ui-text-faint)] font-mono truncate max-w-[120px]'
                            title={folder.path}
                          >
                            {folder.path.split(/[\\/]/).filter(Boolean).slice(-2).join('/')}
                          </span>
                        );
                      })()}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div
                onClick={() => handleOpenEditModal()}
                className='p-4 rounded-lg border border-dashed border-[color:var(--ui-border-subtle)] hover:border-[color:var(--ui-accent-blue-border)] hover:bg-[var(--ui-block-hover-bg)] flex flex-col items-center justify-center gap-1.5 cursor-pointer text-center transition-all'
              >
                <FolderOpen size={20} className='text-[var(--ui-text-muted)]' />
                <span className='text-xs font-medium text-[var(--ui-text-secondary)]'>暂无多目录工作空间</span>
                <span className='text-[10px] text-[var(--ui-text-faint)]'>点击配置多源文件夹，支持前后端跨目录工作</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 100% 还原参考图 8 的编辑项目 Modal 弹窗 */}
      <EditWorkspaceModal
        isOpen={isModalOpen}
        workspace={editingWorkspace}
        onClose={() => setIsModalOpen(false)}
        onSave={handleSaveWorkspaceModal}
        onDelete={handleDeleteWorkspaceModal}
      />

      {/* 快速切换 Git 分支浮层 (参照参考截图，完美自适应亮色/暗色双主题) */}
      {popoverTarget && (
        <BranchSwitchPopover
          workDir={popoverTarget.workDir}
          folderName={popoverTarget.folderName}
          currentBranch={popoverTarget.currentBranch}
          anchorEl={popoverTarget.anchorEl}
          isOpen={Boolean(popoverTarget)}
          onClose={() => setPopoverTarget(null)}
          onBranchSwitched={(newBranch) =>
            handleBranchSwitched(popoverTarget.workDir, newBranch)
          }
        />
      )}
    </>
  );
};

export default WorkspaceCard;
