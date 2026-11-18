export interface FileIndexEntry {
  path: string;
  isDir: boolean;
}

export type MentionCategory = "file" | "skill" | "mcp" | "subagent";

export interface UnifiedMentionItem {
  id: string;
  category: MentionCategory;
  title: string;
  subtitle?: string;
  insertText: string;
  filePath?: string;
  isDir?: boolean;
  scope?: "project" | "global" | "builtin";
  tools?: string[];
}

export interface WorkspaceFileIndex {
  files: FileIndexEntry[];
  source?: string;
  truncated?: boolean;
}

const CACHE_TTL = 30000;
const indexCache = new Map<string, { at: number; data: WorkspaceFileIndex }>();

export async function loadWorkspaceFileIndex(workDir?: string | null): Promise<WorkspaceFileIndex> {
  if (!workDir) return { files: [] };

  const cached = indexCache.get(workDir);
  if (cached && Date.now() - cached.at < CACHE_TTL) {
    return cached.data;
  }

  const api = (window as any).electronAPI;
  if (!api?.getWorkspaceFileIndex) return { files: [] };

  const data: WorkspaceFileIndex = (await api.getWorkspaceFileIndex(workDir)) || { files: [] };
  indexCache.set(workDir, { at: Date.now(), data });
  return data;
}

export function invalidateFileIndex(workDir?: string | null) {
  if (workDir) indexCache.delete(workDir);
  else indexCache.clear();
}

export function fuzzyScore(query: string, target: string): number {
  if (!query) return 1;

  const q = query.toLowerCase();
  const t = target.toLowerCase();
  const baseStart = t.lastIndexOf('/') + 1;
  const base = t.slice(baseStart);

  let score = 0;
  if (base === q) score += 120;
  else if (base.startsWith(q)) score += 80;
  else if (base.includes(q)) score += 50;
  else if (t.includes(q)) score += 25;

  let cursor = 0;
  let consecutive = 0;

  for (const ch of q) {
    const idx = t.indexOf(ch, cursor);
    if (idx === -1) return -1;

    score += 2;
    if (idx === cursor) {
      consecutive += 1;
      score += consecutive * 2;
    } else {
      consecutive = 0;
    }

    if (idx === 0 || idx === baseStart) {
      score += 12;
    } else {
      const prev = t[idx - 1];
      if (prev === '/' || prev === '-' || prev === '_' || prev === '.' || prev === ' ') {
        score += 6;
      }
    }

    cursor = idx + 1;
  }

  return score - t.length * 0.01;
}

export function filterMentions(
  entries: FileIndexEntry[],
  query: string,
  limit = 8,
): FileIndexEntry[] {
  if (!entries.length) return [];

  const q = query.trim();

  if (!q) {
    return entries
      .slice()
      .sort((a, b) => {
        const depthDiff = a.path.split('/').length - b.path.split('/').length;
        return depthDiff !== 0 ? depthDiff : a.path.localeCompare(b.path);
      })
      .slice(0, limit);
  }

  const dirPrefix = q.endsWith('/') ? q : null;
  const scored: Array<{ entry: FileIndexEntry; score: number }> = [];

  for (const entry of entries) {
    if (dirPrefix && !entry.path.startsWith(dirPrefix)) continue;
    const score = fuzzyScore(q, entry.path);
    if (score < 0) continue;
    scored.push({ entry, score });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.entry.path.length - b.entry.path.length;
  });

  return scored.slice(0, limit).map((item) => item.entry);
}

