import React, { useCallback, useEffect, useState } from 'react';
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
  Sparkles,
  X,
} from 'lucide-react';
import { useChatStore } from '@/stores/chatStore';
import MarkdownContent from '@/components/common/MarkdownContent';

interface WikiMeta {
  generatedAt?: number;
  model?: string;
  fileCount?: number;
  symbolCount?: number;
}

export const RepoWikiCard: React.FC = () => {
  const [isOpen, setIsOpen] = useState(true);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [content, setContent] = useState('');
  const [meta, setMeta] = useState<WikiMeta | null>(null);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);

  const { sessions, activeSessionId } = useChatStore();
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const workDir = activeSession?.workDir;

  const loadWiki = useCallback(async () => {
    if (!workDir || !window.electronAPI?.getRepoWiki) {
      setContent('');
      setMeta(null);
      return;
    }
    setLoading(true);
    try {
      const result = await window.electronAPI.getRepoWiki(workDir);
      if (result?.exists) {
        setContent(result.content || '');
        setMeta(result.meta || null);
      } else {
        setContent('');
        setMeta(null);
      }
    } catch (err) {
      console.error('读取 Repo Wiki 失败:', err);
    } finally {
      setLoading(false);
    }
  }, [workDir]);

  useEffect(() => {
    loadWiki();
  }, [loadWiki]);

  const handleGenerate = async () => {
    if (!workDir || generating) return;
    setGenerating(true);
    setError('');
    try {
      const result = await window.electronAPI.generateRepoWiki(
        workDir,
        activeSession?.model
      );
      if (!result?.success) {
        setError(result?.error || '生成失败');
        return;
      }
      setContent(result.content || '');
      setMeta(result.meta || null);
      setShowModal(true);
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setGenerating(false);
    }
  };

  const generatedLabel = meta?.generatedAt
    ? new Date(meta.generatedAt).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';

  return (
    <>
      <div className="bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-hairline)] rounded-2xl overflow-hidden transition-all duration-200 select-none titlebar-no-drag">
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-[var(--ui-block-hover-bg)] transition-colors"
        >
          <span className="flex items-center gap-2 min-w-0">
            <BookOpen size={14} className="text-[var(--ui-accent-emerald)]" />
            <span className="font-semibold text-sm text-[var(--ui-text-primary)] tracking-wide">
              Repo Wiki
            </span>
            {content && (
              <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-[var(--ui-accent-emerald-soft)] text-[var(--ui-accent-emerald)] border border-[color:var(--ui-accent-emerald-border)] font-mono">
                已生成
              </span>
            )}
          </span>
          <div className="text-[var(--ui-text-faint)]">
            {isOpen ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
          </div>
        </button>

        {isOpen && (
          <div className="px-4 pb-3.5 pt-0.5 flex flex-col gap-2">
            {!workDir ? (
              <div className="py-3 text-center text-xs text-[var(--ui-text-faint)]">
                请先绑定工作空间目录
              </div>
            ) : loading ? (
              <div className="py-3 flex items-center justify-center gap-1.5 text-xs text-[var(--ui-text-muted)]">
                <Loader2 size={13} className="animate-spin" />
                <span>正在读取仓库 Wiki…</span>
              </div>
            ) : content ? (
              <>
                <div className="text-[10.5px] text-[var(--ui-text-faint)] leading-relaxed">
                  {generatedLabel && <span>{generatedLabel} · </span>}
                  {meta?.fileCount ? `${meta.fileCount} 个符号文件 · ` : ''}
                  {meta?.symbolCount ? `${meta.symbolCount} 个符号` : ''}
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => setShowModal(true)}
                    className="flex-1 px-2.5 py-1.5 rounded-lg bg-[var(--ui-accent-emerald-soft)] border border-[color:var(--ui-accent-emerald-border)] text-[11px] text-[var(--ui-accent-emerald)] font-medium hover:opacity-90 transition-opacity"
                  >
                    查看仓库 Wiki
                  </button>
                  <button
                    onClick={handleGenerate}
                    disabled={generating}
                    className="p-1.5 rounded-lg bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)] text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] transition-colors disabled:opacity-40"
                    title="重新生成"
                  >
                    {generating ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <RefreshCw size={12} />
                    )}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="py-2 text-center text-[11px] text-[var(--ui-text-faint)] leading-relaxed">
                  基于 Repo Map、README 与构建清单生成仓库级说明
                </div>
                <button
                  onClick={handleGenerate}
                  disabled={generating}
                  className="w-full px-2.5 py-1.5 rounded-lg bg-[var(--ui-accent-emerald-soft)] border border-[color:var(--ui-accent-emerald-border)] text-[11px] text-[var(--ui-accent-emerald)] font-medium hover:opacity-90 transition-opacity flex items-center justify-center gap-1.5 disabled:opacity-50"
                >
                  {generating ? (
                    <>
                      <Loader2 size={12} className="animate-spin" />
                      <span>正在扫描仓库并生成…</span>
                    </>
                  ) : (
                    <>
                      <Sparkles size={12} />
                      <span>生成 Repo Wiki</span>
                    </>
                  )}
                </button>
              </>
            )}

            {error && (
              <div className="text-[10.5px] text-[var(--ui-accent-rose)] bg-[var(--ui-accent-rose-soft)] border border-[color:var(--ui-accent-rose-border)] rounded-lg px-2 py-1.5 select-text">
                {error}
              </div>
            )}
          </div>
        )}
      </div>

      {showModal && (
        <div
          className="fixed inset-0 z-[9999] bg-black/70 backdrop-blur-sm flex items-center justify-center p-6 animate-in fade-in duration-150"
          onClick={() => setShowModal(false)}
        >
          <div
            className="w-full max-w-4xl max-h-[85vh] bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-subtle)] rounded-2xl shadow-2xl overflow-hidden flex flex-col"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="px-5 py-3.5 border-b border-[color:var(--ui-divider-hairline)] bg-[var(--ui-card-header-bg)] flex items-center justify-between flex-shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <BookOpen size={16} className="text-[var(--ui-accent-emerald)]" />
                <h3 className="font-bold text-sm text-[var(--ui-text-primary)] truncate">
                  Repo Wiki · {workDir?.split('/').pop() || '工作区'}
                </h3>
                {meta?.generatedAt && (
                  <span className="text-[10px] text-[var(--ui-text-faint)] font-mono">
                    {new Date(meta.generatedAt).toLocaleString('zh-CN')}
                  </span>
                )}
              </div>
              <button
                onClick={() => setShowModal(false)}
                className="p-1.5 rounded-lg hover:bg-[var(--ui-block-hover-bg)] text-[var(--ui-text-faint)] hover:text-[var(--ui-text-primary)]"
              >
                <X size={15} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-5 custom-scrollbar select-text">
              <MarkdownContent content={content} />
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default RepoWikiCard;
