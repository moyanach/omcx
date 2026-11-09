import React, { useState, useEffect } from 'react';
import {
  FolderGit2,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  GitBranch,
  ExternalLink,
  Plus,
  Check,
  Folder,
  Edit3,
  Layers,
} from 'lucide-react';
import { useChatStore, WorkspaceItem } from '@/stores/chatStore';
import EditWorkspaceModal, { WorkspaceData } from './EditWorkspaceModal';

export const WorkspaceCard: React.FC = () => {
  const [isOpen, setIsOpen] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingWorkspace, setEditingWorkspace] = useState<WorkspaceData | null>(null);

  const {
    activeSessionId,
    activeWorkspaceId,
    setActiveWorkspace,
    sessions,
    setSessionWorkDir,
    gitStatus,
    workspaces,
    fetchWorkspaces,
    saveWorkspace,
    deleteWorkspace,
  } = useChatStore();

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const currentWorkDir = activeSession?.workDir;

  const [folderGitMap, setFolderGitMap] = useState<
    Record<string, { isGit: boolean; branch?: string }>
  >({});

  useEffect(() => {
    fetchWorkspaces();
  }, []);

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
    return () => {
      alive = false;
    };
  }, [currentWorkspace?.folders, currentWorkDir]);

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

  // 切换当前会话绑定的工作空间
  const handleSwitchWorkspace = async (ws: WorkspaceItem) => {
    if (!activeSessionId) return;
    const primaryFolder = ws.folders.find((f) => f.isPrimary) || ws.folders[0];
    if (primaryFolder) {
      await setSessionWorkDir(activeSessionId, primaryFolder.path);
    }
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
      <div className='bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-hairline)] rounded-2xl overflow-hidden transition-all duration-200 select-none'>
        {/* 头部标题与操作区 */}
        <div className='flex items-center justify-between px-4 py-3 bg-[var(--ui-card-header-bg)] border-b border-[color:var(--ui-divider-hairline)]'>
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

        {/* 折叠内容 */}
        {isOpen && (
          <div className='p-3.5 flex flex-col gap-3'>
            {/* 1. 当前工作空间卡片 (展示工作空间名称 + 挂载的全部源文件夹) */}
            {currentWorkspace ? (
              <div className='p-3 rounded-xl bg-[var(--ui-card-inner-bg)] border border-[color:var(--ui-border-hairline)] flex flex-col gap-2.5'>
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

                      {/* 优先展示 Git 分支；非 Git 项目降级展示路径 */}
                      {(() => {
                        const gitInfo = folderGitMap[folder.path];
                        if (gitInfo?.isGit && gitInfo.branch) {
                          return (
                            <span
                              className='flex items-center gap-1 text-[10px] text-[var(--ui-accent-blue)] font-mono flex-shrink-0'
                              title={`当前 Git 分支: ${gitInfo.branch}`}
                            >
                              <GitBranch size={10} className='text-[var(--ui-accent-blue)] flex-shrink-0' />
                              <span className='truncate max-w-[110px]'>{gitInfo.branch}</span>
                            </span>
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
                className='p-4 rounded-xl border border-dashed border-[color:var(--ui-border-subtle)] hover:border-[color:var(--ui-accent-blue-border)] bg-[var(--ui-card-inner-bg)] hover:bg-[var(--ui-block-hover-bg)] flex flex-col items-center justify-center gap-1.5 cursor-pointer text-center transition-all'
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
    </>
  );
};

export default WorkspaceCard;
