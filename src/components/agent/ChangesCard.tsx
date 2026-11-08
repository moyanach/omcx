import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Check, FileDiff, GitBranch, ShieldCheck } from 'lucide-react';
import { useChatStore } from '@/stores/chatStore';

export const ChangesCard: React.FC = () => {
  const [isOpen, setIsOpen] = useState(true);
  const [committing, setCommitting] = useState(false);
  const [committed, setCommitted] = useState(false);

  const { gitStatus, sessions, activeSessionId, openDiffInWorkbench } = useChatStore();
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const hasWorkDir = !!activeSession?.workDir;

  const insertions = gitStatus?.insertions ?? 0;
  const deletions = gitStatus?.deletions ?? 0;
  const modifiedFiles = gitStatus?.modifiedFiles || [];
  const hasChanges = modifiedFiles.length > 0 || insertions > 0 || deletions > 0;

  const handleCommit = () => {
    openDiffInWorkbench();
  };

  return (
    <div className='bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-hairline)] rounded-2xl overflow-hidden transition-all duration-200 select-none titlebar-no-drag'>
      {/* 头部标题与折叠开关 */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className='w-full flex items-center justify-between px-4 py-3 text-left hover:bg-[var(--ui-block-hover-bg)] transition-colors'
      >
        <div className='flex items-center gap-2'>
          <span className='font-semibold text-sm text-[var(--ui-text-primary)] tracking-wide'>
            Changes (代码变更)
          </span>
          {gitStatus?.isGit && (
            <span className='text-[10px] text-[var(--ui-text-faint)] font-mono'>
              ({gitStatus.branch || 'main'})
            </span>
          )}
        </div>
        <div className='text-[var(--ui-text-faint)]'>
          {isOpen ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
        </div>
      </button>

      {/* 折叠内容 */}
      {isOpen && (
        <div className='px-4 pb-3.5 pt-0.5 flex flex-col gap-2'>
          {!hasWorkDir ? (
            <div className='py-3 text-center text-xs text-[var(--ui-text-faint)]'>
              请先在上方指定工作空间目录
            </div>
          ) : !gitStatus?.isGit ? (
            <div className='py-3 text-center text-xs text-[var(--ui-text-faint)]'>
              当前工作目录未初始化 Git 仓库
            </div>
          ) : !hasChanges ? (
            <div className='py-3 flex items-center justify-center gap-1.5 text-xs text-[var(--ui-text-muted)]'>
              <ShieldCheck size={14} className='text-[var(--ui-accent-emerald)]' />
              <span>工作区干净，无未提交修改</span>
            </div>
          ) : (
            <div className='flex flex-col gap-2'>
              {/* 总增删行与 Commit 按钮 */}
              <div className='flex items-center justify-between bg-[var(--ui-card-inner-bg)] border border-[color:var(--ui-border-hairline)] rounded-xl px-2.5 py-1.5'>
                <div className='flex items-center gap-2 font-mono text-xs'>
                  <span className='text-[var(--ui-accent-emerald)] font-semibold'>
                    +{insertions.toLocaleString()}
                  </span>
                  <span className='text-[var(--ui-accent-rose)] font-semibold'>
                    −{deletions.toLocaleString()}
                  </span>
                  <span className='text-[11px] text-[var(--ui-text-faint)]'>
                    ({modifiedFiles.length} 个文件)
                  </span>
                </div>

                <button
                  onClick={handleCommit}
                  disabled={committing || committed}
                  className='px-2.5 py-1 text-[11px] font-medium bg-[var(--ui-chip-bg)] hover:bg-[var(--ui-chip-hover-bg)] text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)] rounded-lg transition-colors flex items-center gap-1 flex-shrink-0 border border-[color:var(--ui-border-hairline)] cursor-pointer'
                >
                  {committed ? (
                    <>
                      <Check size={11} className='text-[var(--ui-accent-emerald)]' />
                      <span>Committed</span>
                    </>
                  ) : committing ? (
                    <span>...</span>
                  ) : (
                    <span>Commit changes</span>
                  )}
                </button>
              </div>

              {/* 变更文件列表 */}
              <div className='flex flex-col gap-1 max-h-[170px] min-h-[60px] overflow-y-auto custom-scrollbar pt-1 pr-1 overscroll-contain select-text'>
                {modifiedFiles.map((file, idx) => {
                  const shortName = file.path.split('/').pop() || file.path;
                  return (
                    <div
                      key={idx}
                      onClick={() => openDiffInWorkbench(file.path)}
                      className='flex items-center justify-between py-1 px-2 rounded-lg bg-[var(--ui-card-inner-bg)] hover:bg-[var(--ui-block-hover-bg)] text-xs transition-colors cursor-pointer'
                      title={`点击在右侧工作台查看 Diff: ${file.path}`}
                    >
                      <div className='flex items-center gap-2 min-w-0 pr-2'>
                        <span
                          className={`w-3.5 h-3.5 rounded flex items-center justify-center font-mono text-[9px] font-bold flex-shrink-0 ${
                            file.status === 'M'
                              ? 'bg-[var(--ui-accent-amber-soft)] text-[var(--ui-accent-amber)]'
                              : file.status === 'D'
                              ? 'bg-[var(--ui-accent-rose-soft)] text-[var(--ui-accent-rose)]'
                              : 'bg-[var(--ui-accent-emerald-soft)] text-[var(--ui-accent-emerald)]'
                          }`}
                        >
                          {file.status || 'M'}
                        </span>
                        <span className='font-mono text-[var(--ui-text-secondary)] text-[11px] truncate'>
                          {shortName}
                        </span>
                      </div>
                      <span className='text-[10px] text-[var(--ui-text-faint)] font-mono truncate max-w-[130px]'>
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
