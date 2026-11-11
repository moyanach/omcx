import React, { useCallback, useEffect, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FolderGit2,
  FolderOpen,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { useChatStore } from '@/stores/chatStore';

interface WorktreeEntry {
  path: string;
  head?: string;
  branch?: string;
  detached?: boolean;
  locked?: boolean;
  isMain?: boolean;
}

export const WorktreeCard: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [items, setItems] = useState<WorktreeEntry[]>([]);
  const [branch, setBranch] = useState('');
  const [base, setBase] = useState('');
  const [message, setMessage] = useState('');

  const { sessions, activeSessionId, addSession } = useChatStore();
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const workDir = activeSession?.workDir || '';

  const load = useCallback(async () => {
    if (!workDir || !window.electronAPI?.listGitWorktrees) {
      setItems([]);
      return;
    }
    setLoading(true);
    try {
      const res = await window.electronAPI.listGitWorktrees(workDir);
      if (res?.success) {
        setItems(Array.isArray(res.worktrees) ? res.worktrees : []);
      } else {
        setItems([]);
        setMessage(res?.error || '读取工作树失败');
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
        const retry = window.confirm(
          `删除失败：${res?.error || '工作树包含未提交改动'}\n\n是否强制删除并丢弃其中的未提交改动？`
        );
        if (!retry) {
          setMessage(res?.error || '删除失败');
          return;
        }
        res = await window.electronAPI.removeGitWorktree(workDir, entry.path, true);
      }
      if (!res?.success) {
        setMessage(res?.error || '删除工作树失败');
        return;
      }
      setMessage('已删除工作树');
      await load();
    } catch (err: any) {
      setMessage(err?.message || String(err));
    } finally {
      setBusy('');
    }
  };

  return (
    <div className='rounded-xl bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-hairline)] overflow-hidden'>
      <button
        onClick={() => setIsOpen((v) => !v)}
        className='w-full px-3 py-2 flex items-center gap-2 hover:bg-[var(--ui-block-hover-bg)] transition-colors'
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
                      className='rounded-lg bg-[var(--ui-card-inner-bg)] border border-[color:var(--ui-border-hairline)] px-2 py-1.5'
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
            </>
          )}

          {message && (
            <p className='text-[10px] text-[var(--ui-text-muted)] leading-relaxed break-words'>
              {message}
            </p>
          )}
        </div>
      )}
    </div>
  );
};

export default WorktreeCard;
