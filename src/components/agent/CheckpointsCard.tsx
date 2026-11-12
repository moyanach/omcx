import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  History,
  Loader2,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { useChatStore } from '@/stores/chatStore';

interface CheckpointFile {
  path: string;
  existed: boolean;
  skipped?: boolean;
  tool?: string;
}

interface CheckpointItem {
  id: string;
  createdAt: number;
  updatedAt?: number;
  fileCount: number;
  files: CheckpointFile[];
  truncatedFiles?: number;
}

function formatTime(ts: number) {
  if (!ts) return '-';
  const date = new Date(ts);
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export const CheckpointsCard: React.FC = () => {
  const [isOpen, setIsOpen] = useState(true);
  const [items, setItems] = useState<CheckpointItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');

  const { activeSessionId, sessions, messages, refreshGitStatus, refreshOutputs } =
    useChatStore();
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const workDir = activeSession?.workDir;

  const load = useCallback(async () => {
    if (!activeSessionId || !window.electronAPI?.getSessionCheckpoints) {
      setItems([]);
      return;
    }
    setLoading(true);
    try {
      const list = await window.electronAPI.getSessionCheckpoints(activeSessionId);
      setItems(Array.isArray(list) ? list : []);
    } catch (err) {
      console.error('读取检查点失败:', err);
    } finally {
      setLoading(false);
    }
  }, [activeSessionId]);

  useEffect(() => {
    load();
  }, [load]);

  // 会话消息变化（尤其是新增工具执行）后，延迟刷新一次检查点列表
  const lastMessage = activeSessionId
    ? (messages[activeSessionId] || []).slice(-1)[0]
    : null;
  useEffect(() => {
    if (!activeSessionId) return;
    const timer = window.setTimeout(load, 600);
    return () => window.clearTimeout(timer);
  }, [activeSessionId, lastMessage?.id, lastMessage?.content, load]);

  const handleRestore = async (item: CheckpointItem) => {
    if (!activeSessionId || busyId) return;
    const confirmed = window.confirm(
      `确认回滚到 ${formatTime(item.createdAt)} 的检查点？\n\n` +
        `将恢复 ${item.fileCount} 个文件的原始内容，Agent 在该回合新建的文件会被删除。\n` +
        `该操作会覆盖当前工作区中的同名文件，建议先确认没有未保存的手工修改。`
    );
    if (!confirmed) return;

    setBusyId(item.id);
    setNotice('');
    try {
      const result = await window.electronAPI.restoreCheckpoint(activeSessionId, item.id);
      if (result?.success) {
        setNotice(`已回滚 ${result.restored || 0} 个文件，删除 ${result.removed || 0} 个新建文件`);
      } else {
        const failed = Array.isArray(result?.failed) ? result.failed : [];
        setNotice(
          `部分回滚失败 (${failed.length} 个文件)：${
            failed[0]?.error || result?.error || '未知错误'
          }`
        );
      }
      if (workDir) {
        refreshGitStatus(workDir);
      }
      refreshOutputs(activeSessionId);
      await load();
    } catch (err: any) {
      setNotice(`回滚失败：${err?.message || err}`);
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (item: CheckpointItem) => {
    if (!activeSessionId || busyId) return;
    if (!window.confirm('确认删除该检查点？删除后无法再回滚到该回合。')) return;
    setBusyId(item.id);
    try {
      await window.electronAPI.deleteCheckpoint(activeSessionId, item.id);
      await load();
    } catch (err: any) {
      setNotice(`删除失败：${err?.message || err}`);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="border-b border-[color:var(--ui-divider-hairline)] transition-colors select-none titlebar-no-drag last:border-b-0">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-[var(--ui-block-hover-bg)] transition-colors"
      >
        <span className="flex items-center gap-2 min-w-0">
          <History size={14} className="text-[var(--ui-accent-blue)]" />
          <span className="font-semibold text-sm text-[var(--ui-text-primary)] tracking-wide">
            检查点 (Checkpoints)
          </span>
          {items.length > 0 && (
            <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)] border border-[color:var(--ui-border-hairline)] font-mono">
              {items.length}
            </span>
          )}
        </span>
        <div className="text-[var(--ui-text-faint)]">
          {isOpen ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
        </div>
      </button>

      {isOpen && (
        <div className="px-4 pb-3.5 pt-0.5 flex flex-col gap-2">
          {loading && items.length === 0 ? (
            <div className="py-3 flex items-center justify-center gap-1.5 text-xs text-[var(--ui-text-muted)]">
              <Loader2 size={13} className="animate-spin" />
              <span>正在读取检查点…</span>
            </div>
          ) : items.length === 0 ? (
            <div className="py-3 text-center text-xs text-[var(--ui-text-faint)] leading-relaxed">
              Agent 修改文件时会自动创建检查点
              <br />
              回滚可恢复到该回合开始前的文件状态
            </div>
          ) : (
            <div className="flex flex-col gap-1.5 max-h-[260px] overflow-y-auto custom-scrollbar pr-1">
              {items.map((item) => {
                const expanded = expandedId === item.id;
                const busy = busyId === item.id;
                return (
                  <div
                    key={item.id}
                    className="rounded-lg bg-[var(--ui-block-bg)] overflow-hidden"
                  >
                    <div className="px-2.5 py-2 flex items-center justify-between gap-2">
                      <button
                        onClick={() => setExpandedId(expanded ? null : item.id)}
                        className="flex items-center gap-1.5 min-w-0 flex-1 text-left"
                        title="查看该检查点包含的文件"
                      >
                        {expanded ? (
                          <ChevronDown size={12} className="text-[var(--ui-text-faint)]" />
                        ) : (
                          <ChevronRight size={12} className="text-[var(--ui-text-faint)]" />
                        )}
                        <div className="min-w-0">
                          <div className="text-[11px] font-mono text-[var(--ui-text-primary)]">
                            {formatTime(item.createdAt)}
                          </div>
                          <div className="text-[10px] text-[var(--ui-text-faint)]">
                            {item.fileCount} 个文件
                          </div>
                        </div>
                      </button>

                      <div className="flex items-center gap-1 flex-shrink-0">
                        <button
                          onClick={() => handleRestore(item)}
                          disabled={busy}
                          className="px-1.5 py-1 rounded-md bg-[var(--ui-accent-amber-soft)] hover:opacity-90 border border-[color:var(--ui-border-hairline)] text-[var(--ui-accent-amber)] transition-colors disabled:opacity-40"
                          title="回滚到该检查点"
                        >
                          {busy ? (
                            <Loader2 size={11} className="animate-spin" />
                          ) : (
                            <RotateCcw size={11} />
                          )}
                        </button>
                        <button
                          onClick={() => handleDelete(item)}
                          disabled={busy}
                          className="p-1 rounded-md hover:bg-[var(--ui-block-hover-bg)] text-[var(--ui-text-faint)] hover:text-[var(--ui-accent-rose)] transition-colors disabled:opacity-40"
                          title="删除检查点"
                        >
                          <Trash2 size={11} />
                        </button>
                      </div>
                    </div>

                    {expanded && (
                      <div className="px-2.5 pb-2 flex flex-col gap-1 border-t border-[color:var(--ui-divider-hairline)] pt-1.5">
                        {item.files.map((file, idx) => (
                          <div
                            key={`${file.path}_${idx}`}
                            className="flex items-center justify-between gap-2 text-[10px] font-mono"
                            title={file.path}
                          >
                            <span className="truncate text-[var(--ui-text-secondary)]">
                              {file.path}
                            </span>
                            <span className="flex items-center gap-1 flex-shrink-0">
                              {file.skipped && (
                                <AlertTriangle size={9} className="text-[var(--ui-accent-amber)]" />
                              )}
                              <span
                                className={
                                  file.existed
                                    ? 'text-[var(--ui-text-faint)]'
                                    : 'text-[var(--ui-accent-emerald)]'
                                }
                              >
                                {file.existed ? '修改' : '新建'}
                              </span>
                            </span>
                          </div>
                        ))}
                        {item.truncatedFiles ? (
                          <div className="text-[10px] text-[var(--ui-text-faint)]">
                            …另有 {item.truncatedFiles} 个文件
                          </div>
                        ) : null}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {notice && (
            <div className="text-[10.5px] text-[var(--ui-text-secondary)] bg-[var(--ui-block-bg)] rounded-md px-2 py-1.5 select-text">
              {notice}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default CheckpointsCard;
