import React, { useState, useMemo, memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import {
  BrainCircuit,
  ChevronDown,
  ChevronRight,
  FileCode2,
  Loader2,
  Check,
} from 'lucide-react';
import { healStreamingMarkdown, parseFileReference } from '@/lib/messageParser';
import CodeBlock from './CodeBlock';
import { useChatStore } from '@/stores/chatStore';

interface Props {
  content: string;
  className?: string;
  // 兼容旧调用点；思考内容已独立渲染，不再由 MarkdownContent 解析
  hideThinking?: boolean;
}

/**
 * 深度思考可折叠卡片 (兼容 <think> 标签与 SSE reasoning_content)
 */
export const ThinkingBlock: React.FC<{
  thoughts: string[];
  isStreaming: boolean;
  className?: string;
}> = memo(({ thoughts, isStreaming, className = 'mb-1.5' }) => {
  // 历史消息默认折叠：避免一次挂载多个数万字思考块造成排版/DOM 风暴；
  // 仅正在流式生成的思考默认展开。
  const [isOpen, setIsOpen] = useState(isStreaming);
  const [showFullHistory, setShowFullHistory] = useState(false);

  if (thoughts.length === 0) return null;
  const combinedThought = thoughts.join('\n\n');
  const totalChars = combinedThought.length;

  // 超长思考排版性能保护：超过 12,000 字时，流式期间仅挂载末尾活跃区，避免十万级字符单一文本节点引发排版引擎重排风暴
  const THRESHOLD = 12000;
  const TAIL_CHARS = 8000;
  const isHuge = totalChars > THRESHOLD;
  const shouldTruncate = isHuge && !showFullHistory && isStreaming;

  const visibleText = shouldTruncate
    ? combinedThought.slice(-TAIL_CHARS)
    : combinedThought;
  const hiddenCount = shouldTruncate ? totalChars - TAIL_CHARS : 0;

  return (
    <div
      style={{ contain: 'content' }}
      className={`${className} w-full select-none`}
    >
      <div
        onClick={() => setIsOpen((v) => !v)}
        className='py-1 flex items-center justify-between cursor-pointer text-[var(--ui-text-muted)] hover:text-[var(--ui-text-secondary)] transition-colors'
      >
        <div className='flex items-center gap-2 text-xs'>
          {isStreaming ? (
            <Loader2 size={13} className='text-[var(--ui-accent-purple)] animate-spin' />
          ) : (
            <BrainCircuit size={13} className='text-[var(--ui-accent-purple)]' />
          )}
          <span className='font-medium text-[var(--ui-text-secondary)]'>
            {isStreaming ? '正在深度思考与推演...' : '已深度思考'}
          </span>
          <span className='text-[10px] font-mono text-[var(--ui-text-faint)]'>
            ({totalChars.toLocaleString()} 字)
          </span>
        </div>
        <div className='flex items-center gap-1 text-[11px] text-[var(--ui-text-faint)] font-mono'>
          <span>{isOpen ? '收起' : '展开'}</span>
          {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </div>
      </div>

      {isOpen && (
        <div
          style={{ contain: 'content' }}
          className='mt-1 ml-1 pl-3 pr-2 border-l border-[color:var(--ui-divider-hairline)] text-xs text-[var(--ui-text-muted)] leading-relaxed whitespace-pre-wrap font-sans max-h-64 overflow-y-auto custom-scrollbar flex flex-col gap-2'
        >
          {shouldTruncate && (
            <div className='sticky top-0 z-10 -mt-1 py-1 px-2.5 rounded-lg bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)] text-[11px] text-[var(--ui-text-faint)] flex items-center justify-between shadow-sm select-none'>
              <span>⚡️ 已动态折叠前序 {hiddenCount.toLocaleString()} 字早期推演（实时渲染末尾活跃区）</span>
              <button
                type='button'
                onClick={(e) => {
                  e.stopPropagation();
                  setShowFullHistory(true);
                }}
                className='text-[var(--ui-accent-blue)] hover:underline ml-2 flex-shrink-0 cursor-pointer'
              >
                查看完整
              </button>
            </div>
          )}
          <div>{visibleText}</div>
        </div>
      )}
    </div>
  );
});

/**
 * 历史思考块（按需拉取）：
 * 消息正文经 IPC 瘦身后不再携带数万字思考内容，展开时才向主进程请求原文。
 */
export const LazyThinkingBlock: React.FC<{
  messageId: string;
  chars: number;
  isStreaming?: boolean;
  className?: string;
}> = memo(({ messageId, chars, isStreaming = false, className = 'mb-1.5' }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleToggle = async () => {
    const nextOpen = !isOpen;
    setIsOpen(nextOpen);
    if (!nextOpen || text !== null || loading) return;
    setLoading(true);
    setError(null);
    try {
      const value = await (window as any).electronAPI?.dbGetMessageReasoning?.(messageId);
      setText(String(value || ''));
    } catch (err: any) {
      setError(err?.message || '思考内容加载失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      data-testid='lazy-thinking-block'
      style={{ contain: 'content' }}
      className={`${className} w-full select-none`}
    >
      <div
        data-testid='lazy-thinking-header'
        onClick={handleToggle}
        className='py-1 flex items-center justify-between cursor-pointer text-[var(--ui-text-muted)] hover:text-[var(--ui-text-secondary)] transition-colors'
      >
        <div className='flex items-center gap-2 text-xs'>
          {isStreaming ? (
            <Loader2 size={13} className='text-[var(--ui-accent-purple)] animate-spin' />
          ) : (
            <BrainCircuit size={13} className='text-[var(--ui-accent-purple)]' />
          )}
          <span className='font-medium text-[var(--ui-text-secondary)]'>
            {isStreaming ? '正在深度思考与推演...' : '已深度思考'}
          </span>
          <span className='text-[10px] font-mono text-[var(--ui-text-faint)]'>
            ({Number(chars || 0).toLocaleString()} 字)
          </span>
        </div>
        <div className='flex items-center gap-1 text-[11px] text-[var(--ui-text-faint)] font-mono'>
          <span>{isOpen ? '收起' : '展开'}</span>
          {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </div>
      </div>

      {isOpen && (
        <div
          style={{ contain: 'content' }}
          className='mt-1 ml-1 pl-3 pr-2 border-l border-[color:var(--ui-divider-hairline)] text-xs text-[var(--ui-text-muted)] leading-relaxed whitespace-pre-wrap font-sans max-h-64 overflow-y-auto custom-scrollbar'
        >
          {loading ? (
            <div className='flex items-center gap-1.5 text-[11px] text-[var(--ui-text-faint)]'>
              <Loader2 size={11} className='animate-spin' />
              正在加载思考内容…
            </div>
          ) : error ? (
            <div className='text-[11px] text-[var(--ui-accent-rose)]'>{error}</div>
          ) : (
            <div>{text || '（无思考内容）'}</div>
          )}
        </div>
      )}
    </div>
  );
});

/**
 * 行内 `文件路径:行号` 交互式胶囊组件
 */
const FileReferencePill: React.FC<{
  raw: string;
  filePath: string;
  lineStart?: number;
  lineEnd?: number;
}> = memo(({ raw, filePath, lineStart, lineEnd }) => {
  const [copied, setCopied] = useState(false);
  const activeSession = useChatStore((s) =>
    s.sessions.find((item) => item.id === s.activeSessionId)
  );

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const workDir = activeSession?.workDir;
    const isAbs = filePath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(filePath);
    const resolvedPath = isAbs
      ? filePath
      : workDir
      ? `${workDir.replace(/\/+$/, '')}/${filePath.replace(/^\.?\//, '')}`
      : filePath;

    // 按住 Cmd/Alt 点击时在 Finder 中打开，默认点击直接在右侧工作台打开文件并跳转到对应行号
    if ((e.metaKey || e.altKey) && window.electronAPI?.showInFolder && (isAbs || workDir)) {
      window.electronAPI.showInFolder(resolvedPath);
      return;
    }

    if (isAbs || workDir) {
      useChatStore.getState().openFileInWorkbench(filePath, { line: lineStart, lineEnd });
    } else {
      navigator.clipboard.writeText(raw);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <button
      type='button'
      onClick={handleClick}
      className='inline-flex items-center gap-1 px-1.5 py-0.5 mx-0.5 rounded-md bg-[var(--ui-accent-blue-soft)] hover:opacity-85 border border-[color:var(--ui-accent-blue-border)] text-[var(--ui-accent-blue)] font-mono text-[12px] leading-tight align-baseline transition-all cursor-pointer'
      title={`点击在右侧工作台打开 ${filePath}${lineStart ? ` 并定位至第 ${lineStart}${lineEnd ? `-${lineEnd}` : ''} 行` : ''}（按住 ⌘ 点击可在 Finder 中定位）`}
    >
      {copied ? (
        <Check size={11} className='text-[var(--ui-accent-emerald)] flex-shrink-0' />
      ) : (
        <FileCode2 size={11} className='text-[var(--ui-accent-blue)] flex-shrink-0' />
      )}
      <span>{filePath}</span>
      {lineStart !== undefined && (
        <span className='opacity-80 font-semibold'>
          :{lineStart}
          {lineEnd !== undefined ? `-${lineEnd}` : ''}
        </span>
      )}
    </button>
  );
});

const SANITIZE_SCHEMA = {
  ...defaultSchema,
  tagNames: Array.from(
    new Set([
      ...(defaultSchema.tagNames || []),
      'details',
      'summary',
      'kbd',
      'mark',
      'ins',
      'del',
      'sup',
      'sub',
    ])
  ),
  attributes: {
    ...defaultSchema.attributes,
    details: [...(defaultSchema.attributes?.details || []), 'open'],
    code: [...(defaultSchema.attributes?.code || []), 'className'],
    pre: [...(defaultSchema.attributes?.pre || []), 'className'],
    span: [...(defaultSchema.attributes?.span || []), 'className'],
    div: [...(defaultSchema.attributes?.div || []), 'className'],
  },
};

export const MarkdownContent: React.FC<Props> = memo(({ content, className = '' }) => {
  const markdownContent = useMemo(
    () => healStreamingMarkdown(String(content || '')),
    [content]
  );

  return (
    <div className={`markdown-body ${className} text-[var(--ui-text-secondary)]`}>
      {markdownContent && (
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[rehypeRaw, [rehypeSanitize, SANITIZE_SCHEMA], rehypeKatex]}
          components={{
            pre({ children }) {
              return <>{children}</>;
            },
            code({ className: codeClassName, children, ...props }) {
              const match = /language-([^\s]+)/.exec(codeClassName || '');
              const textValue = String(children ?? '').replace(/\n$/, '');
              const isMultiline = Boolean(match) || textValue.includes('\n');

              if (isMultiline) {
                return <CodeBlock language={match?.[1] || ''} value={textValue} />;
              }

              const fileRef = parseFileReference(textValue);
              if (fileRef) {
                return (
                  <FileReferencePill
                    raw={fileRef.raw}
                    filePath={fileRef.filePath}
                    lineStart={fileRef.lineStart}
                    lineEnd={fileRef.lineEnd}
                  />
                );
              }

              return (
                <code className={codeClassName} {...props}>
                  {children}
                </code>
              );
            },
            table({ children }) {
              return (
                <div className='my-3 w-full overflow-x-auto rounded-xl border border-[color:var(--ui-border-hairline)] custom-scrollbar'>
                  <table className='w-full border-collapse text-left text-xs'>{children}</table>
                </div>
              );
            },
            a({ href, children, ...props }) {
              return (
                <a
                  href={href}
                  target='_blank'
                  rel='noopener noreferrer'
                  className='text-[var(--md-link)] hover:text-[var(--md-link-hover)] underline underline-offset-2 transition-colors'
                  {...props}
                >
                  {children}
                </a>
              );
            },
          }}
        >
          {markdownContent}
        </ReactMarkdown>
      )}
    </div>
  );
});

export default MarkdownContent;
