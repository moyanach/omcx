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
      scoredFiles.push({
        item: {
          id: `file:${file.path}`,
          category: "file",
          title: file.path.split("/").filter(Boolean).pop() || file.path,
          subtitle: file.path.split("/").slice(0, -1).join("/"),
          insertText: `@${file.path}${file.isDir ? "/" : " "}`,
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
