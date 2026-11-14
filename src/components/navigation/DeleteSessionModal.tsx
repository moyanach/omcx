import { useCallback, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { FolderGit2, Loader2, Trash2, X } from 'lucide-react';
import { useChatStore } from '@/stores/chatStore';

interface WorktreeDeleteItem {
  name?: string;
  path: string;
  branch: string;
  repoRoot: string;
}

interface PendingDeleteState {
  sessionId: string;
  sessionTitle: string;
  worktrees: WorktreeDeleteItem[];
}

export function useDeleteSessionWithWorktree() {
  const { sessions, deleteSession } = useChatStore(
    useShallow((s) => ({ sessions: s.sessions, deleteSession: s.deleteSession }))
  );
  const [pending, setPending] = useState<PendingDeleteState | null>(null);
  const [alsoRemoveWorktree, setAlsoRemoveWorktree] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const requestDeleteSession = useCallback(
    async (session: { id: string; title?: string; workDir?: string }) => {
      if (!session?.id) return;
      const workDir = session.workDir || '';

      if (window.electronAPI?.inspectManagedWorktree) {
        try {
          const res = await window.electronAPI.inspectManagedWorktree(workDir, session.id);
          const groupEntries = Array.isArray(res?.groupEntries) ? res.groupEntries : [];
          let candidates: WorktreeDeleteItem[] = [];
          if (groupEntries.length > 0) {
            candidates = groupEntries.map((item: any) => ({
              name: item.name,
              path: item.worktreePath,
              branch: item.branch || '',
              repoRoot: item.repoRoot || item.worktreePath,
            }));
          } else if (res?.success && res.isManagedWorktree && res.path) {
            candidates = [
              {
                path: res.path,
                branch: res.branch || '',
                repoRoot: res.repoRoot || res.path,
              },
            ];
          }

          // 过滤掉仍被其他存活会话主目录占用的 Worktree
          const removable = candidates.filter(
            (wt) => !sessions.some((s) => s.id !== session.id && s.workDir === wt.path)
          );

          if (removable.length > 0) {
            setAlsoRemoveWorktree(true);
            setErrorMsg('');
            setPending({
              sessionId: session.id,
              sessionTitle: session.title || '未命名会话',
              worktrees: removable,
            });
            return;
          }
        } catch {
          // 探测失败则降级为直接删除会话
        }
      }

      await deleteSession(session.id);
    },
    [deleteSession, sessions]
  );

  const cancelDelete = useCallback(() => {
    if (submitting) return;
    setPending(null);
    setErrorMsg('');
  }, [submitting]);

  const confirmDelete = useCallback(async () => {
    if (!pending || submitting) return;
    setSubmitting(true);
    setErrorMsg('');
    try {
      await deleteSession(pending.sessionId);
      if (alsoRemoveWorktree && window.electronAPI?.removeGitWorktree) {
        const errors: string[] = [];
        for (const wt of pending.worktrees) {
          const rmRes = await window.electronAPI.removeGitWorktree(wt.repoRoot, wt.path, true);
          if (!rmRes?.success) {
            errors.push(`${wt.name || wt.path}: ${rmRes?.error || '删除失败'}`);
          }
        }
        if (errors.length > 0) {
          setErrorMsg(`会话已删除，但部分工作树清理失败：${errors.join('；')}`);
          setSubmitting(false);
          return;
        }
      }
      setPending(null);
    } catch (err: any) {
      setErrorMsg(err?.message || String(err));
    } finally {
      setSubmitting(false);
    }
  }, [alsoRemoveWorktree, deleteSession, pending, submitting]);

  const modal = pending ? (
    <div
      className='fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-sm p-4'
      onClick={cancelDelete}
    >
      <div
        className='w-full max-w-md rounded-xl border border-[color:var(--ui-border-hairline)] bg-[var(--ui-panel-bg)] shadow-2xl p-4 space-y-3'
        onClick={(e) => e.stopPropagation()}
      >
        <div className='flex items-center justify-between gap-2'>
          <div className='flex items-center gap-2 text-[var(--ui-text-primary)]'>
            <Trash2 size={15} className='text-rose-400' />
            <h3 className='text-[13px] font-semibold'>删除会话</h3>
          </div>
          <button
            onClick={cancelDelete}
            disabled={submitting}
            className='p-1 rounded-md text-[var(--ui-text-faint)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-block-hover-bg)]'
          >
            <X size={14} />
          </button>
        </div>

        <p className='text-[12px] text-[var(--ui-text-secondary)] leading-relaxed'>
          确认删除会话「<span className='font-medium'>{pending.sessionTitle}</span>」？
        </p>

        <div className='rounded-lg border border-[color:var(--ui-border-hairline)] bg-[var(--ui-block-bg)] p-2.5 space-y-2'>
          <label className='flex items-start gap-2 cursor-pointer select-none'>
            <input
              type='checkbox'
              checked={alsoRemoveWorktree}
              onChange={(e) => setAlsoRemoveWorktree(e.target.checked)}
              disabled={submitting}
              className='mt-0.5 rounded border-[color:var(--ui-border-hairline)]'
            />
            <span className='text-[11.5px] text-[var(--ui-text-primary)] leading-snug'>
              同时删除关联的 {pending.worktrees.length > 1 ? `${pending.worktrees.length} 个` : ''}隔离工作树目录（释放磁盘空间）
            </span>
          </label>
          <div className='pl-5 max-h-[130px] overflow-y-auto custom-scrollbar space-y-1.5 text-[10.5px] font-mono text-[var(--ui-text-faint)]'>
            {pending.worktrees.map((wt) => (
              <div key={wt.path} className='space-y-0.5'>
                <div className='flex items-center gap-1 truncate'>
                  <FolderGit2 size={11} className='flex-shrink-0 text-[var(--ui-accent-blue)]' />
                  <span className='truncate'>
                    {wt.name ? `${wt.name} · ` : ''}
                    {wt.branch ? `分支：${wt.branch}` : '工作树'}
                  </span>
                </div>
                <p className='truncate' title={wt.path}>
                  路径：{wt.path}
                </p>
              </div>
            ))}
          </div>
        </div>

        {errorMsg && (
          <p className='text-[11px] text-rose-400 leading-relaxed break-words'>{errorMsg}</p>
        )}

        <div className='flex items-center justify-end gap-2 pt-1'>
          <button
            onClick={cancelDelete}
            disabled={submitting}
            className='h-8 px-3 rounded-lg border border-[color:var(--ui-border-hairline)] bg-[var(--ui-chip-bg)] text-[11.5px] text-[var(--ui-text-secondary)] hover:bg-[var(--ui-block-hover-bg)] disabled:opacity-50'
          >
            取消
          </button>
          <button
            onClick={confirmDelete}
            disabled={submitting}
            className='h-8 px-3 rounded-lg bg-rose-500/20 border border-rose-500/40 text-[11.5px] font-medium text-rose-300 hover:bg-rose-500/30 disabled:opacity-50 flex items-center gap-1.5'
          >
            {submitting && <Loader2 size={12} className='animate-spin' />}
            确认删除
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return { requestDeleteSession, deleteSessionModal: modal };
}
