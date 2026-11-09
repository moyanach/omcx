import React, { useState, useEffect } from 'react';
import {
  FolderGit2,
  Folder,
  Layers,
  ExternalLink,
  MessageSquare,
  Plus,
  ArrowRight,
  Edit3,
} from 'lucide-react';
import { useChatStore, WorkspaceItem } from '@/stores/chatStore';
import { useAppStore } from '@/stores/appStore';
import EditWorkspaceModal, { WorkspaceData } from '@/components/agent/EditWorkspaceModal';

export const WorkspacesView: React.FC = () => {
  const {
    sessions,
    activeSessionId,
    activeWorkspaceId,
    setActiveWorkspace,
    workspaces,
    fetchWorkspaces,
    saveWorkspace,
    deleteWorkspace,
  } = useChatStore();

  const { setActiveNavTab } = useAppStore();

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingWorkspace, setEditingWorkspace] = useState<WorkspaceData | null>(null);

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const currentWorkDir = activeSession?.workDir;

  useEffect(() => {
    fetchWorkspaces();
  }, []);

  // 打开编辑弹窗 (对应图 8)
  const handleOpenEditModal = (ws?: WorkspaceItem) => {
    const target = ws || {
      id: `ws_${Date.now()}`,
      name: '新多目录工作空间',
      folders: [],
    };
    setEditingWorkspace(target);
    setIsModalOpen(true);
  };

  // 切换到指定空间并激活对应会话
  const handleEnterWorkspace = async (ws: WorkspaceItem) => {
    await setActiveWorkspace(ws.id);
    setActiveNavTab('sessions');
  };

  // 在系统访达中定位
  const handleReveal = (path: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (window.electronAPI?.showInFolder) {
      window.electronAPI.showInFolder(path);
    }
  };

  return (
    <>
      <div className='flex-1 h-full flex flex-col bg-[#161616] overflow-hidden text-neutral-200 select-none'>
        {/* 顶部 Header */}
        <div className='h-[56px] border-b border-[#242424] bg-[#141414] px-6 flex items-center justify-between flex-shrink-0'>
          <div className='flex items-center gap-3'>
            <div className='w-8 h-8 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400'>
              <Layers size={16} />
            </div>
            <div>
              <h1 className='text-sm font-semibold text-neutral-100'>
                多目录工作空间管理中心 (Multi-Folder Workspaces)
              </h1>
              <p className='text-[11px] text-neutral-500'>
                支持全栈前后端、微服务多源文件夹挂载与跨仓库协同
              </p>
            </div>
          </div>

          <button
            onClick={() => handleOpenEditModal()}
            className='h-8 px-3 rounded-xl bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors shadow-sm'
          >
            <Plus size={14} />
            <span>新建多目录工作区</span>
          </button>
        </div>

        {/* 工作空间大卡片看板矩阵 */}
        <div className='flex-1 overflow-y-auto p-6 custom-scrollbar'>
          <div className='grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4'>
            {workspaces.map((ws) => {
              const isCurrent = activeWorkspaceId
                ? ws.id === activeWorkspaceId
                : ws.folders.some((f) => f.path === currentWorkDir);
              const projectSessions = sessions.filter((s) =>
                s.workspaceId
                  ? s.workspaceId === ws.id
                  : ws.folders.some((f) => f.path === s.workDir)
              );

              return (
                <div
                  key={ws.id}
                  className={`p-4 rounded-2xl bg-[#1c1c1c] border transition-all duration-200 flex flex-col justify-between gap-3 group ${
                    isCurrent
                      ? 'border-blue-500/60 shadow-lg shadow-blue-500/5 bg-[#1f1f1f]'
                      : 'border-[#292929] hover:border-[#3a3a3a] hover:bg-[#1e1e1e]'
                  }`}
                >
                  {/* 头部信息与编辑按钮 */}
                  <div className='flex flex-col gap-2'>
                    <div className='flex items-center justify-between'>
                      <div className='flex items-center gap-2 min-w-0'>
                        <span className='font-bold text-sm text-neutral-100 truncate'>
                          {ws.name}
                        </span>
                        {isCurrent && (
                          <span className='px-2 py-0.5 rounded-full text-[10px] font-mono bg-blue-500/20 text-blue-400 border border-blue-500/30 flex-shrink-0'>
                            当前生效
                          </span>
                        )}
                      </div>
                      <button
                        onClick={() => handleOpenEditModal(ws)}
                        className='p-1 rounded text-neutral-500 hover:text-white transition-colors'
                        title='编辑此多目录项目 (图 8 弹窗)'
                      >
                        <Edit3 size={13} />
                      </button>
                    </div>

                    {/* 挂载的源文件夹列表 */}
                    <div className='flex flex-col gap-1.5 bg-[#161616] border border-[#242424] rounded-xl p-2.5 max-h-[130px] overflow-y-auto custom-scrollbar'>
                      <span className='text-[10px] font-semibold text-neutral-400 uppercase tracking-wider'>
                        源文件夹 ({ws.folders.length}):
                      </span>
                      {ws.folders.map((f, idx) => (
                        <div
                          key={idx}
                          className='flex items-center justify-between text-xs py-0.5 hover:text-white'
                        >
                          <div className='flex items-center gap-1.5 min-w-0 pr-1'>
                            <Folder size={12} className='text-neutral-400 flex-shrink-0' />
                            <span className='text-[11px] font-medium text-neutral-300 truncate'>
                              {f.name}
                            </span>
                            {f.isPrimary && (
                              <span className='px-1.5 py-0.2 rounded text-[9px] bg-[#262626] text-neutral-400 border border-[#333] flex-shrink-0'>
                                主要
                              </span>
                            )}
                          </div>
                          <button
                            onClick={(e) => handleReveal(f.path, e)}
                            className='text-neutral-500 hover:text-neutral-300'
                            title='打开'
                          >
                            <ExternalLink size={10} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* 统计与进入动作 */}
                  <div className='flex items-center justify-between pt-1 border-t border-[#262626]'>
                    <div className='flex items-center gap-1.5 text-xs text-neutral-400 font-mono'>
                      <MessageSquare size={12} className='text-blue-400' />
                      <span>{projectSessions.length} 个会话</span>
                    </div>

                    <button
                      onClick={() => handleEnterWorkspace(ws)}
                      className={`px-3 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-all ${
                        isCurrent
                          ? 'bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 border border-blue-500/30'
                          : 'bg-[#272727] hover:bg-[#323232] text-neutral-200 border border-[#383838]'
                      }`}
                    >
                      <span>{isCurrent ? '进入会话' : '切换至此'}</span>
                      <ArrowRight size={12} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* 100% 还原参考图 8 的编辑项目 Modal 弹窗 */}
      <EditWorkspaceModal
        isOpen={isModalOpen}
        workspace={editingWorkspace}
        onClose={() => setIsModalOpen(false)}
        onSave={async (updated) => {
          await saveWorkspace(updated);
        }}
        onDelete={async (id) => {
          await deleteWorkspace(id);
        }}
      />
    </>
  );
};

export default WorkspacesView;
