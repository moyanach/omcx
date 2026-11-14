import React, { useState, useMemo } from 'react';
import Anser from 'anser';
import {
  CheckCircle2,
  XCircle,
  ChevronRight,
  ChevronDown,
  Globe,
  FileCode,
  FolderTree,
  Folder,
  ExternalLink,
  Terminal,
  Edit3,
  Search,
  Loader2,
  Sparkles,
} from 'lucide-react';
import CodeBlock, { DiffViewer } from '@/components/common/CodeBlock';
import { ToolStatusEvent } from './types';

export function getBaseName(p?: string) {
  if (!p || typeof p !== 'string') return '';
  return p.split(/[\\/]/).filter(Boolean).pop() || p;
}

/**
 * 提取工具调用的自然语言关键语义
 */
export function getToolStepSummary(tool: string, args: any) {
  if (!args) return { title: tool, subtitle: '', icon: Terminal, category: 'other' as const };

  switch (tool) {
    case 'dispatch_subagent': {
      const tasks = Array.isArray(args.tasks) ? args.tasks : null;
      if (tasks && tasks.length > 0) {
        return {
          title: `并行子代理 (${tasks.length} 路并发)`,
          subtitle: tasks.map((t: any) => t.role || t.agent || 'explore').join(' · '),
          icon: Sparkles,
          category: 'subagent' as const,
        };
      }
      const roleTitle = args.role || args.agent || 'explore';
      return {
        title: `子代理 [${roleTitle}]`,
        subtitle: args.task ? String(args.task).replace(/\s+/g, ' ').slice(0, 68) : '',
        icon: Sparkles,
        category: 'subagent' as const,
      };
    }
    case 'read_file':
      return {
        title: `读取 ${getBaseName(args.path) || '文件'}`,
        subtitle:
          args.offset || args.maxLines
            ? `${args.path || ''} (${args.offset || 1}~${(args.offset || 1) + (args.maxLines || 100)}行)`
            : args.path || '',
        icon: FileCode,
        category: 'read' as const,
      };
    case 'edit_file':
      return {
        title: `修改 ${getBaseName(args.path) || '文件'}`,
        subtitle: args.path || '',
        icon: Edit3,
        category: 'edit' as const,
      };
    case 'write_file':
      return {
        title: `写入 ${getBaseName(args.path) || '文件'}`,
        subtitle: args.path || '',
        icon: FileCode,
        category: 'edit' as const,
      };
    case 'search_code':
      return {
        title: `搜索 "${args.query || args.pattern || ''}"`,
        subtitle: args.path ? `在 ${args.path}` : '全工程检索',
        icon: Search,
        category: 'search' as const,
      };
    case 'list_directory':
      return {
        title: `浏览目录 ${getBaseName(args.path) || '.'}`,
        subtitle: args.path || '.',
        icon: FolderTree,
        category: 'read' as const,
      };
    case 'run_command':
      return {
        title: `执行命令`,
        subtitle: args.command ? String(args.command).slice(0, 72) : '',
        icon: Terminal,
        category: 'command' as const,
      };
    case 'web_search':
      return {
        title: `联网搜索`,
        subtitle: args.query || '',
        icon: Globe,
        category: 'search' as const,
      };
    case 'web_fetch':
      return {
        title: `抓取网页`,
        subtitle: args.url ? String(args.url).replace(/^https?:\/\//, '').slice(0, 60) : '',
        icon: Globe,
        category: 'search' as const,
      };
    default: {
      if (tool.startsWith('mcp__')) {
        const parts = tool.slice(5).split('__');
        const serverId = parts[0] || 'MCP';
        const subTool = parts.slice(1).join('__') || tool;
        return {
          title: `MCP [${serverId}] ${subTool}`,
          subtitle: args.query || args.libraryName || args.path || '',
          icon: Globe,
          category: 'other' as const,
        };
      }
      return {
        title: `调用 ${tool}`,
        subtitle: '',
        icon: Terminal,
        category: 'other' as const,
      };
    }
  }
}

/**
 * 提取工具返回的单行极简摘要
 */
export function getToolOutputSummary(result: any) {
  if (!result) return '';
  if (result.error) return `失败: ${String(result.error).slice(0, 48)}`;
  const d = result.data;
  if (d) {
    if (d.parallelTasksCount !== undefined) {
      return `${d.parallelTasksCount} 个子代理完成 · 共 ${d.totalToolCallsCount || 0} 步`;
    }
    if (d.agentName && d.rounds !== undefined) {
      return `${d.rounds || 0} 轮 · ${d.toolCallsCount || 0} 次工具调用`;
    }
    if (d.replacedOccurrences) return `替换 ${d.replacedOccurrences} 处 (${d.lineDelta || '0'})`;
    if (d.totalLines) return `${d.startLine || 1}-${d.endLine || d.totalLines} / 共 ${d.totalLines} 行`;
    if (d.matchesCount !== undefined) return `${d.matchesCount} 处匹配`;
    if (Array.isArray(d. matches)) return `${d.matches.length} 处匹配`;
    if (Array.isArray(d.entries)) return `${d.entries.length} 项`;
    if (Array.isArray(d.files)) return `${d.files.length} 项`;
    if (d.stdout) {
      const lastLine = String(d.stdout).trim().split('\n').filter(Boolean).pop();
      return lastLine ? lastLine.slice(0, 42) : '已完成';
    }
    if (typeof d === 'string') return d.slice(0, 42);
  }
  if (result.success) return '完成';
  return '';
}

/**
 * 基于开源库 Anser 渲染紧凑 ANSI 终端输出（仅截取关键尾部输出，不刷屏）
 */
const AnsiTerminalOutput: React.FC<{
  command?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  sandboxed?: boolean;
  sandboxMode?: string;
  sandboxBypassedOnce?: boolean;
}> = ({ command, stdout, stderr, exitCode, sandboxed, sandboxMode, sandboxBypassedOnce }) => {
  const rawOutput = [stdout, stderr].filter(Boolean).join('\n').trim();
  const allLines = rawOutput ? rawOutput.split(/\r?\n/) : [];
  const tailLines = allLines.length > 15 ? allLines.slice(-15) : allLines;
  const displayOutput = tailLines.join('\n');
  const parsedSpans = displayOutput ? Anser.ansiToJson(displayOutput, { use_classes: false }) : [];

  return (
    <div className='rounded-lg overflow-hidden border border-[color:var(--ui-border-hairline)] bg-[var(--ui-terminal-bg)] font-mono text-[11px]'>
      {command && (
        <div className='px-2.5 py-1 bg-[var(--ui-code-header-bg)] border-b border-[color:var(--ui-divider-hairline)] flex items-center justify-between gap-2'>
          <div className='flex items-center gap-1.5 min-w-0'>
            <span className='text-[var(--ui-accent-emerald)] font-bold select-none'>$</span>
            <span className='text-[var(--ui-text-primary)] truncate'>{command}</span>
          </div>
          <div className='flex items-center gap-1.5 flex-shrink-0'>
            {sandboxBypassedOnce ? (
              <span className='px-1.5 py-0.2 rounded text-[10px] bg-[var(--ui-accent-amber-soft)] text-[var(--ui-accent-amber)] border border-[color:var(--ui-accent-amber-border)]'>
                沙箱外重跑
              </span>
            ) : sandboxed ? (
              <span className='px-1.5 py-0.2 rounded text-[10px] bg-[var(--ui-accent-emerald-soft)] text-[var(--ui-accent-emerald)] border border-[color:var(--ui-accent-emerald-border)]'>
                {sandboxMode === 'read-only' ? '只读沙箱' : '沙箱隔离'}
              </span>
            ) : null}
            {allLines.length > 15 && (
              <span className='text-[10px] text-[var(--ui-text-faint)]'>仅显示最后 15 行 (共 {allLines.length} 行)</span>
            )}
            {exitCode !== undefined && (
              <span
                className={`px-1.5 py-0.2 rounded text-[10px] ${
                  exitCode === 0
                    ? 'bg-[var(--ui-accent-emerald-soft)] text-[var(--ui-accent-emerald)] border border-[color:var(--ui-accent-emerald-border)]'
                    : 'bg-[var(--ui-accent-rose-soft)] text-[var(--ui-accent-rose)] border border-[color:var(--ui-accent-rose-border)]'
                }`}
              >
                exit {exitCode}
              </span>
            )}
          </div>
        </div>
      )}
      {parsedSpans.length > 0 ? (
        <pre className='p-2 max-h-36 overflow-y-auto custom-scrollbar whitespace-pre-wrap break-all leading-relaxed m-0 text-[var(--ui-text-secondary)]'>
          {parsedSpans.map((span, i) => (
            <span
              key={i}
              style={{
                color: span.fg ? `rgb(${span.fg})` : undefined,
                backgroundColor: span.bg ? `rgb(${span.bg})` : undefined,
                fontWeight: span.decoration === 'bold' ? 'bold' : undefined,
              }}
            >
              {span.content}
            </span>
          ))}
        </pre>
      ) : (
        <div className='px-2.5 py-1.5 text-[10.5px] text-[var(--ui-text-faint)]'>命令已执行完毕（无控制台标准输出）</div>
      )}
    </div>
  );
};

/**
 * 单个工具的关键信息提炼视图（严禁直接倾倒裸 JSON）
 */
export const ToolKeyDetailView: React.FC<{ ev: ToolStatusEvent }> = ({ ev }) => {
  const args = ev.args || {};
  const data = ev.result?.data || {};
  const errorMsg = ev.result?.error;

  if (errorMsg) {
    return (
      <div className='px-3 py-2 rounded-lg bg-[var(--ui-accent-rose-soft)] border border-[color:var(--ui-accent-rose-border)] text-[var(--ui-accent-rose)] text-[11px] font-mono'>
        执行异常: {String(errorMsg)}
      </div>
    );
  }

  // 0. dispatch_subagent: 展示子代理内部步骤树与精炼结论报告
  if (ev.tool === 'dispatch_subagent') {
    const subSteps = Array.isArray(ev.subSteps) ? ev.subSteps : [];
    const batchResults: any[] = Array.isArray(data?.results) ? data.results : [];
    const singleReport = typeof data?.report === 'string' ? data.report : '';

    return (
      <div className='p-2.5 rounded-lg bg-[var(--ui-code-bg)] border border-[color:var(--ui-accent-sky-border)] flex flex-col gap-2 text-[11px]'>
        {subSteps.length > 0 && (
          <div className='flex flex-col gap-1'>
            <div className='text-[10px] font-mono text-[var(--ui-accent-sky)] flex items-center justify-between'>
              <span>子代理工具轨迹 ({subSteps.length} 步)</span>
              <span>{ev.status === 'running' ? '实时并发执行中' : '已完成'}</span>
            </div>
            <div className='pl-2.5 border-l border-[color:var(--ui-accent-sky-border)] flex flex-col gap-1 max-h-36 overflow-y-auto custom-scrollbar font-mono text-[10.5px]'>
              {subSteps.map((sub, sIdx) => (
                <div key={sub.callId || sIdx} className='flex items-center gap-1.5 text-[var(--ui-text-muted)] truncate'>
                  {sub.status === 'running' ? (
                    <Loader2 size={10} className='text-[var(--ui-accent-sky)] animate-spin flex-shrink-0' />
                  ) : (
                    <CheckCircle2 size={10} className='text-[var(--ui-accent-emerald)] flex-shrink-0' />
                  )}
                  {sub.agentName && (
                    <span className='text-[var(--ui-accent-sky)] flex-shrink-0'>[{sub.agentName}]</span>
                  )}
                  <span className='text-[var(--ui-text-secondary)] flex-shrink-0'>{sub.tool}</span>
                  {sub.summary && (
                    <span className='text-[var(--ui-text-faint)] truncate'>{sub.summary}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {batchResults.length > 0 && (
          <div className='flex flex-col gap-1.5 pt-1 border-t border-[color:var(--ui-divider-hairline)]'>
            {batchResults.map((r, i) => (
              <div key={i} className='p-2 rounded bg-[var(--ui-block-bg)] border border-[color:var(--ui-border-hairline)] flex flex-col gap-1'>
                <div className='flex items-center justify-between text-[10.5px] font-mono'>
                  <span className='text-[var(--ui-accent-sky)] font-medium'>#{r.index} {r.agentName}</span>
                  <span className='text-[var(--ui-text-faint)]'>{r.rounds || 0} 轮 · {r.toolCallsCount || 0} 步</span>
                </div>
                <div className='text-[var(--ui-text-muted)] text-[11px] line-clamp-3 whitespace-pre-wrap'>
                  {r.report}
                </div>
              </div>
            ))}
          </div>
        )}

        {singleReport && (
          <div className='p-2 rounded bg-[var(--ui-block-bg)] border border-[color:var(--ui-border-hairline)] text-[var(--ui-text-secondary)] text-[11px] max-h-36 overflow-y-auto custom-scrollbar whitespace-pre-wrap leading-relaxed'>
            {singleReport}
          </div>
        )}
      </div>
    );
  }

  // 1. edit_file: 展示精炼变更统计 + 紧凑红绿 Diff
  if (ev.tool === 'edit_file' && (args.old_string !== undefined || args.oldString !== undefined)) {
    return (
      <div className='flex flex-col gap-1'>
        <DiffViewer
          oldText={args.old_string ?? args.oldString ?? ''}
          newText={args.new_string ?? args.newString ?? ''}
          filePath={args.path}
          maxHeightClass='max-h-48'
        />
      </div>
    );
  }

  // 2. write_file: 展示写入文件的高亮代码预览（限高）
  if (ev.tool === 'write_file' && args.content) {
    const lines = String(args.content).split('\n');
    const preview = lines.length > 25 ? `${lines.slice(0, 25).join('\n')}\n// ... 其余 ${lines.length - 25} 行已省略` : String(args.content);
    return (
      <CodeBlock
        language={String(args.path || '').split('.').pop() || 'text'}
        value={preview}
        filePath={args.path}
      />
    );
  }

  // 3. run_command: 展示终端命令与尾部关键输出
  if (ev.tool === 'run_command') {
    return (
      <AnsiTerminalOutput
        command={args.command}
        stdout={data?.stdout}
        stderr={data?.stderr}
        exitCode={data?.exitCode}
        sandboxed={data?.sandboxed}
        sandboxMode={data?.sandboxMode}
        sandboxBypassedOnce={data?.sandboxBypassedOnce}
      />
    );
  }

  // 4. read_file: 展示文件路径、读取行区间与前 8 行微缩代码预览
  if (ev.tool === 'read_file') {
    const rawContent = typeof data?.content === 'string' ? data.content : '';
    const previewLines = rawContent ? rawContent.split(/\r?\n/).slice(0, 8) : [];
    return (
      <div className='p-2.5 rounded-lg bg-[var(--ui-code-bg)] border border-[color:var(--ui-border-hairline)] flex flex-col gap-1.5 text-[11px]'>
        <div className='flex items-center justify-between gap-2'>
          <button
            onClick={() => args.path && window.electronAPI?.showInFolder?.(args.path)}
            className='font-mono text-[var(--ui-accent-blue)] hover:underline truncate flex items-center gap-1.5'
            title='在 Finder 中显示'
          >
            <FileCode size={12} />
            <span className='truncate'>{args.path}</span>
          </button>
          <span className='text-[10px] font-mono text-[var(--ui-text-muted)] bg-[var(--ui-chip-bg)] px-2 py-0.5 rounded border border-[color:var(--ui-border-hairline)] flex-shrink-0'>
            第 {data?.startLine || args.offset || 1} - {data?.endLine || '末'} 行
            {data?.totalLines ? ` · 共 ${data.totalLines} 行` : ''}
          </span>
        </div>
        {previewLines.length > 0 && (
          <pre className='p-2 rounded bg-[var(--ui-terminal-bg)] border border-[color:var(--ui-divider-hairline)] text-[10.5px] font-mono text-[var(--ui-text-muted)] overflow-x-auto m-0 leading-relaxed'>
            {previewLines.join('\n')}
            {rawContent.split(/\r?\n/).length > 8 ? '\n… (仅预览前 8 行)' : ''}
          </pre>
        )}
      </div>
    );
  }

  // 5. search_code: 展示检索词 + 前 6 条命中文件:行号列表
  if (ev.tool === 'search_code') {
    const matches: any[] = Array.isArray(data?.matches) ? data.matches : [];
    return (
      <div className='p-2.5 rounded-lg bg-[var(--ui-code-bg)] border border-[color:var(--ui-border-hairline)] flex flex-col gap-1.5 text-[11px]'>
        <div className='flex items-center justify-between text-[var(--ui-text-muted)]'>
          <span>
            检索模式: <code className='text-[var(--ui-accent-blue)] font-mono'>{args.query || args.pattern}</code>
            {args.path ? ` (目录: ${args.path})` : ''}
          </span>
          <span className='font-mono text-[10px] text-[var(--ui-accent-emerald)]'>
            共 {data?.matchesCount ?? matches.length} 处匹配
          </span>
        </div>
        {matches.length > 0 && (
          <div className='flex flex-col gap-1 pt-1 border-t border-[color:var(--ui-divider-hairline)]'>
            {matches.slice(0, 6).map((m, i) => (
              <div
                key={i}
                className='flex items-center justify-between gap-2 px-2 py-1 rounded bg-[var(--ui-block-bg)] font-mono text-[10.5px]'
              >
                <span className='text-[var(--ui-accent-blue)] truncate max-w-[45%]'>
                  {m.file || m.path}:{m.line || 1}
                </span>
                <span className='text-[var(--ui-text-muted)] truncate flex-1 text-right'>
                  {String(m.text || m.preview || '').trim()}
                </span>
              </div>
            ))}
            {matches.length > 6 && (
              <span className='text-[10px] text-[var(--ui-text-faint)] px-1'>
                … 其余 {matches.length - 6} 处匹配已省略
              </span>
            )}
          </div>
        )}
      </div>
    );
  }

  // 6. list_directory: 以紧凑文件/目录胶囊网格展示，不打印 JSON 数组
  if (ev.tool === 'list_directory') {
    const entries: any[] = Array.isArray(data?.entries)
      ? data.entries
      : Array.isArray(data?.files)
      ? data.files
      : [];
    return (
      <div className='p-2.5 rounded-lg bg-[var(--ui-code-bg)] border border-[color:var(--ui-border-hairline)] flex flex-col gap-1.5 text-[11px]'>
        <div className='flex items-center justify-between text-[var(--ui-text-muted)]'>
          <span className='font-mono truncate'>目录: {args.path || '.'}</span>
          <span className='font-mono text-[10px]'>共 {entries.length} 项</span>
        </div>
        {entries.length > 0 && (
          <div className='flex flex-wrap gap-1.5 pt-1 max-h-28 overflow-y-auto custom-scrollbar'>
            {entries.slice(0, 24).map((entry, i) => {
              const name = typeof entry === 'string' ? entry : entry.name || entry.path;
              const isDir =
                typeof entry === 'object'
                  ? entry.type === 'directory' || entry.isDirectory
                  : String(name).endsWith('/');
              return (
                <span
                  key={i}
                  className='inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)] font-mono text-[10.5px] text-[var(--ui-text-secondary)]'
                >
                  {isDir ? (
                    <Folder size={10} className='text-[var(--ui-accent-amber)]' />
                  ) : (
                    <FileCode size={10} className='text-[var(--ui-accent-blue)]' />
                  )}
                  <span>{name}</span>
                </span>
              );
            })}
            {entries.length > 24 && (
              <span className='text-[10px] text-[var(--ui-text-faint)] self-center'>
                +{entries.length - 24} 项
              </span>
            )}
          </div>
        )}
      </div>
    );
  }

  // 7. web_search / web_fetch: 展示搜索结果链接列表或网页摘要
  if (ev.tool === 'web_search' || ev.tool === 'web_fetch') {
    const results: any[] = Array.isArray(data?.results) ? data.results : [];
    return (
      <div className='p-2.5 rounded-lg bg-[var(--ui-code-bg)] border border-[color:var(--ui-border-hairline)] flex flex-col gap-1.5 text-[11px]'>
        {results.length > 0 ? (
          results.slice(0, 5).map((item, i) => (
            <a
              key={i}
              href={item.url}
              target='_blank'
              rel='noopener noreferrer'
              className='flex items-center justify-between gap-2 px-2 py-1 rounded hover:bg-[var(--ui-block-hover-bg)] text-[var(--ui-accent-blue)] transition-colors'
            >
              <span className='truncate'>{item.title || item.url}</span>
              <ExternalLink size={11} className='flex-shrink-0 text-[var(--ui-text-faint)]' />
            </a>
          ))
        ) : (
          <div className='text-[var(--ui-text-muted)] line-clamp-3'>
            {typeof data === 'string'
              ? data.slice(0, 240)
              : data?.content
              ? String(data.content).slice(0, 240)
              : `已完成 ${args.query || args.url || ''}`}
          </div>
        )}
      </div>
    );
  }

  // 8. 其他工具 / MCP 工具：展示紧凑参数胶囊 + 核心文本摘要
  const paramEntries = Object.entries(args).filter(
    ([k, v]) => !k.startsWith('__') && v !== undefined && v !== ''
  );
  const summaryText =
    typeof data?.content === 'string'
      ? data.content.slice(0, 260)
      : typeof data === 'string'
      ? data.slice(0, 260)
      : getToolOutputSummary(ev.result) || '执行成功';

  return (
    <div className='p-2.5 rounded-lg bg-[var(--ui-code-bg)] border border-[color:var(--ui-border-hairline)] flex flex-col gap-1.5 text-[11px]'>
      {paramEntries.length > 0 && (
        <div className='flex flex-wrap gap-1.5'>
          {paramEntries.map(([k, v]) => (
            <span
              key={k}
              className='px-2 py-0.5 rounded bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)] font-mono text-[10px] text-[var(--ui-text-secondary)] max-w-full truncate'
            >
              <span className='text-[var(--ui-text-faint)]'>{k}: </span>
              <span>{typeof v === 'object' ? JSON.stringify(v).slice(0, 60) : String(v).slice(0, 80)}</span>
            </span>
          ))}
        </div>
      )}
      <div className='text-[var(--ui-text-muted)] font-mono text-[10.5px] line-clamp-3'>{summaryText}</div>
    </div>
  );
};

type GroupedStepItem =
  | { kind: 'single'; event: ToolStatusEvent; originalIndex: number }
  | { kind: 'read-group'; events: Array<{ event: ToolStatusEvent; originalIndex: number }> };

/**
 * 将连续的只读探索操作 (read_file / list_directory) 合并为单行横向胶囊组
 */
function groupConsecutiveReadSteps(events: ToolStatusEvent[]): GroupedStepItem[] {
  const groups: GroupedStepItem[] = [];
  let currentReadBatch: Array<{ event: ToolStatusEvent; originalIndex: number }> = [];

  const flushBatch = () => {
    if (currentReadBatch.length === 1) {
      groups.push({
        kind: 'single',
        event: currentReadBatch[0].event,
        originalIndex: currentReadBatch[0].originalIndex,
      });
    } else if (currentReadBatch.length > 1) {
      groups.push({
        kind: 'read-group',
        events: [...currentReadBatch],
      });
    }
    currentReadBatch = [];
  };

  events.forEach((ev, idx) => {
    if (ev.tool === 'read_file' || ev.tool === 'list_directory') {
      currentReadBatch.push({ event: ev, originalIndex: idx });
    } else {
      flushBatch();
      groups.push({ kind: 'single', event: ev, originalIndex: idx });
    }
  });
  flushBatch();

  return groups;
}

/**
 * ZCode / DSH 风格高密度工具调用组件
 * - 自动过滤冗余的 todo_write
 * - 默认收起为单行统计摘要栏（执行中展示最多 3 行滚动视窗）
 * - 展开后连续只读操作合并为横向文件胶囊，点击才看提炼后的关键信息
 */
export const ToolStepList: React.FC<{ events: ToolStatusEvent[] }> = ({ events }) => {
  // 过滤掉纯更新状态机的 todo_write 伪步骤
  const filteredEvents = useMemo(
    () => events.filter((e) => e.tool !== 'todo_write'),
    [events]
  );

  // 默认展开全量执行步骤，便于直观查看 Agent 的实时工具推进链路
  const [isExpanded, setIsExpanded] = useState(true);
  const [selectedStepIdx, setSelectedStepIdx] = useState<number | null>(null);

  const runningEvents = filteredEvents.filter((e) => e.status === 'running');
  const isAnyRunning = runningEvents.length > 0;

  // 统计分类数量与修改过的文件名
  const stats = useMemo(() => {
    let read = 0;
    let search = 0;
    let edit = 0;
    let command = 0;
    let subagent = 0;
    const editedFiles = new Set<string>();

    for (const ev of filteredEvents) {
      const { category } = getToolStepSummary(ev.tool, ev.args);
      if (category === 'read') read++;
      else if (category === 'search') search++;
      else if (category === 'edit') {
        edit++;
        const name = getBaseName(ev.args?.path);
        if (name) editedFiles.add(name);
      } else if (category === 'command') command++;
      else if (category === 'subagent') subagent++;
    }
    return {
      read,
      search,
      edit,
      command,
      subagent,
      editedFiles: Array.from(editedFiles),
    };
  }, [filteredEvents]);

  const groupedItems = useMemo(
    () => groupConsecutiveReadSteps(filteredEvents),
    [filteredEvents]
  );

  // 执行中未手动展开时，仅取最后 2 条步骤作为紧凑实时视窗
  const liveWindowEvents = isAnyRunning && !isExpanded ? filteredEvents.slice(-2) : [];

  // ⚠️ 必须置于所有 Hook 之后，保证任意渲染路径下 Hook 调用数量恒定（杜绝 Hook 顺序违规导致白屏）
  if (filteredEvents.length === 0) return null;

  const toggleSelectStep = (idx: number) => {
    setSelectedStepIdx((prev) => (prev === idx ? null : idx));
  };

  return (
    <div className='mb-1.5 w-full max-w-full select-none'>
      {/* 1. 单行高密度汇总顶栏 */}
      <div
        onClick={() => setIsExpanded((v) => !v)}
        className='py-1 flex items-center justify-between gap-2 cursor-pointer text-[var(--ui-text-muted)] hover:text-[var(--ui-text-secondary)] transition-colors'
      >
        <div className='flex items-center gap-2 min-w-0 flex-wrap'>
          {isAnyRunning ? (
            <Loader2 size={12} className='text-[var(--ui-accent-blue)] animate-spin flex-shrink-0' />
          ) : (
            <CheckCircle2 size={12} className='text-[var(--ui-accent-emerald)] flex-shrink-0' />
          )}

          <span className='text-xs font-semibold text-[var(--ui-text-secondary)] flex-shrink-0'>
            {isAnyRunning
              ? `正在执行工具 (${filteredEvents.length} 步)`
              : `已执行 ${filteredEvents.length} 个步骤`}
          </span>

          {/* 分类统计胶囊 */}
          <div className="flex items-center gap-1.5 flex-wrap [&>*+*]:before:content-['·'] [&>*+*]:before:mr-1.5 [&>*+*]:before:text-[var(--ui-text-faint)]">
            {stats.read > 0 && (
              <span className='text-[10px] font-mono text-[var(--ui-text-muted)]'>
                读取 {stats.read}
              </span>
            )}
            {stats.search > 0 && (
              <span className='text-[10px] font-mono text-[var(--ui-text-muted)]'>
                搜索 {stats.search}
              </span>
            )}
            {stats.edit > 0 && (
              <span className='text-[10px] font-mono text-[var(--ui-accent-blue)]'>
                修改 {stats.edit}
              </span>
            )}
            {stats.command > 0 && (
              <span className='text-[10px] font-mono text-[var(--ui-accent-emerald)]'>
                命令 {stats.command}
              </span>
            )}
            {stats.subagent > 0 && (
              <span className='text-[10px] font-mono text-[var(--ui-accent-sky)]'>
                子代理 {stats.subagent}
              </span>
            )}
          </div>
        </div>

        <div className='flex items-center gap-1 text-[11px] text-[var(--ui-text-faint)] font-mono flex-shrink-0'>
          <span>{isExpanded ? '收起' : '详情'}</span>
          {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </div>
      </div>

      {/* 2. 执行中的紧凑实时滚动视窗（最多展示最近 2 步，不撑高页面） */}
      {liveWindowEvents.length > 0 && (
        <div className='px-0 py-1 border-t border-[color:var(--ui-divider-hairline)] flex flex-col gap-1'>
          {liveWindowEvents.map((ev, i) => {
            const { title, subtitle } = getToolStepSummary(ev.tool, ev.args);
            const isRunning = ev.status === 'running';
            const recentSubSteps = Array.isArray(ev.subSteps) ? ev.subSteps.slice(-3) : [];
            return (
              <div key={ev.callId || i} className='flex flex-col gap-0.5 py-0.5'>
                <div className='flex items-center justify-between text-[11px]'>
                  <div className='flex items-center gap-2 min-w-0'>
                    {isRunning ? (
                      <Loader2 size={11} className='text-[var(--ui-accent-blue)] animate-spin flex-shrink-0' />
                    ) : (
                      <CheckCircle2 size={11} className='text-[var(--ui-accent-emerald)] flex-shrink-0' />
                    )}
                    <span className='text-[var(--ui-text-secondary)] font-medium truncate'>{title}</span>
                    {subtitle && (
                      <span className='text-[10px] text-[var(--ui-text-faint)] font-mono truncate max-w-[240px]'>
                        {subtitle}
                      </span>
                    )}
                  </div>
                  <span className='text-[10px] font-mono text-[var(--ui-text-faint)] flex-shrink-0'>
                    {isRunning
                      ? ev.subSteps?.length
                        ? `已运行 ${ev.subSteps.length} 步...`
                        : '执行中...'
                      : getToolOutputSummary(ev.result)}
                  </span>
                </div>
                {recentSubSteps.length > 0 && (
                  <div className='ml-5 pl-2 border-l border-[color:var(--ui-accent-sky-border)] flex flex-col gap-0.5 font-mono text-[10px] text-[var(--ui-text-faint)]'>
                    {recentSubSteps.map((sub, sIdx) => (
                      <div key={sub.callId || sIdx} className='flex items-center gap-1.5 truncate'>
                        {sub.status === 'running' ? (
                          <Loader2 size={9} className='text-[var(--ui-accent-sky)] animate-spin flex-shrink-0' />
                        ) : (
                          <span className='text-[var(--ui-text-faint)] flex-shrink-0'>·</span>
                        )}
                        {sub.agentName && (
                          <span className='text-[var(--ui-accent-sky)] flex-shrink-0'>[{sub.agentName}]</span>
                        )}
                        <span className='text-[var(--ui-text-muted)] flex-shrink-0'>{sub.tool}</span>
                        {sub.summary && <span className='truncate'>{sub.summary}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 3. 点击展开后的聚合步骤列表（内部限高 max-h-64 滚动，连续只读步骤横向胶囊聚合） */}
      {isExpanded && (
        <div className='py-1 border-t border-[color:var(--ui-divider-hairline)] max-h-64 overflow-y-auto custom-scrollbar flex flex-col gap-1 divide-y ui-divide-hairline'>
          {groupedItems.map((group, gIdx) => {
            if (group.kind === 'read-group') {
              const activeInGroup = group.events.find((item) => item.originalIndex === selectedStepIdx);
              return (
                <div key={`group-${gIdx}`} className='pt-1 first:pt-0'>
                  <div className='flex items-center gap-1.5 flex-wrap py-1 px-1.5 text-xs'>
                    <FileCode size={12} className='text-[var(--ui-text-muted)] flex-shrink-0' />
                    <span className='text-[11px] text-[var(--ui-text-muted)] font-medium mr-1'>
                      连续浏览 ({group.events.length}):
                    </span>
                    {group.events.map(({ event, originalIndex }) => {
                      const label =
                        getBaseName(event.args?.path) ||
                        event.args?.path ||
                        (event.tool === 'list_directory' ? '目录' : '文件');
                      const isSelected = selectedStepIdx === originalIndex;
                      return (
                        <button
                          key={event.callId || originalIndex}
                          onClick={() => toggleSelectStep(originalIndex)}
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md font-mono text-[10.5px] border transition-colors ${
                            isSelected
                              ? 'bg-[var(--ui-accent-blue-soft)] border-[color:var(--ui-accent-blue-border)] text-[var(--ui-accent-blue)]'
                              : 'bg-[var(--ui-chip-bg)] border-[color:var(--ui-border-hairline)] text-[var(--ui-text-secondary)] hover:bg-[var(--ui-chip-hover-bg)] hover:border-[color:var(--ui-border-subtle)]'
                          }`}
                        >
                          <span>{label}</span>
                        </button>
                      );
                    })}
                  </div>
                  {activeInGroup && (
                    <div className='mt-1 mb-1.5 mx-1.5'>
                      <ToolKeyDetailView ev={activeInGroup.event} />
                    </div>
                  )}
                </div>
              );
            }

            const ev = group.event;
            const idx = group.originalIndex;
            const isRunning = ev.status === 'running';
            const isSuccess = ev.result?.success !== false;
            const { title, subtitle } = getToolStepSummary(ev.tool, ev.args);
            const outputSummary = getToolOutputSummary(ev.result);
            const isStepOpen = selectedStepIdx === idx;

            return (
              <div key={`${ev.tool}-${ev.callId || idx}`} className='pt-1 first:pt-0'>
                <div
                  onClick={() => toggleSelectStep(idx)}
                  className='flex items-center justify-between py-1 px-2 rounded-lg hover:bg-[var(--ui-block-hover-bg)] cursor-pointer transition-colors text-xs'
                >
                  <div className='flex items-center gap-2 min-w-0 pr-2'>
                    {isRunning ? (
                      <Loader2 size={11} className='text-[var(--ui-accent-blue)] animate-spin flex-shrink-0' />
                    ) : isSuccess ? (
                      <CheckCircle2 size={11} className='text-[var(--ui-accent-emerald)] flex-shrink-0' />
                    ) : (
                      <XCircle size={11} className='text-[var(--ui-accent-rose)] flex-shrink-0' />
                    )}
                    <span className='font-medium text-[var(--ui-text-primary)] truncate text-[11.5px]'>{title}</span>
                    {subtitle && (
                      <span className='text-[10px] text-[var(--ui-text-faint)] font-mono truncate max-w-[220px]'>
                        {subtitle}
                      </span>
                    )}
                  </div>

                  <div className='flex items-center gap-2 flex-shrink-0'>
                    {outputSummary && !isStepOpen && (
                      <span className='text-[10px] font-mono text-[var(--ui-text-muted)] truncate max-w-[160px]'>
                        {outputSummary}
                      </span>
                    )}
                    <div className='text-[var(--ui-text-faint)]'>
                      {isStepOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                    </div>
                  </div>
                </div>

                {isStepOpen && (
                  <div className='mt-1 mb-1.5 mx-2'>
                    <ToolKeyDetailView ev={ev} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
