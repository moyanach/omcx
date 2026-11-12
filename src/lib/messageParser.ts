export interface ParsedMessageResult {
  thinkingBlocks: string[];
  isThinkingStreaming: boolean;
  markdownContent: string;
}

/**
 * v2.1.9+：思考内容已通过独立通道传输与存储，正文不再内嵌  thinking 标签。
 * 本函数仅保留最小的正文清理与围栏自愈职责，不再解析任何思考标签，
 * 从根源上杜绝正文里出现字面量思考标签时被误吞的问题。
 */
export function parseMessageContent(raw: string): ParsedMessageResult {
  const text = String(raw || '');
  // 仅过滤网关在异常收尾时可能残留的伪造占位词
  const cleaned = text.replace(/^\s*task ready\s*$/gim, '').trim();
  return {
    thinkingBlocks: [],
    isThinkingStreaming: false,
    markdownContent: healStreamingMarkdown(cleaned),
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
