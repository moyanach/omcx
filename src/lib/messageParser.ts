export interface ParsedMessageResult {
  thinkingBlocks: string[];
  isThinkingStreaming: boolean;
  markdownContent: string;
}

/**
 * 提取深度思考块 (<think>...</think> / <thinking>...</thinking>) 并修复流式未闭合 Markdown 围栏
 */
export function parseMessageContent(raw: string): ParsedMessageResult {
  if (!raw) {
    return {
      thinkingBlocks: [],
      isThinkingStreaming: false,
      markdownContent: '',
    };
  }

  const thinkingBlocks: string[] = [];
  let isThinkingStreaming = false;
  let remaining = raw;

  // 1. 提取已闭合的 <think>...</think> 或 <thinking>...</thinking>
  const closedThinkRegex = /<(?:think|thinking)>([\s\S]*?)<\/(?:think|thinking)>/gi;
  remaining = remaining.replace(closedThinkRegex, (_, inner) => {
    const trimmed = String(inner || '').trim();
    if (trimmed) {
      thinkingBlocks.push(trimmed);
    }
    return '';
  });

  // 2. 检测流式过程中尚未闭合的 <think> 或 <thinking>
  const unclosedMatch = remaining.match(/<(?:think|thinking)>([\s\S]*)$/i);
  if (unclosedMatch && unclosedMatch.index !== undefined) {
    const partialThought = unclosedMatch[1].trim();
    if (partialThought) {
      thinkingBlocks.push(partialThought);
    }
    isThinkingStreaming = true;
    remaining = remaining.slice(0, unclosedMatch.index);
  }

  // 过滤网关在截断降级时可能残留的伪造占位词 "task ready"
  const cleanedRemaining = remaining.replace(/^\s*task ready\s*$/gim, '').trim();
  const healedMarkdown = healStreamingMarkdown(cleanedRemaining);

  return {
    thinkingBlocks,
    isThinkingStreaming,
    markdownContent: healedMarkdown,
  };
}

/**
 * 流式 Markdown 未闭合围栏自愈器：
 * 当模型流式吐出奇数个 ``` 代码围栏或 $$ 公式块时，自动在末尾补齐闭合标记，
 * 确保代码从流式输出的第一秒起就进入语法高亮容器，消除闪烁跳动。
 */
export function healStreamingMarkdown(markdown: string): string {
  if (!markdown) return '';

  const fenceMatches = markdown.match(/^```/gm);
  let healed = markdown;

  if (fenceMatches && fenceMatches.length % 2 === 1) {
    healed = `${healed}\n\`\`\``;
  }

  return healed;
}

export interface FileReferenceMatch {
  raw: string;
  filePath: string;
  lineStart?: number;
  lineEnd?: number;
}

const KNOWN_CODE_EXTS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'py', 'go', 'rs', 'java',
  'c', 'cpp', 'h', 'hpp', 'cs', 'rb', 'php', 'swift', 'kt', 'scala', 'sh',
  'bash', 'zsh', 'yaml', 'yml', 'toml', 'md', 'css', 'scss', 'less', 'html',
  'vue', 'svelte', 'sql', 'graphql', 'prisma', 'dockerfile', 'makefile'
]);

/**
 * 识别行内代码是否为工程文件路径或 `文件路径:行号` 引用
 */
export function parseFileReference(text: string): FileReferenceMatch | null {
  const clean = String(text || '').trim();
  if (!clean || clean.length > 180 || clean.includes(' ') || clean.includes('://')) {
    return null;
  }

  const match = clean.match(/^([a-zA-Z0-9_.\-/\\@]+?\.[a-zA-Z0-9]+)(?::(\d+)(?:-(\d+))?)?(?::\d+)?$/);
  if (!match) return null;

  const filePath = match[1];
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  if (!KNOWN_CODE_EXTS.has(ext)) {
    return null;
  }

  // 至少包含路径分隔符、常见顶层文件名或明确带有 :行号
  const hasSlash = filePath.includes('/') || filePath.includes('\\');
  const hasLine = Boolean(match[2]);
  if (!hasSlash && !hasLine && !['package.json', 'tsconfig.json', 'main.js', 'preload.js', 'vite.config.js', 'README.md', 'AGENTS.md'].includes(filePath)) {
    return null;
  }

  return {
    raw: clean,
    filePath,
    lineStart: match[2] ? parseInt(match[2], 10) : undefined,
    lineEnd: match[3] ? parseInt(match[3], 10) : undefined,
  };
}