export function filterUnifiedMentions(
  query: string,
  files: FileIndexEntry[],
  skills: Array<{ id?: string; name: string; description?: string; scope?: string; tools?: string[] }> = [],
  mcps: Array<{ id?: string; name: string; description?: string; command?: string }> = [],
  subagents: Array<{ id: string; name: string; description?: string; scope?: string; readOnly?: boolean }> = [],
  limit = 12
): {
  items: UnifiedMentionItem[];
  grouped: {
    subagents: UnifiedMentionItem[];
    skills: UnifiedMentionItem[];
    mcps: UnifiedMentionItem[];
    files: UnifiedMentionItem[];
  };
} {
  const q = query.trim();
  const lowerQ = q.toLowerCase();

  const isSkillPrefix = lowerQ.startsWith("skill:");
  const isMcpPrefix = lowerQ.startsWith("mcp:");
  const isAgentPrefix = lowerQ.startsWith("agent:");

  const skillFilterTerm = isSkillPrefix ? q.slice(6).trim() : q;
  const mcpFilterTerm = isMcpPrefix ? q.slice(4).trim() : q;
  const agentFilterTerm = isAgentPrefix ? q.slice(6).trim() : q;

  // 0. 过滤与排序 Subagents
  const scoredSubagents: Array<{ item: UnifiedMentionItem; score: number }> = [];
  if (!isSkillPrefix && !isMcpPrefix) {
    for (const agent of subagents) {
      const id = agent.id || "";
      const name = agent.name || id;
      const desc = agent.description || "";
      let score = 0;
      if (!agentFilterTerm) {
        score = 10;
      } else {
        const idScore = fuzzyScore(agentFilterTerm, id);
        const nameScore = fuzzyScore(agentFilterTerm, name);
        const descScore = desc ? fuzzyScore(agentFilterTerm, desc) - 15 : -1;
        score = Math.max(idScore, nameScore, descScore);
        if (isAgentPrefix && id.toLowerCase().startsWith(agentFilterTerm.toLowerCase())) {
          score += 50;
        }
      }
      if (score >= 0) {
        scoredSubagents.push({
          item: {
            id: `subagent:${id}`,
            category: "subagent",
            title: name,
            subtitle: desc,
            insertText: `@agent:${id} `,
            scope: (agent.scope as any) || "builtin",
          },
          score,
        });
      }
    }
  }
  scoredSubagents.sort((a, b) => b.score - a.score);

  // 1. 过滤与排序 Skills
  const scoredSkills: Array<{ item: UnifiedMentionItem; score: number }> = [];
  if (!isMcpPrefix && !isAgentPrefix) {
    for (const skill of skills) {
      const name = skill.name || "";
      const desc = skill.description || "";
      let score = 0;
      if (!skillFilterTerm) {
        score = 10;
      } else {
        const nameScore = fuzzyScore(skillFilterTerm, name);
        const descScore = desc ? fuzzyScore(skillFilterTerm, desc) - 15 : -1;
        score = Math.max(nameScore, descScore);
        if (isSkillPrefix && name.toLowerCase().startsWith(skillFilterTerm.toLowerCase())) {
          score += 50;
        }
      }
      if (score >= 0) {
        scoredSkills.push({
          item: {
            id: `skill:${name}`,
            category: "skill",
            title: name,
            subtitle: desc,
            insertText: `@skill:${name} `,
            scope: (skill.scope as any) || "global",
            tools: skill.tools,
          },
          score,
        });
      }
    }
  }
  scoredSkills.sort((a, b) => b.score - a.score);

  // 2. 过滤与排序 MCP Servers
  const scoredMcps: Array<{ item: UnifiedMentionItem; score: number }> = [];
  if (!isSkillPrefix && !isAgentPrefix) {
    for (const mcp of mcps) {
      const name = mcp.name || "";
      const desc = mcp.description || mcp.command || "";
      let score = 0;
      if (!mcpFilterTerm) {
        score = 10;
      } else {
        const nameScore = fuzzyScore(mcpFilterTerm, name);
        const descScore = desc ? fuzzyScore(mcpFilterTerm, desc) - 15 : -1;
        score = Math.max(nameScore, descScore);
        if (isMcpPrefix && name.toLowerCase().startsWith(mcpFilterTerm.toLowerCase())) {
          score += 50;
        }
      }
      if (score >= 0) {
        scoredMcps.push({
          item: {
            id: `mcp:${name}`,
            category: "mcp",
            title: name,
            subtitle: desc,
            insertText: `@mcp:${name} `,
          },
          score,
        });
      }
    }
  }
  scoredMcps.sort((a, b) => b.score - a.score);

  // 3. 过滤与排序 Files & Dirs
  const scoredFiles: Array<{ item: UnifiedMentionItem; score: number }> = [];
  if (!isSkillPrefix && !isMcpPrefix && !isAgentPrefix) {
    const matchedFiles = filterMentions(files, q, 10);
    matchedFiles.forEach((file) => {
      const cleanPath = file.path.replace(/\/+$/, "");
      const baseName = cleanPath.split("/").filter(Boolean).pop() || cleanPath;
      const fullTargetPath = file.isDir ? `${cleanPath}/` : cleanPath;
      const shortToken = file.isDir ? `${baseName}/` : `${baseName} `;
      scoredFiles.push({
        item: {
          id: `file:${file.path}`,
          category: "file",
          title: baseName,
          subtitle: cleanPath.split("/").slice(0, -1).join("/"),
          insertText: `@${shortToken}`,
          filePath: fullTargetPath,
          isDir: file.isDir,
        },
        score: 1,
      });
    });
  }

  // 分组与配额截断 (默认展示时均衡配比)
  let subagentItems = scoredSubagents.map((s) => s.item);
  let skillItems = scoredSkills.map((s) => s.item);
  let mcpItems = scoredMcps.map((m) => m.item);
  let fileItems = scoredFiles.map((f) => f.item);

  if (!q) {
    subagentItems = subagentItems.slice(0, 4);
    skillItems = skillItems.slice(0, 3);
    mcpItems = mcpItems.slice(0, 2);
    fileItems = fileItems.slice(0, 5);
  } else if (isAgentPrefix) {
    subagentItems = subagentItems.slice(0, limit);
    skillItems = [];
    mcpItems = [];
    fileItems = [];
  } else if (isSkillPrefix) {
    skillItems = skillItems.slice(0, limit);
    subagentItems = [];
    mcpItems = [];
    fileItems = [];
  } else if (isMcpPrefix) {
    mcpItems = mcpItems.slice(0, limit);
    subagentItems = [];
    skillItems = [];
    fileItems = [];
  } else {
    // 综合搜索模式：高分混合截取
    subagentItems = subagentItems.slice(0, 3);
    skillItems = skillItems.slice(0, 3);
    mcpItems = mcpItems.slice(0, 2);
    fileItems = fileItems.slice(0, 6);
  }

  const items = [...subagentItems, ...skillItems, ...mcpItems, ...fileItems];

  return {
    items,
    grouped: {
      subagents: subagentItems,
      skills: skillItems,
      mcps: mcpItems,
      files: fileItems,
    },
  };
}

