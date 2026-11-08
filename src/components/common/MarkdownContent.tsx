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
import { parseMessageContent, parseFileReference } from '@/lib/messageParser';
import CodeBlock from './CodeBlock';
import { useChatStore } from '@/stores/chatStore';

interface Props {
  content: string;
  className?: string;
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
  const [isOpen, setIsOpen] = useState(true);

  if (thoughts.length === 0) return null;
  const combinedThought = thoughts.join('\n\n');

  return (
    <div
      className={`${className} w-full rounded-xl border border-[color:var(--ui-border-hairline)] hover:border-[color:var(--ui-border-subtle)] bg-[var(--ui-block-bg)] overflow-hidden select-none transition-colors`}
    >
      <div
        onClick={() => setIsOpen((v) => !v)}
        className='px-3.5 py-2 flex items-center justify-between cursor-pointer hover:bg-[var(--ui-block-hover-bg)] transition-colors'
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
            ({combinedThought.length} 字)
          </span>
        </div>
        <div className='flex items-center gap-1 text-[11px] text-[var(--ui-text-faint)] font-mono'>
          <span>{isOpen ? '收起' : '展开'}</span>
          {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </div>
      </div>

      {isOpen && (
        <div className='px-3.5 py-2.5 border-t border-[color:var(--ui-divider-hairline)] bg-[var(--ui-block-body-bg)] text-xs text-[var(--ui-text-muted)] leading-relaxed whitespace-pre-wrap font-sans max-h-64 overflow-y-auto custom-scrollbar'>
          {combinedThought}
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
      useChatStore.getState().openFileInWorkbench(filePath, { line: lineStart });
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
      title={`点击在右侧工作台打开 ${filePath}${lineStart ? ` 并跳转到第 ${lineStart} 行` : ''}（按住 ⌘ 点击可在 Finder 中定位）`}
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

export const MarkdownContent: React.FC<Props> = memo(({ content, className = '', hideThinking = false }) => {
  const { thinkingBlocks, isThinkingStreaming, markdownContent } = useMemo(
    () => parseMessageContent(content),
    [content]
  );

  return (
    <div className={`markdown-body ${className} text-[var(--ui-text-secondary)]`}>
      {!hideThinking && thinkingBlocks.length > 0 && (
        <ThinkingBlock thoughts={thinkingBlocks} isStreaming={isThinkingStreaming} />
      )}

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
