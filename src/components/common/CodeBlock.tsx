import React, { useState, useEffect, useId, memo, useMemo } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import * as Diff from 'diff';
import {
  Copy,
  Check,
  Terminal,
  FileCode,
  Eye,
  Code2,
  WrapText,
  Hash,
  GitCompare,
  Sparkles,
} from 'lucide-react';
import { getEffectiveTheme, subscribeThemeChange, type EffectiveTheme } from '@/theme';

function useEffectiveTheme(): EffectiveTheme {
  const [theme, setTheme] = useState<EffectiveTheme>(() => getEffectiveTheme());
  useEffect(() => {
    setTheme(getEffectiveTheme());
    return subscribeThemeChange(setTheme);
  }, []);
  return theme;
}

// 制品预览隔离：SVG/XML 属于模型或工作区可控内容，必须放入无脚本权限的 sandbox iframe，
// 并通过内联 CSP 禁止外部资源请求，彻底阻断 <svg onload> / <img onerror> 一类 XSS 链。
const ARTIFACT_PREVIEW_CSP =
  "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:";

function buildArtifactSrcDoc(svg: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"/><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_PREVIEW_CSP}"/><style>html,body{margin:0;padding:0;background:transparent;overflow:auto;}body{display:flex;align-items:center;justify-content:center;min-height:100vh;padding:16px;box-sizing:border-box;}svg{max-width:100%;height:auto;}</style></head><body>${String(svg || '')}</body></html>`;
}

// 清洗语法高亮主题中内层 code / token 的默认背景色与文字阴影，由外层容器语义背景统一承载
function stripSyntaxThemeBg(
  themeObj: Record<string, React.CSSProperties>
): Record<string, React.CSSProperties> {
  return Object.fromEntries(
    Object.entries(themeObj).map(([key, val]) => [
      key,
      {
        ...(val as React.CSSProperties),
        background: 'transparent',
        backgroundColor: 'transparent',
        textShadow: 'none',
      },
    ])
  );
}

const cleanOneDark = stripSyntaxThemeBg(oneDark as Record<string, React.CSSProperties>);
const cleanOneLight = stripSyntaxThemeBg(oneLight as Record<string, React.CSSProperties>);

/**
 * 通用 Diff 对比视图组件（基于开源库 jsdiff）
 * 同时供 Markdown ```diff 代码块与 ToolStepList 的 edit_file 工具使用
 */
export const DiffViewer: React.FC<{
  oldText?: string;
  newText?: string;
  rawPatch?: string;
  filePath?: string;
  maxHeightClass?: string;
}> = memo(({ oldText, newText, rawPatch, filePath, maxHeightClass = 'max-h-[420px]' }) => {
  const [copied, setCopied] = useState(false);

  const lines: Array<{
    type: 'add' | 'del' | 'normal' | 'hunk';
    text: string;
    oldLine?: number;
    newLine?: number;
  }> = [];

  let addedCount = 0;
  let removedCount = 0;

  if (rawPatch !== undefined) {
    const rawLines = rawPatch.split(/\r?\n/);
    for (const line of rawLines) {
      if (line.startsWith('@@')) {
        lines.push({ type: 'hunk', text: line });
      } else if (line.startsWith('+') && !line.startsWith('+++')) {
        addedCount++;
        lines.push({ type: 'add', text: line.slice(1) });
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        removedCount++;
        lines.push({ type: 'del', text: line.slice(1) });
      } else {
        lines.push({ type: 'normal', text: line.startsWith(' ') ? line.slice(1) : line });
      }
    }
  } else {
    const changes = Diff.diffLines(String(oldText || ''), String(newText || ''));
    let oldLineNum = 1;
    let newLineNum = 1;

    for (const part of changes) {
      const partLines = part.value.replace(/\r?\n$/, '').split(/\r?\n/);
      for (const l of partLines) {
        if (part.added) {
          addedCount++;
          lines.push({ type: 'add', text: l, newLine: newLineNum++ });
        } else if (part.removed) {
          removedCount++;
          lines.push({ type: 'del', text: l, oldLine: oldLineNum++ });
        } else {
          lines.push({
            type: 'normal',
            text: l,
            oldLine: oldLineNum++,
            newLine: newLineNum++,
          });
        }
      }
    }
  }

  const handleCopy = () => {
    const textToCopy = rawPatch ?? newText ?? '';
    navigator.clipboard.writeText(textToCopy);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className='my-2.5 rounded-xl overflow-hidden border border-[color:var(--ui-border-hairline)] bg-[var(--ui-code-bg)] transition-colors'>
      <div className='px-3 py-1.5 bg-[var(--ui-code-header-bg)] border-b border-[color:var(--ui-divider-hairline)] flex items-center justify-between text-xs select-none'>
        <div className='flex items-center gap-2 min-w-0'>
          <GitCompare size={13} className='text-[var(--ui-accent-blue)] flex-shrink-0' />
          <span className='font-mono text-[11px] text-[var(--ui-text-secondary)] truncate'>
            {filePath || '代码变更对比 (Diff)'}
          </span>
          <div className='flex items-center gap-1.5 font-mono text-[10px] ml-1'>
            <span className='px-1.5 py-0.2 rounded bg-[var(--ui-accent-emerald-soft)] text-[var(--ui-accent-emerald)] border border-[color:var(--ui-accent-emerald-border)]'>
              +{addedCount}
            </span>
            <span className='px-1.5 py-0.2 rounded bg-[var(--ui-accent-rose-soft)] text-[var(--ui-accent-rose)] border border-[color:var(--ui-accent-rose-border)]'>
              -{removedCount}
            </span>
          </div>
        </div>
        <button
          onClick={handleCopy}
          className='flex items-center gap-1 px-2 py-0.5 rounded hover:bg-[var(--ui-chip-hover-bg)] text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] transition-colors text-[11px]'
          title='复制变更后内容'
        >
          {copied ? <Check size={12} className='text-[var(--ui-accent-emerald)]' /> : <Copy size={12} />}
          <span>{copied ? '已复制' : '复制'}</span>
        </button>
      </div>

      <div className={`overflow-x-auto overflow-y-auto custom-scrollbar font-mono text-[12px] leading-[1.6] ${maxHeightClass}`}>
        {lines.map((item, idx) => {
          if (item.type === 'hunk') {
            return (
              <div
                key={idx}
                className='px-3 py-0.5 bg-[var(--ui-diff-hunk-bg)] text-[var(--ui-diff-hunk-text)] border-y border-[color:var(--ui-accent-blue-border)] select-none text-[11px]'
              >
                {item.text}
              </div>
            );
          }

          const bgClass =
            item.type === 'add'
              ? 'bg-[var(--ui-diff-add-bg)] text-[var(--ui-diff-add-text)]'
              : item.type === 'del'
              ? 'bg-[var(--ui-diff-del-bg)] text-[var(--ui-diff-del-text)]'
              : 'text-[var(--ui-text-secondary)] hover:bg-[var(--ui-block-hover-bg)]';

          const prefix = item.type === 'add' ? '+' : item.type === 'del' ? '-' : ' ';
          const prefixColor =
            item.type === 'add'
              ? 'text-[var(--ui-accent-emerald)]'
              : item.type === 'del'
              ? 'text-[var(--ui-accent-rose)]'
              : 'text-[var(--ui-text-faint)]';

          return (
            <div key={idx} className={`flex items-stretch px-2 ${bgClass}`}>
              <span className='w-7 text-right pr-2 select-none text-[10px] text-[var(--ui-text-faint)] flex-shrink-0'>
                {item.oldLine ?? ''}
              </span>
              <span className='w-7 text-right pr-2 select-none text-[10px] text-[var(--ui-text-faint)] flex-shrink-0 border-r border-[color:var(--ui-divider-hairline)]'>
                {item.newLine ?? ''}
              </span>
              <span className={`w-5 text-center select-none font-bold flex-shrink-0 ${prefixColor}`}>
                {prefix}
              </span>
              <span className='whitespace-pre pr-3'>{item.text || ' '}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
});

export interface SplitDiffViewerProps {
  oldText?: string;
  newText?: string;
  filePath?: string;
  isNewFile?: boolean;
  noSnapshot?: boolean;
  actionLabel?: string;
  maxHeightClass?: string;
  maxBodyHeightPx?: number;
  embedded?: boolean;
  onOpenInFinder?: () => void;
}

interface SplitDiffSideCell {
  type: 'normal' | 'del' | 'add' | 'empty';
  lineNum?: number;
  text: string;
}

type SplitDiffRow =
  | {
      kind: 'pair';
      left: SplitDiffSideCell;
      right: SplitDiffSideCell;
    }
  | {
      kind: 'collapsed';
      id: string;
      hiddenCount: number;
      rows: Array<{ left: SplitDiffSideCell; right: SplitDiffSideCell }>;
    };

function splitLinesPreservingContent(value: string): string[] {
  if (!value) return [];
  const normalized = value.replace(/\r\n/g, '\n');
  const trimmed = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
  return trimmed.split('\n');
}

function buildSplitDiffModel(oldText: string, newText: string) {
  const changes = Diff.diffLines(oldText, newText);
  const rawRows: Array<{ left: SplitDiffSideCell; right: SplitDiffSideCell }> = [];

  let oldLineNum = 1;
  let newLineNum = 1;
  let addedCount = 0;
  let removedCount = 0;

  for (let i = 0; i < changes.length; i++) {
    const part = changes[i];
    const nextPart = changes[i + 1];

    // 将相邻的“删除块 + 新增块”合并配对到左右同一行区间
    if (part.removed && nextPart && nextPart.added) {
      const delLines = splitLinesPreservingContent(part.value);
      const addLines = splitLinesPreservingContent(nextPart.value);
      const maxLen = Math.max(delLines.length, addLines.length);

      for (let j = 0; j < maxLen; j++) {
        const hasDel = j < delLines.length;
        const hasAdd = j < addLines.length;
        if (hasDel) removedCount++;
        if (hasAdd) addedCount++;

        rawRows.push({
          left: hasDel
            ? { type: 'del', lineNum: oldLineNum++, text: delLines[j] }
            : { type: 'empty', text: '' },
          right: hasAdd
            ? { type: 'add', lineNum: newLineNum++, text: addLines[j] }
            : { type: 'empty', text: '' },
        });
      }
      i++; // 跳过已配对的 nextPart
      continue;
    }

    const partLines = splitLinesPreservingContent(part.value);
    if (part.removed) {
      for (const line of partLines) {
        removedCount++;
        rawRows.push({
          left: { type: 'del', lineNum: oldLineNum++, text: line },
          right: { type: 'empty', text: '' },
        });
      }
    } else if (part.added) {
      for (const line of partLines) {
        addedCount++;
        rawRows.push({
          left: { type: 'empty', text: '' },
          right: { type: 'add', lineNum: newLineNum++, text: line },
        });
      }
    } else {
      for (const line of partLines) {
        rawRows.push({
          left: { type: 'normal', lineNum: oldLineNum++, text: line },
          right: { type: 'normal', lineNum: newLineNum++, text: line },
        });
      }
    }
  }

  // 当存在实际变更且有长段连续未变更行（> 10 行）时，智能折叠中间上下文（保留前后各 3 行）
  const hasChanges = addedCount > 0 || removedCount > 0;
  const rows: SplitDiffRow[] = [];

  if (!hasChanges || rawRows.length <= 24) {
    for (const r of rawRows) {
      rows.push({ kind: 'pair', left: r.left, right: r.right });
    }
  } else {
    let idx = 0;
    while (idx < rawRows.length) {
      const isNormal =
        rawRows[idx].left.type === 'normal' && rawRows[idx].right.type === 'normal';
      if (!isNormal) {
        rows.push({ kind: 'pair', left: rawRows[idx].left, right: rawRows[idx].right });
        idx++;
        continue;
      }

      let end = idx;
      while (
        end < rawRows.length &&
        rawRows[end].left.type === 'normal' &&
        rawRows[end].right.type === 'normal'
      ) {
        end++;
      }

      const runLen = end - idx;
      const keepHead = idx === 0 ? 0 : 3;
      const keepTail = end === rawRows.length ? 0 : 3;

      if (runLen > keepHead + keepTail + 4) {
        for (let k = idx; k < idx + keepHead; k++) {
          rows.push({ kind: 'pair', left: rawRows[k].left, right: rawRows[k].right });
        }
        const collapsedSlice = rawRows.slice(idx + keepHead, end - keepTail);
        rows.push({
          kind: 'collapsed',
          id: `col_${idx}_${end}`,
          hiddenCount: collapsedSlice.length,
          rows: collapsedSlice,
        });
        for (let k = end - keepTail; k < end; k++) {
          rows.push({ kind: 'pair', left: rawRows[k].left, right: rawRows[k].right });
        }
      } else {
        for (let k = idx; k < end; k++) {
          rows.push({ kind: 'pair', left: rawRows[k].left, right: rawRows[k].right });
        }
      }

      idx = end;
    }
  }

  return { rows, addedCount, removedCount };
}

/**
 * 左右分块差异对比组件 (Side-by-Side Split Diff)
 * 专为修改类工具悬浮弹出层与精确代码审阅打造，左右行高由 CSS Grid 自动对齐
 */
export const SplitDiffViewer: React.FC<SplitDiffViewerProps> = memo(
  ({
    oldText = '',
    newText = '',
    filePath,
    isNewFile = false,
    noSnapshot = false,
    actionLabel,
    maxHeightClass = 'max-h-[420px]',
    maxBodyHeightPx,
    embedded = false,
    onOpenInFinder,
  }) => {
    const [copied, setCopied] = useState(false);
    const [wrapLines, setWrapLines] = useState(true);
    const [expandedCollapsedIds, setExpandedCollapsedIds] = useState<Record<string, boolean>>({});

    const { rows, addedCount, removedCount } = React.useMemo(
      () => buildSplitDiffModel(String(oldText || ''), String(newText || '')),
      [oldText, newText]
    );

    const handleCopy = () => {
      navigator.clipboard.writeText(String(newText || ''));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    };

    const toggleExpandChunk = (id: string) => {
      setExpandedCollapsedIds((prev) => ({ ...prev, [id]: !prev[id] }));
    };

    const renderCell = (cell: SplitDiffSideCell, side: 'left' | 'right') => {
      const isDel = cell.type === 'del';
      const isAdd = cell.type === 'add';
      const isEmpty = cell.type === 'empty';

      const cellBg = isDel
        ? 'bg-[var(--ui-diff-del-bg)] text-[var(--ui-diff-del-text)]'
        : isAdd
        ? 'bg-[var(--ui-diff-add-bg)] text-[var(--ui-diff-add-text)]'
        : isEmpty
        ? 'bg-[var(--ui-diff-empty-bg)]'
        : 'text-[var(--ui-text-secondary)] hover:bg-[var(--ui-block-hover-bg)]';

      const gutterBorder = side === 'left' ? 'border-r border-[color:var(--ui-divider-hairline)]' : '';
      const marker = isDel ? '-' : isAdd ? '+' : ' ';
      const markerColor = isDel
        ? 'text-[var(--ui-accent-rose)]'
        : isAdd
        ? 'text-[var(--ui-accent-emerald)]'
        : 'text-[var(--ui-text-faint)]';

      return (
        <div
          className={`flex items-stretch min-w-0 ${cellBg} ${gutterBorder}`}
        >
          <span className='w-8 text-right pr-2 py-0.5 select-none text-[10px] text-[var(--ui-text-faint)] flex-shrink-0 border-r border-[color:var(--ui-divider-hairline)]'>
            {cell.lineNum ?? ''}
          </span>
          <span
            className={`w-4 text-center py-0.5 select-none font-bold flex-shrink-0 text-[11px] ${markerColor}`}
          >
            {isEmpty ? '' : marker}
          </span>
          <span
            className={`flex-1 min-w-0 py-0.5 pr-2.5 ${
              wrapLines ? 'whitespace-pre-wrap break-all' : 'whitespace-pre overflow-x-auto custom-scrollbar'
            }`}
          >
            {isEmpty ? ' ' : cell.text || ' '}
          </span>
        </div>
      );
    };

    return (
      <div
        className={
          embedded
            ? 'w-full overflow-hidden bg-[var(--ui-code-bg)]'
            : 'my-2 rounded-xl overflow-hidden border border-[color:var(--ui-border-hairline)] bg-[var(--ui-code-bg)]'
        }
      >
        {/* 顶部栏 */}
        <div className='px-3 py-2 bg-[var(--ui-code-header-bg)] border-b border-[color:var(--ui-divider-hairline)] flex items-center justify-between gap-3 text-xs select-none'>
          <div className='flex items-center gap-2 min-w-0'>
            <GitCompare size={13} className='text-[var(--ui-accent-blue)] flex-shrink-0' />
            {actionLabel && (
              <span
                className={`px-1.5 py-0.2 rounded text-[10px] font-medium flex-shrink-0 ${
                  isNewFile
                    ? 'bg-[var(--ui-accent-emerald-soft)] text-[var(--ui-accent-emerald)] border border-[color:var(--ui-accent-emerald-border)]'
                    : 'bg-[var(--ui-accent-amber-soft)] text-[var(--ui-accent-amber)] border border-[color:var(--ui-accent-amber-border)]'
                }`}
              >
                {actionLabel}
              </span>
            )}
            <button
              type='button'
              onClick={onOpenInFinder || (() => filePath && window.electronAPI?.showInFolder?.(filePath))}
              className='font-mono text-[11px] text-[var(--ui-text-primary)] hover:text-[var(--ui-accent-blue)] truncate transition-colors text-left'
              title={filePath ? `${filePath} (点击定位文件)` : undefined}
            >
              {filePath || '代码变更对比'}
            </button>
            <div className='flex items-center gap-1 font-mono text-[10px] flex-shrink-0'>
              {addedCount > 0 && (
                <span className='px-1.5 py-0.2 rounded bg-[var(--ui-accent-emerald-soft)] text-[var(--ui-accent-emerald)] border border-[color:var(--ui-accent-emerald-border)]'>
                  +{addedCount}
                </span>
              )}
              {removedCount > 0 && (
                <span className='px-1.5 py-0.2 rounded bg-[var(--ui-accent-rose-soft)] text-[var(--ui-accent-rose)] border border-[color:var(--ui-accent-rose-border)]'>
                  -{removedCount}
                </span>
              )}
            </div>
          </div>

          <div className='flex items-center gap-1 flex-shrink-0'>
            <button
              type='button'
              onClick={() => setWrapLines((v) => !v)}
              className={`flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-[var(--ui-chip-hover-bg)] transition-colors text-[10.5px] ${
                wrapLines
                  ? 'text-[var(--ui-accent-blue)]'
                  : 'text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)]'
              }`}
              title='切换自动换行'
            >
              <WrapText size={11} />
              <span>换行</span>
            </button>
            <button
              type='button'
              onClick={handleCopy}
              className='flex items-center gap-1 px-2 py-0.5 rounded hover:bg-[var(--ui-chip-hover-bg)] text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] transition-colors text-[10.5px]'
              title='复制变更后内容'
            >
              {copied ? <Check size={11} className='text-[var(--ui-accent-emerald)]' /> : <Copy size={11} />}
              <span>{copied ? '已复制' : '复制'}</span>
            </button>
          </div>
        </div>

        {/* 历史无旧快照降级提示 */}
        {noSnapshot && (
          <div className='px-3 py-1 bg-[var(--ui-accent-amber-soft)] border-b border-[color:var(--ui-divider-hairline)] text-[10.5px] text-[var(--ui-accent-amber)]'>
            该历史写入记录未保留修改前快照，左侧为空白对照，右侧展示写入后的目标内容
          </div>
        )}

        {/* 左右分栏列头 */}
        <div className='grid grid-cols-2 bg-[var(--ui-code-subheader-bg)] border-b border-[color:var(--ui-divider-hairline)] text-[10.5px] font-mono text-[var(--ui-text-muted)] select-none'>
          <div className='px-3 py-1 border-r border-[color:var(--ui-divider-hairline)] flex items-center justify-between'>
            <span>{isNewFile ? '变更前（新建文件，原内容为空）' : '变更前 (Original)'}</span>
            {removedCount > 0 && <span className='text-[var(--ui-accent-rose)]'>-{removedCount} 行</span>}
          </div>
          <div className='px-3 py-1 flex items-center justify-between'>
            <span>变更后 (Modified)</span>
            {addedCount > 0 && <span className='text-[var(--ui-accent-emerald)]'>+{addedCount} 行</span>}
          </div>
        </div>

        {/* 左右同步滚动 Diff 主体 */}
        <div
          style={maxBodyHeightPx ? { maxHeight: `${maxBodyHeightPx}px` } : undefined}
          className={`overflow-y-auto custom-scrollbar font-mono text-[11.5px] leading-[1.55] bg-[var(--ui-code-bg)] ${
            maxBodyHeightPx ? '' : maxHeightClass
          }`}
        >
          {rows.length === 0 ? (
            <div className='px-4 py-6 text-center text-xs text-[var(--ui-text-muted)]'>
              文件内容无差异或内容为空
            </div>
          ) : (
            rows.map((row, rIdx) => {
              if (row.kind === 'collapsed') {
                const isOpen = !!expandedCollapsedIds[row.id];
                if (isOpen) {
                  return (
                    <React.Fragment key={row.id}>
                      {row.rows.map((inner, innerIdx) => (
                        <div key={`${row.id}_${innerIdx}`} className='grid grid-cols-2'>
                          {renderCell(inner.left, 'left')}
                          {renderCell(inner.right, 'right')}
                        </div>
                      ))}
                    </React.Fragment>
                  );
                }

                return (
                  <button
                    key={row.id}
                    type='button'
                    onClick={() => toggleExpandChunk(row.id)}
                    className='w-full py-1 px-3 bg-[var(--ui-code-subheader-bg)] hover:bg-[var(--ui-block-hover-bg)] border-y border-[color:var(--ui-divider-hairline)] text-[10.5px] text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] text-center transition-colors select-none'
                  >
                    ··· 展开中间 {row.hiddenCount} 行未变更代码 ···
                  </button>
                );
              }

              return (
                <div key={rIdx} className='grid grid-cols-2'>
                  {renderCell(row.left, 'left')}
                  {renderCell(row.right, 'right')}
                </div>
              );
            })
          )}
        </div>
      </div>
    );
  }
);

/**
 * Mermaid 架构图/流程图渲染组件（基于官方 mermaid 库）
 */
const MermaidBlock: React.FC<{ code: string }> = memo(({ code }) => {
  const uniqueId = useId().replace(/:/g, '_');
  const effectiveTheme = useEffectiveTheme();
  const [svgHtml, setSvgHtml] = useState<string>('');
  const [renderError, setRenderError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'preview' | 'code'>('preview');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const trimmed = code.trim();
    if (!trimmed) return;

    const timer = setTimeout(async () => {
      try {
        const { default: mermaid } = await import('mermaid');
        if (cancelled) return;
        mermaid.initialize({
          startOnLoad: false,
          theme: effectiveTheme === 'light' ? 'default' : 'dark',
          securityLevel: 'strict',
          fontFamily: 'Inter, system-ui, sans-serif',
        });
        const { svg } = await mermaid.render(`mermaid_${uniqueId}_${Date.now()}`, trimmed);
        if (!cancelled) {
          setSvgHtml(svg);
          setRenderError(null);
        }
      } catch (err: any) {
        if (!cancelled) {
          setRenderError(err?.message || '图表语法解析中...');
        }
      }
    }, 180);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code, uniqueId, effectiveTheme]);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className='my-3 rounded-xl overflow-hidden border border-[color:var(--ui-border-hairline)] bg-[var(--ui-code-bg)]'>
      <div className='px-3.5 py-1.5 bg-[var(--ui-code-header-bg)] border-b border-[color:var(--ui-divider-hairline)] flex items-center justify-between text-xs select-none'>
        <div className='flex items-center gap-2'>
          <Sparkles size={13} className='text-[var(--ui-accent-purple)]' />
          <span className='font-mono text-[11px] font-semibold text-[var(--ui-text-primary)]'>Mermaid 图表</span>
        </div>
        <div className='flex items-center gap-1.5'>
          <div className='flex items-center bg-[var(--ui-code-bg)] p-0.5 rounded-lg border border-[color:var(--ui-border-hairline)]'>
            <button
              onClick={() => setViewMode('preview')}
              className={`flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] transition-colors ${
                viewMode === 'preview'
                  ? 'bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)] font-medium'
                  : 'text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)]'
              }`}
            >
              <Eye size={11} />
              <span>图表</span>
            </button>
            <button
              onClick={() => setViewMode('code')}
              className={`flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] transition-colors ${
                viewMode === 'code'
                  ? 'bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)] font-medium'
                  : 'text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)]'
              }`}
            >
              <Code2 size={11} />
              <span>源码</span>
            </button>
          </div>
          <button
            onClick={handleCopy}
            className='flex items-center gap-1 px-2 py-0.5 rounded hover:bg-[var(--ui-chip-hover-bg)] text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] transition-colors text-[11px]'
          >
            {copied ? <Check size={12} className='text-[var(--ui-accent-emerald)]' /> : <Copy size={12} />}
            <span>{copied ? '已复制' : '复制'}</span>
          </button>
        </div>
      </div>

      {viewMode === 'preview' && svgHtml && !renderError ? (
        <div className='p-2 bg-[var(--ui-code-bg)] overflow-hidden'>
          <iframe
            title='Mermaid 图表预览'
            sandbox=''
            srcDoc={buildArtifactSrcDoc(svgHtml)}
            className='w-full h-[360px] border-0 bg-transparent'
          />
        </div>
      ) : (
        <pre className='p-3.5 text-xs font-mono text-[var(--ui-text-secondary)] overflow-x-auto bg-[var(--ui-code-bg)] m-0'>
          {code}
        </pre>
      )}
    </div>
  );
});

/**
 * 多态代码块主组件（支持语法高亮、Diff、Mermaid、SVG/HTML 制品预览）
 */
export interface CodeBlockProps {
  language?: string;
  value: string;
  filePath?: string;
}

export const CodeBlock: React.FC<CodeBlockProps> = memo(({ language = '', value, filePath }) => {
  const effectiveTheme = useEffectiveTheme();
  const [copied, setCopied] = useState(false);
  const [wrapLongLines, setWrapLongLines] = useState(false);
  const [showLineNumbers, setShowLineNumbers] = useState(true);
  const [previewTab, setPreviewTab] = useState<'code' | 'preview'>('code');

  const rawLang = language.toLowerCase().trim();
  const [cleanLang, inlinePath] = rawLang.includes(':') ? rawLang.split(':', 2) : [rawLang, ''];
  const effectivePath = filePath || inlinePath || '';

  const lineCount = value ? value.split('\n').length : 0;

  if (cleanLang === 'mermaid') {
    return <MermaidBlock code={value} />;
  }

  if (cleanLang === 'diff' || cleanLang === 'patch') {
    return <DiffViewer rawPatch={value} filePath={effectivePath || undefined} />;
  }

  const isPreviewableArtifact =
    (cleanLang === 'svg' || (cleanLang === 'xml' && value.trim().startsWith('<svg'))) &&
    value.includes('</svg>');

  const artifactSrcDoc = useMemo(
    () => (isPreviewableArtifact ? buildArtifactSrcDoc(value) : ''),
    [isPreviewableArtifact, value]
  );

  const handleCopy = () => {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const isShell = ['bash', 'sh', 'zsh', 'shell', 'console', 'terminal'].includes(cleanLang);

  return (
    <div className='my-2.5 rounded-xl overflow-hidden border border-[color:var(--ui-border-hairline)] bg-[var(--ui-code-bg)] group/code'>
      {/* 顶部工具栏 */}
      <div className='px-3.5 py-1.5 bg-[var(--ui-code-header-bg)] border-b border-[color:var(--ui-divider-hairline)] flex items-center justify-between text-xs select-none'>
        <div className='flex items-center gap-2 min-w-0'>
          {isShell ? (
            <Terminal size={13} className='text-[var(--ui-accent-emerald)] flex-shrink-0' />
          ) : (
            <FileCode size={13} className='text-[var(--ui-accent-blue)] flex-shrink-0' />
          )}
          <span className='font-mono text-[11px] font-semibold text-[var(--ui-text-secondary)] uppercase tracking-wide'>
            {cleanLang || 'text'}
          </span>
          {effectivePath && (
            <button
              onClick={() => window.electronAPI?.showInFolder?.(effectivePath)}
              className='text-[11px] font-mono text-[var(--ui-accent-blue)] hover:underline truncate max-w-[260px]'
              title='点击在 Finder 中定位'
            >
              {effectivePath}
            </button>
          )}
          <span className='text-[10px] text-[var(--ui-text-faint)] font-mono'>({lineCount} 行)</span>
        </div>

        <div className='flex items-center gap-1'>
          {isPreviewableArtifact && (
            <div className='flex items-center bg-[var(--ui-code-bg)] p-0.5 rounded-lg border border-[color:var(--ui-border-hairline)] mr-1'>
              <button
                onClick={() => setPreviewTab('preview')}
                className={`px-2 py-0.5 rounded text-[10px] ${
                  previewTab === 'preview'
                    ? 'bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)]'
                    : 'text-[var(--ui-text-muted)]'
                }`}
              >
                预览
              </button>
              <button
                onClick={() => setPreviewTab('code')}
                className={`px-2 py-0.5 rounded text-[10px] ${
                  previewTab === 'code'
                    ? 'bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)]'
                    : 'text-[var(--ui-text-muted)]'
                }`}
              >
                源码
              </button>
            </div>
          )}

          {lineCount > 1 && (
            <button
              onClick={() => setShowLineNumbers((v) => !v)}
              className={`p-1 rounded hover:bg-[var(--ui-chip-hover-bg)] transition-colors ${
                showLineNumbers
                  ? 'text-[var(--ui-accent-blue)]'
                  : 'text-[var(--ui-text-faint)] hover:text-[var(--ui-text-secondary)]'
              }`}
              title='切换行号显示'
            >
              <Hash size={12} />
            </button>
          )}

          <button
            onClick={() => setWrapLongLines((v) => !v)}
            className={`p-1 rounded hover:bg-[var(--ui-chip-hover-bg)] transition-colors ${
              wrapLongLines
                ? 'text-[var(--ui-accent-blue)]'
                : 'text-[var(--ui-text-faint)] hover:text-[var(--ui-text-secondary)]'
            }`}
            title='切换自动换行'
          >
            <WrapText size={12} />
          </button>

          <button
            onClick={handleCopy}
            className='flex items-center gap-1 px-2 py-0.5 rounded hover:bg-[var(--ui-chip-hover-bg)] text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] transition-colors text-[11px]'
            title='复制代码'
          >
            {copied ? <Check size={12} className='text-[var(--ui-accent-emerald)]' /> : <Copy size={12} />}
            <span>{copied ? '已复制' : '复制'}</span>
          </button>
        </div>
      </div>

      {/* 内容区 */}
      {isPreviewableArtifact && previewTab === 'preview' ? (
        <div className='p-2 bg-[var(--ui-code-bg)] overflow-hidden'>
          <iframe
            title='制品预览'
            sandbox=''
            srcDoc={artifactSrcDoc}
            className='w-full h-[360px] border-0 bg-transparent'
          />
        </div>
      ) : (
        <div className='text-[12.5px] leading-[1.6] overflow-x-auto custom-scrollbar'>
          <SyntaxHighlighter
            language={cleanLang || 'text'}
            style={effectiveTheme === 'light' ? cleanOneLight : cleanOneDark}
            showLineNumbers={showLineNumbers && lineCount > 1 && !isShell}
            wrapLongLines={wrapLongLines}
            codeTagProps={{
              style: {
                background: 'transparent',
                backgroundColor: 'transparent',
                padding: 0,
                border: 'none',
              },
            }}
            lineProps={{
              style: {
                background: 'transparent',
                backgroundColor: 'transparent',
              },
            }}
            customStyle={{
              margin: 0,
              padding: '0.85rem 1rem',
              background: 'transparent',
              backgroundColor: 'transparent',
              fontSize: '12.5px',
              lineHeight: '1.6',
            }}
            lineNumberStyle={{
              minWidth: '2.25em',
              paddingRight: '1em',
              color: 'var(--ui-text-faint)',
              userSelect: 'none',
            }}
          >
            {value}
          </SyntaxHighlighter>
        </div>
      )}
    </div>
  );
});

export default CodeBlock;