const MIRROR_PROPS = [
  'box-sizing',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'font-variant',
  'font-stretch',
  'line-height',
  'letter-spacing',
  'word-spacing',
  'text-align',
  'text-transform',
  'text-indent',
  'tab-size',
  'white-space',
  'word-break',
  'overflow-wrap',
];

export function getCaretCoordinates(
  textarea: HTMLTextAreaElement,
  position: number,
): { top: number; left: number } {
  const computed = window.getComputedStyle(textarea);
  const mirror = document.createElement('div');

  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.top = '0';
  mirror.style.left = '-9999px';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.overflow = 'hidden';

  for (const prop of MIRROR_PROPS) {
    mirror.style.setProperty(prop, computed.getPropertyValue(prop));
  }

  mirror.style.width = `${textarea.clientWidth}px`;

  const text = textarea.value;
  mirror.textContent = text.substring(0, position);

  const marker = document.createElement('span');
  marker.textContent = text.substring(position) || '.';
  mirror.appendChild(marker);

  document.body.appendChild(mirror);

  const borderTop = parseFloat(computed.borderTopWidth) || 0;
  const borderLeft = parseFloat(computed.borderLeftWidth) || 0;
  const top = marker.offsetTop + borderTop - textarea.scrollTop;
  const left = marker.offsetLeft + borderLeft - textarea.scrollLeft;

  document.body.removeChild(mirror);

  return { top, left };
}

