import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useShallow } from 'zustand/react/shallow';
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  FolderGit2,
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

interface WorkspaceWikiItem {
  workDir: string;
  name: string;
  isPrimary: boolean;
  exists: boolean;
  content: string;
  meta: WikiMeta | null;
  path?: string;
  error?: string;
}

const formatGeneratedTime = (ts?: number) =>
  ts
    ? new Date(ts).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';

export const RepoWikiCard: React.FC = () => {
  const [isOpen, setIsOpen] = useState(true);
  const [loading, setLoading] = useState(false);
  const [generatingDirs, setGeneratingDirs] = useState<Record<string, boolean>>({});
  const [batchGenerating, setBatchGenerating] = useState(false);
  const [items, setItems] = useState<WorkspaceWikiItem[]>([]);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [selectedModalDir, setSelectedModalDir] = useState<string>('');

  const { sessions, activeSessionId, activeWorkspaceId, workspaces, wikiRevision } = useChatStore(
    useShallow((s) => ({
      sessions: s.sessions,
      activeSessionId: s.activeSessionId,
      activeWorkspaceId: s.activeWorkspaceId,
      workspaces: s.workspaces,
      wikiRevision: s.wikiRevision,
    }))
  );

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const workDir = activeSession?.workDir || '';

  const currentWorkspace = useMemo(
    () =>
      workspaces.find(
        (ws) =>
          ws.id === activeSession?.workspaceId ||
          ws.id === activeWorkspaceId ||
          (workDir && ws.folders.some((f) => f.path === workDir))
      ) || null,
    [workspaces, activeSession?.workspaceId, activeWorkspaceId, workDir]
  );

  const targetFolders = useMemo(() => {
    if (currentWorkspace?.folders && currentWorkspace.folders.length > 0) {
      const primary =
        currentWorkspace.folders.find((f) => f.path === workDir) ||
        currentWorkspace.folders.find((f) => f.isPrimary) ||
        currentWorkspace.folders[0];
      const seen = new Set<string>();
      const ordered: Array<{ workDir: string; name: string; isPrimary: boolean }> = [];
      const pushFolder = (f: { path: string; name?: string; isPrimary?: boolean }) => {
        if (!f?.path || seen.has(f.path)) return;
        seen.add(f.path);
        ordered.push({
          workDir: f.path,
          name: f.name || f.path.split(/[\\/]/).filter(Boolean).pop() || f.path,
          isPrimary: f.path === primary?.path || Boolean(f.isPrimary),
        });
      };
      if (primary) pushFolder(primary);
      for (const f of currentWorkspace.folders) pushFolder(f);
      return ordered;
    }
    if (workDir) {
      return [
        {
          workDir,
          name: workDir.split(/[\\/]/).filter(Boolean).pop() || workDir,
          isPrimary: true,
        },
      ];
    }
    return [];
  }, [currentWorkspace, workDir]);

  const targetDirsKey = targetFolders.map((f) => f.workDir).join('|');

  const loadWikis = useCallback(async () => {
    if (targetFolders.length === 0) {
      setItems([]);
      return;
    }
    setLoading(true);
    try {
      if (window.electronAPI?.getWorkspaceRepoWikis) {
        const res = await window.electronAPI.getWorkspaceRepoWikis(
          targetFolders.map((f) => f.workDir),
          workDir || targetFolders[0]?.workDir || null
        );
        if (res?.success && Array.isArray(res.items)) {
          const folderNameMap = new Map(targetFolders.map((f) => [f.workDir, f]));
          setItems(
            res.items.map((item: any) => {
              const info = folderNameMap.get(item.workDir);
              return {
                workDir: item.workDir,
                name: info?.name || item.name || item.workDir,
                isPrimary: info ? info.isPrimary : Boolean(item.isPrimary),
                exists: Boolean(item.exists),
                content: item.content || '',
                meta: item.meta || null,
                path: item.path || '',
                error: item.error,
              };
            })
          );
          return;
        }
      }

      if (window.electronAPI?.getRepoWiki) {
        const single = await window.electronAPI.getRepoWiki(targetFolders[0].workDir);
        setItems([
          {
            workDir: targetFolders[0].workDir,
            name: targetFolders[0].name,
            isPrimary: true,
            exists: Boolean(single?.exists),
            content: single?.content || '',
            meta: single?.meta || null,
            path: single?.path || '',
          },
        ]);
      }
    } catch (err) {
      console.error('读取 Repo Wiki 失败:', err);
    } finally {
      setLoading(false);
    }
  }, [targetDirsKey, workDir]);

  useEffect(() => {
    void loadWikis();
  }, [loadWikis, wikiRevision]);

  const generateSingleWiki = useCallback(
    async (targetDir: string, openModalOnSuccess = false) => {
      if (!targetDir || !window.electronAPI?.generateRepoWiki) return false;
      setGeneratingDirs((prev) => ({ ...prev, [targetDir]: true }));
      setError('');
      try {
        const result = await window.electronAPI.generateRepoWiki(
          targetDir,
          activeSession?.model
        );
        if (!result?.success) {
          setError(`${targetDir.split(/[\\/]/).pop() || targetDir}: ${result?.error || '生成失败'}`);
          return false;
        }
        setItems((prev) =>
          prev.map((item) =>
            item.workDir === targetDir
              ? {
                  ...item,
                  exists: true,
                  content: result.content || '',
                  meta: result.meta || null,
                  path: result.path || item.path,
                }
              : item
          )
        );
        if (openModalOnSuccess) {
          setSelectedModalDir(targetDir);
          setShowModal(true);
        }
        return true;
      } catch (err: any) {
        setError(err?.message || String(err));
        return false;
      } finally {
        setGeneratingDirs((prev) => ({ ...prev, [targetDir]: false }));
      }
    },
    [activeSession?.model]
  );

  const handleGenerateBatch = async (onlyMissing: boolean) => {
    if (batchGenerating) return;
    const targets = items.filter((item) => (onlyMissing ? !item.exists : true));
    if (targets.length === 0) return;
    setBatchGenerating(true);
    setError('');
    try {
      let cursor = 0;
      const concurrency = Math.min(2, targets.length);
      const workers = Array.from({ length: concurrency }, async () => {
        while (cursor < targets.length) {
          const current = targets[cursor++];
          await generateSingleWiki(current.workDir, false);
        }
      });
      await Promise.all(workers);
    } finally {
      setBatchGenerating(false);
    }
  };

  const openWikiModal = (targetDir?: string) => {
    const preferred =
      targetDir ||
      items.find((i) => i.exists && i.isPrimary)?.workDir ||
      items.find((i) => i.exists)?.workDir ||
      items[0]?.workDir ||
      '';
    setSelectedModalDir(preferred);
    setShowModal(true);
  };

  const isMulti = items.length > 1;
  const generatedCount = items.filter((i) => i.exists && i.content).length;
  const missingCount = items.length - generatedCount;
  const singleItem = items[0] || null;
  const isAnyGenerating = batchGenerating || Object.values(generatingDirs).some(Boolean);
  const activeModalItem =
    items.find((i) => i.workDir === selectedModalDir) ||
    items.find((i) => i.exists) ||
    items[0] ||
    null;

  return (
    <>
      <div className="border-b border-[color:var(--ui-divider-hairline)] transition-colors select-none titlebar-no-drag last:border-b-0">
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-[var(--ui-block-hover-bg)] transition-colors"
        >
          <span className="flex items-center gap-2 min-w-0">
            <BookOpen size={14} className="text-[var(--ui-accent-emerald)]" />
            <span className="font-semibold text-sm text-[var(--ui-text-primary)] tracking-wide">
              Repo Wiki
            </span>
            {items.length > 0 && generatedCount > 0 && (
              <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-[var(--ui-accent-emerald-soft)] text-[var(--ui-accent-emerald)] border border-[color:var(--ui-accent-emerald-border)] font-mono">
                {isMulti ? `${generatedCount}/${items.length} 已生成` : '已生成'}
              </span>
            )}
          </span>
          <div className="text-[var(--ui-text-faint)]">
            {isOpen ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
          </div>
        </button>

        {isOpen && (
          <div className="px-4 pb-3.5 pt-0.5 flex flex-col gap-2">
            {items.length === 0 && !loading ? (
              <div className="py-3 text-center text-xs text-[var(--ui-text-faint)]">
                请先绑定工作空间目录
              </div>
            ) : loading && items.length === 0 ? (
              <div className="py-3 flex items-center justify-center gap-1.5 text-xs text-[var(--ui-text-muted)]">
                <Loader2 size={13} className="animate-spin" />
                <span>正在读取仓库 Wiki…</span>
              </div>
            ) : !isMulti && singleItem ? (
              singleItem.exists && singleItem.content ? (
                <>
                  <div className="text-[10.5px] text-[var(--ui-text-faint)] leading-relaxed">
                    {formatGeneratedTime(singleItem.meta?.generatedAt) && (
                      <span>{formatGeneratedTime(singleItem.meta?.generatedAt)} · </span>
                    )}
                    {singleItem.meta?.fileCount ? `${singleItem.meta.fileCount} 个符号文件 · ` : ''}
                    {singleItem.meta?.symbolCount ? `${singleItem.meta.symbolCount} 个符号` : ''}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => openWikiModal(singleItem.workDir)}
                      className="flex-1 px-2.5 py-1.5 rounded-lg bg-[var(--ui-accent-emerald-soft)] border border-[color:var(--ui-accent-emerald-border)] text-[11px] text-[var(--ui-accent-emerald)] font-medium hover:opacity-90 transition-opacity"
                    >
                      查看仓库 Wiki
                    </button>
                    <button
                      onClick={() => void generateSingleWiki(singleItem.workDir, true)}
                      disabled={Boolean(generatingDirs[singleItem.workDir])}
                      className="p-1.5 rounded-lg bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)] text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] transition-colors disabled:opacity-40"
                      title="重新生成"
                    >
                      {generatingDirs[singleItem.workDir] ? (
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
                    onClick={() => void generateSingleWiki(singleItem.workDir, true)}
                    disabled={Boolean(generatingDirs[singleItem.workDir])}
                    className="w-full px-2.5 py-1.5 rounded-lg bg-[var(--ui-accent-emerald-soft)] border border-[color:var(--ui-accent-emerald-border)] text-[11px] text-[var(--ui-accent-emerald)] font-medium hover:opacity-90 transition-opacity flex items-center justify-center gap-1.5 disabled:opacity-50"
                  >
                    {generatingDirs[singleItem.workDir] ? (
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
              )
            ) : (
              <>
                {/* 多目录工作空间：逐目录状态与行内操作 */}
                <div className="flex flex-col gap-1.5 max-h-52 overflow-y-auto custom-scrollbar pr-0.5">
                  {items.map((item) => {
                    const isGen = Boolean(generatingDirs[item.workDir]);
                    const hasContent = item.exists && Boolean(item.content);
                    return (
                      <div
                        key={item.workDir}
                        className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)]"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span
                              className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                                hasContent
                                  ? 'bg-[var(--ui-accent-emerald)]'
                                  : 'bg-[var(--ui-text-faint)]/40'
                              }`}
                            />
                            <span
                              className="text-[11.5px] font-medium text-[var(--ui-text-primary)] truncate"
                              title={item.workDir}
                            >
                              {item.name}
                            </span>
                            {item.isPrimary && (
                              <span className="px-1 py-0 rounded text-[9.5px] bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)] border border-[color:var(--ui-accent-blue-border)] flex-shrink-0">
                                主要
                              </span>
                            )}
                          </div>
                          <div className="text-[10px] text-[var(--ui-text-faint)] pl-3 truncate">
                            {hasContent
                              ? item.meta?.fileCount
                                ? `${item.meta.fileCount} 文件 · ${item.meta.symbolCount || 0} 符号`
                                : formatGeneratedTime(item.meta?.generatedAt) || '已就绪'
                              : '未生成 Wiki'}
                          </div>
                        </div>

                        <div className="flex items-center gap-1 flex-shrink-0">
                          {hasContent ? (
                            <>
                              <button
                                onClick={() => openWikiModal(item.workDir)}
                                className="px-2 py-1 rounded-md bg-[var(--ui-accent-emerald-soft)] border border-[color:var(--ui-accent-emerald-border)] text-[10.5px] text-[var(--ui-accent-emerald)] font-medium hover:opacity-90 transition-opacity"
                              >
                                查看
                              </button>
                              <button
                                onClick={() => void generateSingleWiki(item.workDir, false)}
                                disabled={isGen}
                                className="p-1 rounded-md bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-hairline)] text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] transition-colors disabled:opacity-40"
                                title={`重新生成 ${item.name}`}
                              >
                                {isGen ? (
                                  <Loader2 size={11} className="animate-spin" />
                                ) : (
                                  <RefreshCw size={11} />
                                )}
                              </button>
                            </>
                          ) : (
                            <button
                              onClick={() => void generateSingleWiki(item.workDir, false)}
                              disabled={isGen}
                              className="px-2 py-1 rounded-md bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-hairline)] text-[10.5px] text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)] transition-colors flex items-center gap-1 disabled:opacity-40"
                            >
                              {isGen ? (
                                <Loader2 size={10.5} className="animate-spin" />
                              ) : (
                                <Sparkles size={10.5} />
                              )}
                              <span>{isGen ? '生成中' : '生成'}</span>
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="flex items-center gap-1.5">
                  {generatedCount > 0 && (
                    <button
                      onClick={() => openWikiModal()}
                      className="flex-1 px-2.5 py-1.5 rounded-lg bg-[var(--ui-accent-emerald-soft)] border border-[color:var(--ui-accent-emerald-border)] text-[11px] text-[var(--ui-accent-emerald)] font-medium hover:opacity-90 transition-opacity"
                    >
                      浏览全部 Wiki
                    </button>
                  )}
                  <button
                    onClick={() => void handleGenerateBatch(missingCount > 0)}
                    disabled={isAnyGenerating}
                    className={`${
                      generatedCount > 0 ? '' : 'w-full'
                    } px-2.5 py-1.5 rounded-lg bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)] text-[11px] text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)] transition-colors flex items-center justify-center gap-1.5 disabled:opacity-40`}
                    title={
                      missingCount > 0
                        ? `为尚未生成的 ${missingCount} 个目录生成 Wiki`
                        : '全部目录重新生成 Wiki'
                    }
                  >
                    {batchGenerating ? (
                      <Loader2 size={11.5} className="animate-spin" />
                    ) : missingCount > 0 ? (
                      <Sparkles size={11.5} />
                    ) : (
                      <RefreshCw size={11.5} />
                    )}
                    <span>
                      {batchGenerating
                        ? '批量生成中…'
                        : missingCount > 0
                        ? `补齐缺失 (${missingCount})`
                        : '全部重生成'}
                    </span>
                  </button>
                </div>
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

      {showModal &&
        activeModalItem &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed inset-0 z-[99999] bg-[var(--ui-modal-overlay)] backdrop-blur-sm flex items-center justify-center p-6 animate-in fade-in duration-150"
            onClick={() => setShowModal(false)}
          >
            <div
              className="w-full max-w-4xl max-h-[85vh] bg-[var(--ui-modal-bg)] backdrop-blur-2xl backdrop-saturate-150 border border-[color:var(--ui-border-subtle)] rounded-2xl shadow-2xl overflow-hidden flex flex-col text-[var(--ui-text-primary)]"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="px-5 py-3.5 border-b border-[color:var(--ui-divider-hairline)] flex items-center justify-between flex-shrink-0 gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <BookOpen size={16} className="text-[var(--ui-accent-emerald)] flex-shrink-0" />
                  <h3 className="font-bold text-sm text-[var(--ui-text-primary)] truncate">
                    Repo Wiki · {activeModalItem.name}
                  </h3>
                  {activeModalItem.isPrimary && isMulti && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)] border border-[color:var(--ui-accent-blue-border)] flex-shrink-0">
                      主要目录
                    </span>
                  )}
                  {activeModalItem.meta?.generatedAt && (
                    <span className="text-[10px] text-[var(--ui-text-faint)] font-mono flex-shrink-0">
                      {new Date(activeModalItem.meta.generatedAt).toLocaleString('zh-CN')}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <button
                    onClick={() => void generateSingleWiki(activeModalItem.workDir, false)}
                    disabled={Boolean(generatingDirs[activeModalItem.workDir])}
                    className="px-2.5 py-1 rounded-lg bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)] text-[11px] text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)] flex items-center gap-1 disabled:opacity-40"
                    title="重新生成当前目录 Wiki"
                  >
                    {generatingDirs[activeModalItem.workDir] ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <RefreshCw size={12} />
                    )}
                    <span>{activeModalItem.exists ? '刷新' : '生成'}</span>
                  </button>
                  <button
                    onClick={() => setShowModal(false)}
                    className="p-1.5 rounded-lg hover:bg-[var(--ui-block-hover-bg)] text-[var(--ui-text-faint)] hover:text-[var(--ui-text-primary)]"
                  >
                    <X size={15} />
                  </button>
                </div>
              </div>

              {isMulti && (
                <div className="px-5 py-2 border-b border-[color:var(--ui-divider-hairline)] flex items-center gap-1.5 overflow-x-auto custom-scrollbar flex-shrink-0 bg-[var(--ui-card-bg)]">
                  {items.map((item) => {
                    const active = item.workDir === activeModalItem.workDir;
                    const ready = item.exists && Boolean(item.content);
                    return (
                      <button
                        key={item.workDir}
                        onClick={() => setSelectedModalDir(item.workDir)}
                        className={`px-2.5 py-1 rounded-lg text-xs flex items-center gap-1.5 whitespace-nowrap transition-colors border ${
                          active
                            ? 'bg-[var(--ui-accent-emerald-soft)] border-[color:var(--ui-accent-emerald-border)] text-[var(--ui-accent-emerald)] font-medium'
                            : 'bg-[var(--ui-chip-bg)] border-[color:var(--ui-border-hairline)] text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)]'
                        }`}
                        title={item.workDir}
                      >
                        <FolderGit2 size={12} className="flex-shrink-0" />
                        <span>{item.name}</span>
                        {item.isPrimary && (
                          <span className="text-[9.5px] opacity-75">(主)</span>
                        )}
                        <span
                          className={`w-1.5 h-1.5 rounded-full ${
                            ready ? 'bg-[var(--ui-accent-emerald)]' : 'bg-[var(--ui-text-faint)]/40'
                          }`}
                        />
                      </button>
                    );
                  })}
                </div>
              )}

              <div className="flex-1 overflow-y-auto p-5 custom-scrollbar select-text">
                {activeModalItem.exists && activeModalItem.content ? (
                  <MarkdownContent content={activeModalItem.content} />
                ) : (
                  <div className="py-14 flex flex-col items-center justify-center gap-3 text-center">
                    <BookOpen size={28} className="text-[var(--ui-text-faint)]" />
                    <div className="text-sm text-[var(--ui-text-secondary)]">
                      「{activeModalItem.name}」尚未生成 Repo Wiki
                    </div>
                    <div className="text-xs text-[var(--ui-text-faint)] max-w-md">
                      点击下方按钮扫描该目录源码索引、README 与构建清单并生成结构化说明
                    </div>
                    <button
                      onClick={() => void generateSingleWiki(activeModalItem.workDir, false)}
                      disabled={Boolean(generatingDirs[activeModalItem.workDir])}
                      className="mt-1 px-4 py-2 rounded-xl bg-[var(--ui-accent-emerald-soft)] border border-[color:var(--ui-accent-emerald-border)] text-xs text-[var(--ui-accent-emerald)] font-medium hover:opacity-90 flex items-center gap-1.5 disabled:opacity-50"
                    >
                      {generatingDirs[activeModalItem.workDir] ? (
                        <>
                          <Loader2 size={13} className="animate-spin" />
                          <span>正在扫描并生成…</span>
                        </>
                      ) : (
                        <>
                          <Sparkles size={13} />
                          <span>立即生成此目录 Wiki</span>
                        </>
                      )}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
};

export default RepoWikiCard;
