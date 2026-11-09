import React, { useState, useEffect } from 'react';
import {
  FolderGit2,
  Plus,
  ChevronDown,
  ChevronRight,
  MessageSquare,
  Archive,
  ArchiveRestore,
  Trash2,
  FolderOpen,
  Check,
} from 'lucide-react';
import { useChatStore, Session } from '@/stores/chatStore';

export interface WorkspaceGroup {
  path: string;
  name: string;
  sessions: Session[];
}

export const WorkspaceSessionsPanel: React.FC = () => {
  const {
    sessions,
    activeSessionId,
    setActiveSession,
    addSession,
    saveWorkspace,
    setSessionWorkDir,
    archiveSession,
    deleteSession,
  } = useChatStore();

  const [expandedPaths, setExpandedPaths] = useState<Record<string, boolean>>({});

  // 整理出所有工作空间及其下属会话
  const workspacesMap: Record<string, WorkspaceGroup> = {};

  sessions.forEach((s) => {
    const wPath = s.workDir || 'unassigned';
    const wName = s.workDir
      ? s.workDir.split(/[\\/]/).filter(Boolean).pop() || s.workDir
      : '未绑定工作空间';

    if (!workspacesMap[wPath]) {
      workspacesMap[wPath] = {
        path: wPath,
        name: wName,
        sessions: [],
      };
    }
    workspacesMap[wPath].sessions.push(s);
  });

  const workspaceList = Object.values(workspacesMap);

  // 默认展开第一个工作空间
  useEffect(() => {
    if (workspaceList.length > 0 && Object.keys(expandedPaths).length === 0) {
      setExpandedPaths({ [workspaceList[0].path]: true });
    }
  }, [workspaceList.length]);

  const toggleExpand = (path: string) => {
    setExpandedPaths((prev) => ({
      ...prev,
      [path]: !prev[path],
    }));
  };

  // 添加新工作区目录
  const handleAddWorkspace = async () => {
    if (window.electronAPI?.dialogSelectWorkDirectory) {
      const dir = await window.electronAPI.dialogSelectWorkDirectory();
      if (dir) {
        const folderName = dir.split(/[\\/]/).filter(Boolean).pop() || dir;
        const wsId = `ws_${Date.now()}`;
        await saveWorkspace({
          id: wsId,
          name: folderName,
          folders: [{ path: dir, name: folderName, isPrimary: true }],
        });
        await addSession({ workspaceId: wsId, workDir: dir });
      }
    }
  };

  return (
    <div className='w-[270px] h-full bg-[#141414] border-r border-[#222222] flex flex-col flex-shrink-0 select-none'>
      {/* 顶部标题与新建工作空间按钮 */}
      <div className='h-12 px-3.5 border-b border-[#202020] flex items-center justify-between flex-shrink-0'>
        <div className='flex items-center gap-2'>
          <FolderGit2 size={15} className='text-blue-400' />
          <span className='text-xs font-semibold text-neutral-200 tracking-wide uppercase'>
            空间会话树
          </span>
        </div>
        <button
          onClick={handleAddWorkspace}
          className='w-6 h-6 flex items-center justify-center rounded-lg bg-[#1f1f1f] text-neutral-300 hover:text-white hover:bg-[#282828] border border-[#2d2d2d] transition-colors'
          title='导入新工作空间'
        >
          <Plus size={13} />
        </button>
      </div>

      {/* 工作空间列表及下属所有会话 (支持归档与删除) */}
      <div className='flex-1 overflow-y-auto p-2 flex flex-col gap-1.5 custom-scrollbar'>
        {workspaceList.map((ws) => {
          const isExpanded = !!expandedPaths[ws.path];
          const hasActiveSession = ws.sessions.some((s) => s.id === activeSessionId);

          return (
            <div
              key={ws.path}
              className='rounded-xl bg-[#1a1a1a] border border-[#262626] overflow-hidden transition-all'
            >
              {/* 工作空间头部项 */}
              <div
                onClick={() => toggleExpand(ws.path)}
                className={`px-3 py-2 flex items-center justify-between cursor-pointer hover:bg-white/[0.03] transition-colors ${
                  hasActiveSession ? 'bg-blue-500/[0.03]' : ''
                }`}
              >
                <div className='flex items-center gap-2 min-w-0 pr-1'>
                  <div className='text-neutral-500'>
                    {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </div>
                  <span className='font-semibold text-xs text-neutral-200 truncate'>
                    {ws.name}
                  </span>
                </div>
                <span className='text-[10px] font-mono text-neutral-500 bg-[#222] px-1.5 py-0.5 rounded border border-[#2d2d2d] flex-shrink-0'>
                  {ws.sessions.length}
                </span>
              </div>

              {/* 展开展示该工作空间下的所有会话 (支持归档、删除) */}
              {isExpanded && (
                <div className='border-t border-[#232323] bg-[#161616] p-1.5 flex flex-col gap-1'>
                  {ws.sessions.length === 0 ? (
                    <div className='py-2 text-center text-[10px] text-neutral-500'>
                      暂无下属会话
                    </div>
                  ) : (
                    ws.sessions.map((session) => {
                      const isActive = activeSessionId === session.id;

                      return (
                        <div
                          key={session.id}
                          onClick={() => setActiveSession(session.id)}
                          className={`group flex items-center justify-between px-2.5 py-1.5 rounded-lg cursor-pointer transition-all border ${
                            isActive
                              ? 'bg-blue-500/10 text-blue-300 border-blue-500/25 font-medium'
                              : 'text-neutral-400 hover:text-neutral-200 hover:bg-white/[0.03] border-transparent'
                          }`}
                        >
                          <div className='flex items-center gap-2 min-w-0 pr-2'>
                            <MessageSquare
                              size={12}
                              className={isActive ? 'text-blue-400' : 'text-neutral-500'}
                            />
                            <span className='text-xs truncate tracking-tight'>
                              {session.title || '新会话'}
                            </span>
                            {session.archived && (
                              <span className='px-1 py-0.2 rounded text-[9px] bg-neutral-800 text-neutral-400 flex-shrink-0'>
                                归档
                              </span>
                            )}
                          </div>

                          {/* 悬浮操作：归档 / 删除按钮 */}
                          <div className='flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0'>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                archiveSession(session.id, !session.archived);
                              }}
                              className='p-1 rounded text-neutral-500 hover:text-neutral-200 hover:bg-white/[0.08] transition-colors'
                              title={session.archived ? '取消归档' : '归档会话'}
                            >
                              {session.archived ? (
                                <ArchiveRestore size={11} className='text-amber-400' />
                              ) : (
                                <Archive size={11} />
                              )}
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                deleteSession(session.id);
                              }}
                              className='p-1 rounded text-neutral-500 hover:text-rose-400 hover:bg-rose-500/10 transition-colors'
                              title='删除会话'
                            >
                              <Trash2 size={11} />
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default WorkspaceSessionsPanel;