const MENTION_TOKEN_PATTERN = /(^|[\s(（[【"'`\u4e00-\u9fa5])@([^\s@`"'<>|]+)/g;
const MENTION_TRAILING_PUNCTUATION = /[.,;:!?)\]}>，。；：！？、】》」』…]+$/;

export type MentionTextSegment =
  | { type: 'text'; value: string }
  | { type: 'mention'; raw: string; token: string };

/**
 * 将文本切分为普通文本与 `@token` 引用片段，保持字符索引严格无损。
 */
export function tokenizeTextWithMentions(text: string): MentionTextSegment[] {
  if (!text) return [];
  const segments: MentionTextSegment[] = [];
  const pattern = new RegExp(MENTION_TOKEN_PATTERN.source, 'g');
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const prefix = match[1] || '';
    const rawToken = match[2] || '';
    const punctMatch = rawToken.match(MENTION_TRAILING_PUNCTUATION);
    const punct = punctMatch ? punctMatch[0] : '';
    const cleanToken = punct ? rawToken.slice(0, -punct.length) : rawToken;
    const tokenStart = match.index + prefix.length;

    if (!cleanToken) continue;

    if (tokenStart > cursor) {
      segments.push({ type: 'text', value: text.slice(cursor, tokenStart) });
    }

    const mentionRaw = `@${cleanToken}`;
    segments.push({ type: 'mention', raw: mentionRaw, token: cleanToken });
    cursor = tokenStart + mentionRaw.length;
  }

  if (cursor < text.length) {
    segments.push({ type: 'text', value: text.slice(cursor) });
  }

  return segments;
}

/**
 * 为文件/目录生成简短的展示 Token（默认仅文件名；若同一输入中存在同名冲突则附带最少父目录前缀消歧）。
 */
