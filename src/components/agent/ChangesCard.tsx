import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Check, FileDiff, GitBranch, ShieldCheck } from 'lucide-react';
import { useChatStore } from '@/stores/chatStore';

export const ChangesCard: React.FC = () => {
  const [isOpen, setIsOpen] = useState(true);
  const [committing, setCommitting] = useState(false);
  const [committed, setCommitted] = useState(false);

  const { gitStatus, sessions, activeSessionId } = useChatStore();
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const hasWorkDir = !!activeSession?.workDir;

  const insertions = gitStatus?.insertions ?? 0;
  const deletions = gitStatus?.deletions ?? 0;
  const modifiedFiles = gitStatus?.modifiedFiles || [];
  const hasChanges = modifiedFiles.length > 0 || insertions > 0 || deletions > 0;

  const handleCommit = () => {
    setCommitting(true);
    setTimeout(() => {
      setCommitting(false);
      setCommitted(true);
      setTimeout(() => setCommitted(false), 2500);
    }, 600);
  };

  return (
    <div className='bg-[#1c1c1c] border border-[#2b2b2b] rounded-2xl overflow-hidden transition-all duration-200 select-none titlebar-no-drag'>
      {/* 头部标题与折叠开关 */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className='w-full flex items-center justify-between px-4 py-3 text-left hover:bg-white/[0.02] transition-colors'
      >
        <div className='flex items-center gap-2'>
          <span className='font-semibold text-sm text-neutral-200 tracking-wide'>
            Changes (代码变更)
          </span>
          {gitStatus?.isGit && (
            <span className='text-[10px] text-neutral-500 font-mono'>
              ({gitStatus.branch || 'main'})
            </span>
          )}
        </div>
        <div className='text-neutral-400'>
          {isOpen ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
        </div>
      </button>

      {/* 折叠内容 */}
      {isOpen && (
        <div className='px-4 pb-3.5 pt-0.5 flex flex-col gap-2'>
          {!hasWorkDir ? (
            <div className='py-3 text-center text-xs text-neutral-500'>
              请先在上方指定工作空间目录
            </div>
          ) : !gitStatus?.isGit ? (
            <div className='py-3 text-center text-xs text-neutral-500'>
              当前工作目录未初始化 Git 仓库
            </div>
          ) : !hasChanges ? (
            <div className='py-3 flex items-center justify-center gap-1.5 text-xs text-neutral-400'>
              <ShieldCheck size={14} className='text-emerald-500' />
              <span>工作区干净，无未提交修改</span>
            </div>
          ) : (
            <div className='flex flex-col gap-2'>
              {/* 总增删行与 Commit 按钮 */}
              <div className='flex items-center justify-between py-1 px-1 bg-[#222222] border border-[#2e2e2e] rounded-xl px-2.5 py-1.5'>
                <div className='flex items-center gap-2 font-mono text-xs'>
                  <span className='text-emerald-400 font-semibold'>
                    +{insertions.toLocaleString()}
                  </span>
                  <span className='text-rose-400 font-semibold'>
                    −{deletions.toLocaleString()}
                  </span>
                  <span className='text-[11px] text-neutral-500'>
                    ({modifiedFiles.length} 个文件)
                  </span>
                </div>

                <button
                  onClick={handleCommit}
                  disabled={committing || committed}
                  className='px-2.5 py-1 text-[11px] font-medium bg-[#2e2e2e] hover:bg-[#383838] active:bg-[#252525] text-neutral-200 rounded-lg transition-colors flex items-center gap-1 flex-shrink-0 border border-[#3a3a3a] shadow-sm cursor-pointer'
                >
                  {committed ? (
                    <>
                      <Check size={11} className='text-emerald-400' />
                      <span>Committed</span>
                    </>
                  ) : committing ? (
                    <span>...</span>
                  ) : (
                    <span>Commit changes</span>
                  )}
                </button>
              </div>

              {/* 变更文件列表 (支持全部文件顺畅滚动浏览) */}
              <div className='flex flex-col gap-1 max-h-[170px] min-h-[60px] overflow-y-auto custom-scrollbar pt-1 pr-1 overscroll-contain select-text'>
                {modifiedFiles.map((file, idx) => {
                  const shortName = file.path.split('/').pop() || file.path;
                  return (
                    <div
                      key={idx}
                      className='flex items-center justify-between py-1 px-2 rounded-lg bg-[#202020] hover:bg-[#252525] text-xs transition-colors'
                      title={file.path}
                    >
                      <div className='flex items-center gap-2 min-w-0 pr-2'>
                        <span
                          className={`w-3.5 h-3.5 rounded flex items-center justify-center font-mono text-[9px] font-bold flex-shrink-0 ${
                            file.status === 'M'
                              ? 'bg-amber-500/20 text-amber-400'
                              : file.status === 'D'
                              ? 'bg-rose-500/20 text-rose-400'
                              : 'bg-emerald-500/20 text-emerald-400'
                          }`}
                        >
                          {file.status || 'M'}
                        </span>
                        <span className='font-mono text-neutral-300 text-[11px] truncate'>
                          {shortName}
                        </span>
                      </div>
                      <span className='text-[10px] text-neutral-500 font-mono truncate max-w-[130px]'>
                        {file.path}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ChangesCard;
