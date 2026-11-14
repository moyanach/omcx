import React, { useCallback, useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  Loader2,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { useChatStore } from '@/stores/chatStore';

interface SpecItem {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  size: number;
  path: string;
}

const STATUS_STYLE: Record<string, { label: string; className: string }> = {
  draft: {
    label: '待确认',
    className: 'bg-[var(--ui-accent-amber-soft)] text-[var(--ui-accent-amber)]',
  },
  confirmed: {
    label: '已确认',
    className: 'bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)]',
  },
  'in-progress': {
    label: '执行中',
    className: 'bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)]',
  },
  done: {
    label: '已完成',
    className: 'bg-[var(--ui-accent-emerald-soft)] text-[var(--ui-accent-emerald)]',
  },
  archived: {
    label: '已归档',
    className: 'bg-[var(--ui-chip-bg)] text-[var(--ui-text-faint)]',
  },
};

export const SpecCard: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<SpecItem[]>([]);
  const [message, setMessage] = useState('');

  const { sessions, activeSessionId, openFileInWorkbench } = useChatStore(
    useShallow((s) => ({
      sessions: s.sessions,
      activeSessionId: s.activeSessionId,
      openFileInWorkbench: s.openFileInWorkbench,
    }))
  );
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const workDir = activeSession?.workDir || '';

  const load = useCallback(async () => {
    if (!workDir || !window.electronAPI?.listSpecs) {
      setItems([]);
      return;
    }
    setLoading(true);
    try {
      const list = await window.electronAPI.listSpecs(workDir);
      setItems(Array.isArray(list) ? list : []);
    } catch (err: any) {
      setMessage(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [workDir]);

  useEffect(() => {
    if (isOpen) load();
  }, [isOpen, load]);

  const copyExecute = async (item: SpecItem) => {
    const command = `/execute-spec ${item.id}`;
    try {
      await navigator.clipboard.writeText(command);
      setMessage(`已复制执行指令：${command}`);
    } catch {
      setMessage(`请手动输入：${command}`);
    }
  };

  const handleDelete = async (item: SpecItem) => {
    if (!window.electronAPI?.deleteSpec || !workDir) return;
    const confirmed = window.confirm(`确认删除规格文档「${item.title}」？`);
    if (!confirmed) return;
    const res = await window.electronAPI.deleteSpec(workDir, item.id);
    if (!res?.success) {
      setMessage(res?.error || '删除失败');
      return;
    }
    setMessage('已删除规格文档');
    await load();
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
        <FileText size={13} className='text-[var(--ui-accent-amber)]' />
        <span className='text-[11px] font-semibold text-[var(--ui-text-secondary)]'>
          规格文档
        </span>
        <span className='ml-auto text-[10px] font-mono text-[var(--ui-text-faint)]'>
          {items.length > 0 ? `${items.length} 份` : 'Quest'}
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
              <div className='flex items-center justify-between'>
                <p className='text-[10px] text-[var(--ui-text-faint)]'>
                  用 <span className='font-mono text-[var(--ui-text-muted)]'>/spec &lt;需求&gt;</span>{' '}
                  生成规格，确认后执行
                </p>
                <button
                  onClick={load}
                  disabled={loading}
                  className='p-1 rounded bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)] text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] disabled:opacity-50'
                  title='刷新规格列表'
                >
                  <RefreshCw size={10} className={loading ? 'animate-spin' : ''} />
                </button>
              </div>

              {items.length === 0 && !loading ? (
                <p className='text-[10.5px] text-[var(--ui-text-faint)] py-2'>
                  暂无规格文档。在输入框发送 <span className='font-mono'>/spec 需求描述</span>{' '}
                  即可生成。
                </p>
              ) : (
                <div className='max-h-[200px] overflow-y-auto custom-scrollbar space-y-1 pr-0.5'>
                  {items.map((item) => {
                    const status = STATUS_STYLE[item.status] || STATUS_STYLE.draft;
                    return (
                      <div
                        key={item.id}
                        className='rounded-md bg-[var(--ui-block-bg)] px-2 py-1.5'
                      >
                        <div className='flex items-center gap-1.5 min-w-0'>
                          <button
                            onClick={() => openFileInWorkbench(item.path)}
                            className='text-[10.5px] text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)] truncate text-left min-w-0'
                            title={item.title}
                          >
                            {item.title}
                          </button>
                          <span
                            className={`text-[9px] px-1 rounded flex-shrink-0 ${status.className}`}
                          >
                            {status.label}
                          </span>
                          <div className='ml-auto flex items-center gap-0.5 flex-shrink-0'>
                            <button
                              onClick={() => copyExecute(item)}
                              className='p-1 rounded hover:bg-[var(--ui-block-hover-bg)] text-[var(--ui-text-faint)] hover:text-[var(--ui-accent-blue)]'
                              title='复制执行指令 /execute-spec'
                            >
                              <Copy size={10} />
                            </button>
                            <button
                              onClick={() => handleDelete(item)}
                              className='p-1 rounded hover:bg-rose-500/10 text-[var(--ui-text-faint)] hover:text-rose-400'
                              title='删除规格文档'
                            >
                              <Trash2 size={10} />
                            </button>
                          </div>
                        </div>
                        <p
                          className='text-[9px] font-mono text-[var(--ui-text-faint)] truncate mt-0.5'
                          title={item.id}
                        >
                          {item.id}
                        </p>
                      </div>
                    );
                  })}
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

export default SpecCard;
