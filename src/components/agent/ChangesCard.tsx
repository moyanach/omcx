import React, { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  GitBranch,
  ShieldCheck,
  ListChecks,
  GitPullRequest,
  Loader2,
  X,
} from 'lucide-react';
import { useChatStore } from '@/stores/chatStore';
import HunkStagingModal from './HunkStagingModal';

export const ChangesCard: React.FC = () => {
  const [isOpen, setIsOpen] = useState(true);
  const [committing, setCommitting] = useState(false);
  const [commitOpen, setCommitOpen] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const [hunkFile, setHunkFile] = useState<string | null>(null);
  const [prOpen, setPrOpen] = useState(false);
  const [prTitle, setPrTitle] = useState('');
  const [prBody, setPrBody] = useState('');
  const [prDraft, setPrDraft] = useState(false);
  const [prBusy, setPrBusy] = useState(false);
  const [prResult, setPrResult] = useState<{ success: boolean; text: string } | null>(null);
  const [message, setMessage] = useState('');

  const { gitStatus, sessions, activeSessionId, openDiffInWorkbench, refreshGitStatus } =
    useChatStore();
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const workDir = activeSession?.workDir || '';
  const hasWorkDir = !!workDir;

  const insertions = gitStatus?.insertions ?? 0;
  const deletions = gitStatus?.deletions ?? 0;
  const modifiedFiles = gitStatus?.modifiedFiles || [];
  const hasChanges = modifiedFiles.length > 0 || insertions > 0 || deletions > 0;

  const handleCommit = async (stageAll: boolean) => {
    if (!window.electronAPI || !workDir) return;
    if (!commitMessage.trim()) {
      setMessage('请填写提交信息');
      return;
    }
    setCommitting(true);
    setMessage('');
    try {
      if (stageAll) {
        const staged = await window.electronAPI.stageAllGitChanges(workDir);
        if (!staged?.success) {
          setMessage(staged?.error || '暂存全部变更失败');
          return;
        }
      }
      const result = await window.electronAPI.commitWorkspaceChanges(
        workDir,
        commitMessage.trim()
      );
      if (!result?.success) {
        setMessage(result?.error || '提交失败');
        return;
      }
      setMessage(`已提交：${result.commitHash || result.hash || '成功'}`);
      setCommitMessage('');
      setCommitOpen(false);
      await refreshGitStatus(workDir);
    } catch (err: any) {
      setMessage(err?.message || String(err));
    } finally {
      setCommitting(false);
    }
  };

  const handleCreatePr = async () => {
    if (!window.electronAPI || !workDir) return;
    if (!prTitle.trim()) {
      setPrResult({ success: false, text: '请填写 PR 标题' });
      return;
    }
    setPrBusy(true);
    setPrResult(null);
    try {
      const result = await window.electronAPI.createGitPullRequest({
        workDir,
        title: prTitle.trim(),
        body: prBody,
        draft: prDraft,
      });
      setPrResult({
        success: Boolean(result?.success),
        text: result?.success ? `PR 已创建：${result.url}` : result?.error || '创建失败',
      });
    } catch (err: any) {
      setPrResult({ success: false, text: err?.message || String(err) });
    } finally {
      setPrBusy(false);
    }
  };

  const openPrModal = () => {
    setPrTitle(activeSession?.title || '');
    setPrBody('');
    setPrResult(null);
    setPrOpen(true);
  };

  return (
    <div className='border-b border-[color:var(--ui-divider-hairline)] transition-colors select-none titlebar-no-drag last:border-b-0'>
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
              <div className='flex items-center justify-between bg-[var(--ui-block-bg)] rounded-lg px-2.5 py-1.5 gap-2'>
                <div className='flex items-center gap-2 font-mono text-xs min-w-0'>
                  <span className='text-[var(--ui-accent-emerald)] font-semibold'>
                    +{insertions.toLocaleString()}
                  </span>
                  <span className='text-[var(--ui-accent-rose)] font-semibold'>
                    −{deletions.toLocaleString()}
                  </span>
                  <span className='text-[11px] text-[var(--ui-text-faint)] truncate'>
                    ({modifiedFiles.length} 个文件)
                  </span>
                </div>

                <div className='flex items-center gap-1 flex-shrink-0'>
                  <button
                    onClick={openPrModal}
                    className='px-2 py-1 text-[11px] font-medium bg-[var(--ui-chip-bg)] hover:bg-[var(--ui-chip-hover-bg)] text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)] rounded-lg transition-colors flex items-center gap-1 border border-[color:var(--ui-border-hairline)] cursor-pointer'
                    title='创建 Pull Request'
                  >
                    <GitPullRequest size={11} />
                    <span>PR</span>
                  </button>
                  <button
                    onClick={() => setCommitOpen((v) => !v)}
                    className='px-2.5 py-1 text-[11px] font-medium bg-[var(--ui-chip-bg)] hover:bg-[var(--ui-chip-hover-bg)] text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)] rounded-lg transition-colors flex items-center gap-1 border border-[color:var(--ui-border-hairline)] cursor-pointer'
                  >
                    <GitBranch size={11} />
                    <span>Commit</span>
                  </button>
                </div>
              </div>

              {/* 提交面板 */}
              {commitOpen && (
                <div className='rounded-lg bg-[var(--ui-block-bg)] p-2.5 space-y-2'>
                  <textarea
                    value={commitMessage}
                    onChange={(e) => setCommitMessage(e.target.value)}
                    placeholder='提交信息，例如 feat: 支持 Hunk 级暂存'
                    rows={2}
                    className='w-full resize-none bg-[var(--ui-input-bg)] border border-[color:var(--ui-border-hairline)] rounded-lg px-2.5 py-1.5 text-[11px] text-[var(--ui-text-primary)] outline-none focus:border-blue-500'
                  />
                  <div className='flex items-center gap-1.5 justify-end'>
                    <button
                      onClick={() => handleCommit(false)}
                      disabled={committing}
                      className='px-2.5 py-1 rounded-lg bg-[var(--ui-chip-bg)] hover:bg-[var(--ui-chip-hover-bg)] border border-[color:var(--ui-border-hairline)] text-[11px] text-[var(--ui-text-secondary)] disabled:opacity-50 flex items-center gap-1'
                    >
                      {committing && <Loader2 size={11} className='animate-spin' />}
                      提交已暂存
                    </button>
                    <button
                      onClick={() => handleCommit(true)}
                      disabled={committing}
                      className='px-2.5 py-1 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-[11px] font-semibold disabled:opacity-50 flex items-center gap-1'
                    >
                      {committing && <Loader2 size={11} className='animate-spin' />}
                      全部暂存并提交
                    </button>
                  </div>
                </div>
              )}

              {message && (
                <div className='text-[10.5px] text-[var(--ui-text-muted)] px-1'>{message}</div>
              )}

              {/* 变更文件列表 */}
              <div className='flex flex-col gap-1 max-h-[190px] min-h-[60px] overflow-y-auto custom-scrollbar pt-1 pr-1 overscroll-contain select-text'>
                {modifiedFiles.map((file, idx) => {
                  const shortName = file.path.split('/').pop() || file.path;
                  return (
                    <div
                      key={idx}
                      onClick={() => openDiffInWorkbench(file.path)}
                      className='flex items-center justify-between py-1 px-2 rounded-md bg-[var(--ui-block-bg)] hover:bg-[var(--ui-block-hover-bg)] text-xs transition-colors cursor-pointer group'
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
                      <div className='flex items-center gap-1 flex-shrink-0'>
                        <span className='text-[10px] text-[var(--ui-text-faint)] font-mono truncate max-w-[110px] group-hover:hidden'>
                          {file.path}
                        </span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setHunkFile(file.path);
                            setMessage('');
                          }}
                          title='Hunk 级暂存 / 取消暂存'
                          className='hidden group-hover:flex items-center justify-center w-5 h-5 rounded bg-[var(--ui-chip-bg)] hover:bg-[var(--ui-accent-blue-soft)] text-[var(--ui-text-muted)] hover:text-[var(--ui-accent-blue)] border border-[color:var(--ui-border-hairline)]'
                        >
                          <ListChecks size={11} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {hunkFile && workDir && (
        <HunkStagingModal
          workDir={workDir}
          filePath={hunkFile}
          onClose={() => setHunkFile(null)}
          onChanged={() => {
            refreshGitStatus(workDir);
          }}
        />
      )}

      {prOpen && (
        <div
          className='fixed inset-0 z-[300] bg-black/55 backdrop-blur-[2px] flex items-center justify-center p-6'
          onClick={() => setPrOpen(false)}
        >
          <div
            className='w-[620px] max-w-full bg-[var(--ui-popover-bg)] border border-[color:var(--ui-border-subtle)] rounded-2xl shadow-2xl overflow-hidden'
            onClick={(e) => e.stopPropagation()}
          >
            <div className='px-4 py-3 border-b border-[color:var(--ui-divider-hairline)] flex items-center justify-between'>
              <div>
                <h3 className='text-xs font-bold text-[var(--ui-text-primary)] flex items-center gap-1.5'>
                  <GitPullRequest size={13} className='text-[var(--ui-accent-emerald)]' />
                  创建 Pull Request
                </h3>
                <p className='text-[10.5px] text-[var(--ui-text-muted)] mt-0.5'>
                  通过 GitHub CLI (gh) 创建；当前分支必须已推送到远端
                </p>
              </div>
              <button
                onClick={() => setPrOpen(false)}
                className='p-1.5 rounded-lg hover:bg-[var(--ui-block-hover-bg)] text-[var(--ui-text-muted)]'
              >
                <X size={15} />
              </button>
            </div>
            <div className='p-4 space-y-3'>
              <input
                value={prTitle}
                onChange={(e) => setPrTitle(e.target.value)}
                placeholder='PR 标题'
                className='w-full bg-[var(--ui-input-bg)] border border-[color:var(--ui-border-hairline)] rounded-lg px-3 py-2 text-xs text-[var(--ui-text-primary)] outline-none focus:border-emerald-500'
              />
              <textarea
                value={prBody}
                onChange={(e) => setPrBody(e.target.value)}
                placeholder='PR 描述（背景、改动点、验证方式、风险）'
                rows={7}
                className='w-full resize-none bg-[var(--ui-input-bg)] border border-[color:var(--ui-border-hairline)] rounded-lg px-3 py-2 text-xs text-[var(--ui-text-primary)] outline-none focus:border-emerald-500'
              />
              <label className='flex items-center gap-2 text-[11px] text-[var(--ui-text-secondary)] cursor-pointer select-none'>
                <input
                  type='checkbox'
                  checked={prDraft}
                  onChange={(e) => setPrDraft(e.target.checked)}
                  className='accent-emerald-500'
                />
                创建为草稿 PR
              </label>
              {prResult && (
                <div
                  className={`text-[11px] rounded-lg px-2.5 py-2 border ${
                    prResult.success
                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                      : 'bg-rose-500/10 border-rose-500/30 text-rose-400'
                  }`}
                >
                  {prResult.text}
                </div>
              )}
              <div className='flex justify-end gap-2'>
                <button
                  onClick={() => setPrOpen(false)}
                  className='px-3 py-1.5 rounded-lg bg-[var(--ui-chip-bg)] hover:bg-[var(--ui-chip-hover-bg)] border border-[color:var(--ui-border-hairline)] text-[11px] text-[var(--ui-text-secondary)]'
                >
                  取消
                </button>
                <button
                  onClick={handleCreatePr}
                  disabled={prBusy}
                  className='px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-semibold disabled:opacity-50 flex items-center gap-1.5'
                >
                  {prBusy && <Loader2 size={12} className='animate-spin' />}
                  创建 PR
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ChangesCard;
