import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Store,
  X,
  Search,
  Download,
  Loader2,
  AlertCircle,
  CheckCircle2,
  RefreshCw,
} from "lucide-react";

const PAGE_SIZE = 12;
const MARKET_URL_KEY = "omcx.skill_market_url";

interface MarketItem {
  id: string;
  name: string;
  description?: string;
  version?: string;
  author?: string;
  tags?: string[];
  source?: string;
  sourceLabel?: string;
  installKind?: string;
  downloadUrl?: string;
  repo?: string;
  dirPath?: string;
  ref?: string;
}

interface SkillMarketModalProps {
  open: boolean;
  onClose: () => void;
  onInstalled?: () => void | Promise<void>;
}

/**
 * 技能市场弹层：粘贴任意市场链接（JSON 接口 / GitHub 仓库 / 单个 SKILL.md），
 * 分页动态拉取并一键下载到 ~/.omcx/skills。
 */
const SkillMarketModal: React.FC<SkillMarketModalProps> = ({ open, onClose, onInstalled }) => {
  const [url, setUrl] = useState(() => {
    try {
      return window.localStorage.getItem(MARKET_URL_KEY) || "";
    } catch {
      return "";
    }
  });
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<MarketItem[]>([]);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [sourceLabel, setSourceLabel] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [installing, setInstalling] = useState<Record<string, boolean>>({});
  const [installed, setInstalled] = useState<Set<string>>(new Set());

  const seqRef = useRef(0);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadingRef = useRef(false);
  const stateRef = useRef({ hasMore: false, page: 0 });
  // 记录当前列表实际使用的来源与关键词，翻页时不被输入框里未提交的内容影响
  const activeRef = useRef({ url: "", query: "" });
  stateRef.current = { hasMore, page };
  loadingRef.current = loading;

  const loadPage = useCallback(
    async (targetPage: number, replace: boolean, keyword: string, sourceUrl: string) => {
      const source = sourceUrl.trim();
      if (!source) {
        setError("请先填入技能市场链接");
        return;
      }
      const seq = ++seqRef.current;
      setLoading(true);
      setError("");
      try {
        const res = await window.electronAPI?.fetchSkillMarket?.({
          url: source,
          page: targetPage,
          pageSize: PAGE_SIZE,
          query: keyword.trim(),
        });
        if (seq !== seqRef.current) return;
        if (!res?.success) {
          setError(res?.error || "拉取技能市场失败");
          if (replace) {
            setItems([]);
            setHasMore(false);
            setTotal(0);
            setLoadedOnce(true);
          }
          return;
        }
        const incoming: MarketItem[] = Array.isArray(res.items) ? res.items : [];
        setItems((prev) => {
          if (replace) return incoming;
          const seen = new Set(prev.map((item) => item.id));
          return [...prev, ...incoming.filter((item) => !seen.has(item.id))];
        });
        setPage(res.page || targetPage);
        setTotal(Number(res.total) || 0);
        setHasMore(Boolean(res.hasMore));
        setSourceLabel(res.sourceLabel || "");
        setLoadedOnce(true);
        activeRef.current = { url: source, query: keyword.trim() };
        try {
          window.localStorage.setItem(MARKET_URL_KEY, source);
        } catch {}
      } catch (err: any) {
        if (seq === seqRef.current) setError(err?.message || "拉取技能市场失败");
      } finally {
        if (seq === seqRef.current) setLoading(false);
      }
    },
    []
  );

  // 打开时重置并自动加载已保存的市场
  useEffect(() => {
    if (!open) return;
    seqRef.current += 1;
    setQuery("");
    setItems([]);
    setPage(0);
    setTotal(0);
    setHasMore(false);
    setError("");
    setNotice("");
    setLoadedOnce(false);
    let saved = "";
    try {
      saved = window.localStorage.getItem(MARKET_URL_KEY) || "";
    } catch {}
    setUrl(saved);
    if (saved) loadPage(1, true, "", saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Esc 关闭 + 锁定页面滚动
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 3200);
    return () => clearTimeout(timer);
  }, [notice]);

  const loadMore = useCallback(() => {
    if (loadingRef.current || !stateRef.current.hasMore) return;
    loadPage(
      stateRef.current.page + 1,
      false,
      activeRef.current.query,
      activeRef.current.url
    );
  }, [loadPage]);

  // 触底自动加载下一页
  useEffect(() => {
    if (!open || !hasMore || loading) return;
    const target = sentinelRef.current;
    if (!target) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMore();
      },
      { rootMargin: "160px" }
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [open, hasMore, loading, items.length, loadMore]);

  const handleInstall = async (item: MarketItem) => {
    if (installing[item.id] || !window.electronAPI?.installMarketSkill) return;
    setInstalling((prev) => ({ ...prev, [item.id]: true }));
    try {
      let res = await window.electronAPI.installMarketSkill(item, false);
      if (res?.code === "exists") {
        const confirmed = window.confirm(
          `技能「${res.name || item.name}」已存在，是否覆盖安装？`
        );
        if (!confirmed) return;
        res = await window.electronAPI.installMarketSkill(item, true);
      }
      if (res?.success) {
        setInstalled((prev) => new Set(prev).add(item.id));
        setNotice(`已安装「${res.name || item.name}」`);
        await onInstalled?.();
      } else {
        setNotice(res?.error || "下载失败");
      }
    } catch (err: any) {
      setNotice(err?.message || "下载失败");
    } finally {
      setInstalling((prev) => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });
    }
  };

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[99999] flex items-center justify-center p-6 bg-[var(--ui-modal-overlay)] backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-4xl h-[82vh] flex flex-col overflow-hidden rounded-2xl border border-[color:var(--ui-border-subtle)] bg-[var(--ui-modal-bg)] backdrop-blur-2xl shadow-2xl">
        {/* 头部 */}
        <div className="h-12 px-4 flex items-center justify-between border-b border-[color:var(--ui-divider-hairline)] flex-shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-7 h-7 rounded-lg bg-[var(--ui-accent-emerald-soft)] border border-[color:var(--ui-accent-emerald-border)] flex items-center justify-center text-[var(--ui-accent-emerald)] flex-shrink-0">
              <Store size={14} />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-[var(--ui-text-primary)]">技能市场</div>
              <div className="text-[10px] text-[var(--ui-text-muted)] truncate">
                粘贴 JSON 接口 / GitHub 仓库 / SKILL.md 链接，分页加载并一键下载
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <span className="text-[10px] font-mono text-[var(--ui-text-faint)]">Esc</span>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-chip-hover-bg)] transition-colors"
              title="关闭"
            >
              <X size={15} />
            </button>
          </div>
        </div>

        {/* 链接与搜索 */}
        <div className="px-4 py-3 flex items-center gap-2 border-b border-[color:var(--ui-divider-hairline)] flex-shrink-0">
          <div className="ui-focus-ring flex-1 min-w-0 flex items-center gap-2 h-9 px-3 rounded-xl bg-[var(--ui-input-bg)] border border-[color:var(--ui-border-hairline)] focus-within:bg-[var(--ui-input-hover-bg)] transition-colors">
            <Store size={13} className="text-[var(--ui-text-faint)] flex-shrink-0" />
            <input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") loadPage(1, true, query, url);
              }}
              placeholder="https://example.com/api/skills 或 https://github.com/owner/repo"
              className="flex-1 min-w-0 bg-transparent text-xs text-[var(--ui-text-primary)] placeholder:text-[var(--ui-text-faint)] outline-none"
            />
          </div>
          <div className="ui-focus-ring w-40 flex items-center gap-2 h-9 px-3 rounded-xl bg-[var(--ui-input-bg)] border border-[color:var(--ui-border-hairline)] focus-within:bg-[var(--ui-input-hover-bg)] transition-colors">
            <Search size={13} className="text-[var(--ui-text-faint)] flex-shrink-0" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") loadPage(1, true, query, url);
              }}
              placeholder="搜索"
              className="flex-1 min-w-0 bg-transparent text-xs text-[var(--ui-text-primary)] placeholder:text-[var(--ui-text-faint)] outline-none"
            />
          </div>
          <button
            onClick={() => loadPage(1, true, query, url)}
            disabled={loading}
            className="h-9 px-3.5 rounded-xl bg-[var(--ui-accent-emerald)] hover:opacity-90 text-[var(--ui-panel-bg)] text-xs font-medium flex items-center gap-1.5 disabled:opacity-60 transition-opacity"
          >
            {loading && page === 0 ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
            <span>加载</span>
          </button>
        </div>

        {/* 状态条：无内容可报时整行收起，避免留一条空的「等待加载」横条 */}
        {(loadedOnce || Boolean(sourceLabel) || Boolean(error) || Boolean(notice)) && (
          <div className="px-4 h-8 flex items-center justify-between gap-3 text-[10.5px] text-[var(--ui-text-muted)] flex-shrink-0 border-b border-[color:var(--ui-divider-hairline)]">
            <span className="truncate flex items-center gap-1.5">
              {loading && <Loader2 size={10} className="animate-spin flex-shrink-0" />}
              {sourceLabel ? `来源 ${sourceLabel} · ` : ""}
              {total > 0
                ? `${hasMore ? "至少" : "共"} ${total} 项 / 已加载 ${items.length}`
                : loading
                ? "正在拉取技能市场…"
                : loadedOnce
                ? "无匹配结果"
                : "等待加载"}
            </span>
            {notice && (
              <span className="flex items-center gap-1 text-[var(--ui-accent-emerald)] flex-shrink-0">
                <CheckCircle2 size={11} />
                {notice}
              </span>
            )}
            {!notice && error && (
              <span className="flex items-center gap-1 text-[var(--ui-accent-rose)] flex-shrink-0 max-w-[55%] truncate" title={error}>
                <AlertCircle size={11} />
                {error}
              </span>
            )}
          </div>
        )}

        {/* 列表 */}
        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-4">
          {items.length === 0 && loading && (
            <div className="h-full flex items-center justify-center text-xs text-[var(--ui-text-muted)] gap-2">
              <Loader2 size={14} className="animate-spin" />
              正在拉取技能市场…
            </div>
          )}

          {items.length === 0 && !loading && loadedOnce && !error && (
            <div className="h-full flex items-center justify-center text-xs text-[var(--ui-text-muted)]">
              该市场暂时没有可用技能
            </div>
          )}

          {items.length === 0 && !loading && !loadedOnce && (
            <div className="h-full flex flex-col items-center justify-center gap-2 text-center px-6">
              <Store size={22} className="text-[var(--ui-text-faint)]" />
              <div className="text-xs text-[var(--ui-text-secondary)]">填入技能市场链接后点击「加载」</div>
              <div className="text-[10.5px] text-[var(--ui-text-faint)] leading-relaxed max-w-sm">
                支持分页 JSON 接口（page / pageSize / q）、GitHub 仓库或目录、单个 SKILL.md 直链
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {items.map((item) => {
              const isInstalling = Boolean(installing[item.id]);
              const isInstalled = installed.has(item.id);
              return (
                <div
                  key={item.id}
                  className="p-3.5 rounded-xl bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-hairline)] hover:border-[color:var(--ui-border-subtle)] transition-colors flex flex-col gap-2"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="text-sm font-semibold text-[var(--ui-text-primary)] truncate">{item.name}</span>
                        {item.version && (
                          <span className="px-1.5 py-0.2 rounded text-[10px] font-mono bg-[var(--ui-chip-bg)] text-[var(--ui-text-secondary)] border border-[color:var(--ui-border-subtle)] flex-shrink-0">
                            v{item.version}
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-[var(--ui-text-muted)] truncate mt-0.5">
                        {[item.author, item.sourceLabel || item.repo, item.dirPath]
                          .filter(Boolean)
                          .join(" · ") || item.source}
                      </div>
                    </div>
                    <button
                      onClick={() => handleInstall(item)}
                      disabled={isInstalling}
                      className={`h-7 px-2.5 rounded-lg text-[11px] font-medium flex items-center gap-1 flex-shrink-0 border transition-colors ${
                        isInstalled
                          ? "bg-[var(--ui-accent-emerald-soft)] text-[var(--ui-accent-emerald)] border-[color:var(--ui-accent-emerald-border)]"
                          : "bg-[var(--ui-chip-bg)] text-[var(--ui-text-primary)] border-[color:var(--ui-border-subtle)] hover:bg-[var(--ui-chip-hover-bg)]"
                      } disabled:opacity-60`}
                      title={isInstalled ? "已安装，可再次下载覆盖" : "下载并安装到 ~/.omcx/skills"}
                    >
                      {isInstalling ? (
                        <Loader2 size={11} className="animate-spin" />
                      ) : isInstalled ? (
                        <RefreshCw size={11} />
                      ) : (
                        <Download size={11} />
                      )}
                      <span>{isInstalling ? "下载中" : isInstalled ? "重新下载" : "下载"}</span>
                    </button>
                  </div>

                  <p className="text-[11px] text-[var(--ui-text-secondary)] leading-relaxed line-clamp-3 min-h-[2.6em]">
                    {item.description || "暂无描述"}
                  </p>

                  {item.tags && item.tags.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1">
                      {item.tags.slice(0, 4).map((tag) => (
                        <span
                          key={tag}
                          className="px-1.5 py-0.2 rounded bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)] text-[9.5px] font-mono text-[var(--ui-text-muted)]"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {items.length > 0 && (
            <div ref={sentinelRef} className="h-10 flex items-center justify-center text-[10.5px] text-[var(--ui-text-faint)]">
              {loading ? (
                <span className="flex items-center gap-1.5">
                  <Loader2 size={11} className="animate-spin" />
                  加载中…
                </span>
              ) : hasMore ? (
                <button onClick={loadMore} className="text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] transition-colors">
                  加载更多
                </button>
              ) : (
                <span>已经到底了</span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};

export default SkillMarketModal;