export function getShortFileMentionToken(
  fullPath: string,
  isDir: boolean,
  existingMap: Record<string, string> = {},
): string {
  const normalized = fullPath.replace(/\/+$/, '').replace(/^\.\//, '');
  const fullWithSlash = isDir ? `${normalized}/` : normalized;
  const parts = normalized.split('/').filter(Boolean);

  for (let depth = 1; depth <= parts.length; depth += 1) {
    const candidate = parts.slice(-depth).join('/');
    const key = isDir ? `${candidate}/` : candidate;
    const existing = existingMap[key];
    if (!existing || existing === fullWithSlash) {
      return key;
    }
  }

  return fullWithSlash;
}

function isSpecialMentionPrefix(token: string): boolean {
  return (
    token.startsWith('skill:') ||
    token.startsWith('mcp:') ||
    token.startsWith('agent:')
  );
}

/**
 * 识别文本中的 `@token` 是否指向有效的文件或目录（返回展示用文件名 basename 与完整路径）。
 */
export function findMatchedFileMention(
  token: string,
  mentionMap: Record<string, string> = {},
  workspaceFiles?: FileIndexEntry[],
): { displayName: string; fullPath: string; isDir: boolean } | null {
  const clean = token.replace(MENTION_TRAILING_PUNCTUATION, '');
  if (!clean || isSpecialMentionPrefix(clean) || clean === '.' || clean === '..') {
    return null;
  }

  const mapped = mentionMap[clean] || (!clean.endsWith('/') ? mentionMap[`${clean}/`] : undefined);
  if (mapped) {
    const isDir = mapped.endsWith('/');
    const stripped = mapped.replace(/\/+$/, '');
    const displayName = stripped.split('/').filter(Boolean).pop() || clean;
    return {
      displayName: isDir ? `${displayName}/` : displayName,
      fullPath: mapped,
      isDir,
    };
  }

  if (workspaceFiles && workspaceFiles.length > 0) {
    const normClean = clean.replace(/\/+$/, '').replace(/^\.\//, '');
    if (!normClean) return null;

    const exact = workspaceFiles.find((entry) => entry.path.replace(/\/+$/, '') === normClean);
    const suffixMatches = exact
      ? [exact]
      : workspaceFiles.filter((entry) => {
          const p = entry.path.replace(/\/+$/, '');
          return p === normClean || p.endsWith(`/${normClean}`);
        });

    if (suffixMatches.length > 0) {
      const matched = suffixMatches[0];
      const isDir = Boolean(matched.isDir || clean.endsWith('/'));
      const stripped = matched.path.replace(/\/+$/, '');
      const fullPath = isDir ? `${stripped}/` : stripped;
      const displayName = stripped.split('/').filter(Boolean).pop() || clean;
      return {
        displayName: isDir ? `${displayName}/` : displayName,
        fullPath,
        isDir,
      };
    }
  }

  return null;
}

/**
 * 发送前将输入框中的短文件 Token（如 `@MessageInput.tsx`）无损还原为完整工作区相对路径。
 */
export function resolveFileMentionsInText(
  text: string,
  mentionMap: Record<string, string> = {},
  workspaceFiles?: FileIndexEntry[],
): string {
  if (!text || !text.includes('@')) return text;

  return text.replace(MENTION_TOKEN_PATTERN, (full, prefix: string, rawToken: string) => {
    const punctMatch = rawToken.match(MENTION_TRAILING_PUNCTUATION);
    const punct = punctMatch ? punctMatch[0] : '';
    const clean = punct ? rawToken.slice(0, -punct.length) : rawToken;

    if (!clean || isSpecialMentionPrefix(clean)) return full;

    const mapped = mentionMap[clean] || (!clean.endsWith('/') ? mentionMap[`${clean}/`] : undefined);
    if (mapped) {
      return `${prefix}@${mapped}${punct}`;
    }

    if (workspaceFiles && workspaceFiles.length > 0) {
      const normClean = clean.replace(/\/+$/, '').replace(/^\.\//, '');
      const exact = workspaceFiles.find((entry) => entry.path.replace(/\/+$/, '') === normClean);
      if (exact) {
        const target = exact.isDir ? `${exact.path.replace(/\/+$/, '')}/` : exact.path;
        return `${prefix}@${target}${punct}`;
      }
      const suffix = workspaceFiles.find((entry) =>
        entry.path.replace(/\/+$/, '').endsWith(`/${normClean}`)
      );
      if (suffix) {
        const target = suffix.isDir ? `${suffix.path.replace(/\/+$/, '')}/` : suffix.path;
        return `${prefix}@${target}${punct}`;
      }
    }

    return full;
  });
}

/**
 * 将完整路径文本（如从文件树插入的 `@src/pages/ChatView.tsx`）紧凑化为短文件名 Token 并写入映射表。
 */
export function compactFileMentionsInText(
  text: string,
  workspaceFiles?: FileIndexEntry[],
  existingMap: Record<string, string> = {},
): { text: string; mentionMap: Record<string, string> } {
  if (!text || !text.includes('@')) {
    return { text, mentionMap: { ...existingMap } };
  }

  const nextMap: Record<string, string> = { ...existingMap };
  const compacted = text.replace(MENTION_TOKEN_PATTERN, (full, prefix: string, rawToken: string) => {
    const punctMatch = rawToken.match(MENTION_TRAILING_PUNCTUATION);
    const punct = punctMatch ? punctMatch[0] : '';
    const clean = punct ? rawToken.slice(0, -punct.length) : rawToken;

    if (!clean || isSpecialMentionPrefix(clean) || !clean.includes('/')) {
      return full;
    }

    const isDir = clean.endsWith('/');
    const normClean = clean.replace(/\/+$/, '').replace(/^\.\//, '');
    const matched = workspaceFiles?.find((entry) => entry.path.replace(/\/+$/, '') === normClean);
    const actualIsDir = matched ? Boolean(matched.isDir) : isDir;
    const fullTarget = actualIsDir ? `${normClean}/` : normClean;
    const shortToken = getShortFileMentionToken(normClean, actualIsDir, nextMap);
    nextMap[shortToken] = fullTarget;

    return `${prefix}@${shortToken}${punct}`;
  });

  return { text: compacted, mentionMap: nextMap };
}
