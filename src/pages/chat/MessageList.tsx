import React, { useRef, useEffect, useState, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import * as Diff from 'diff';
import {
  Copy,
  RotateCw,
  CheckCircle2,
  XCircle,
  Clock,
  ChevronRight,
  ChevronDown,
  Globe,
  FileCode,
  FolderTree,
  Terminal,
  Edit3,
  Search,
  Check,
  Loader2,
  FileSpreadsheet,
  FileArchive,
  FileText,
  File as GenericFileIcon,
  Folder,
  Sparkles,
  ExternalLink,
  FilePlus2,
  FileDiff,
  Pin,
  X,
} from 'lucide-react';
import { Message } from '../../stores/chatStore';
import MarkdownContent, { ThinkingBlock } from '@/components/common/MarkdownContent';
import CodeBlock, { DiffViewer, SplitDiffViewer } from '@/components/common/CodeBlock';
import TodoListCard, { TodoItem } from '@/components/agent/TodoListCard';
import { parseMessageContent } from '@/lib/messageParser';
import { isImageAttachment, classifyAttachment, formatFileSize } from '@/lib/chatAttachment';
import Anser from 'anser';

interface ToolStatusEvent {
  tool: string;
  status: 'running' | 'done';
  args: any;
  result?: any;
  callId?: string;
  subSteps?: Array<{
    callId: string;
    tool: string;
    args?: any;
    status: 'running' | 'done';
    summary?: string;
    agentName?: string;
  }>;
}

interface Props {
  messages: Message[];
  isGenerating: boolean;
  activeSearchProgress: any;
  activeToolCalls: ToolStatusEvent[];
  activeTodos?: TodoItem[];
  onCopy: (text: string) => void;
  onRetry: (msg: Message) => void;
}

function getBaseName(p?: string) {
  if (!p || typeof p !== 'string') return '';
  return p.split(/[\\/]/).filter(Boolean).pop() || p;
}

/**
 * 提取工具调用的自然语言关键语义
 */
function getToolStepSummary(tool: string, args: any) {
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
function getToolOutputSummary(result: any) {
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
const ToolKeyDetailView: React.FC<{ ev: ToolStatusEvent }> = ({ ev }) => {
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
const ToolStepList: React.FC<{ events: ToolStatusEvent[] }> = ({ events }) => {
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
    <div className='mb-1.5 w-full max-w-full bg-[var(--ui-block-bg)] border border-[color:var(--ui-border-hairline)] hover:border-[color:var(--ui-border-subtle)] rounded-xl overflow-hidden select-none transition-colors'>
      {/* 1. 单行高密度汇总顶栏 (34px) */}
      <div
        onClick={() => setIsExpanded((v) => !v)}
        className='px-3 py-1.5 flex items-center justify-between gap-2 cursor-pointer hover:bg-[var(--ui-block-hover-bg)] transition-colors'
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
          <div className='flex items-center gap-1 flex-wrap'>
            {stats.read > 0 && (
              <span className='text-[10px] font-mono px-1.5 py-0.2 rounded bg-[var(--ui-chip-bg)] text-[var(--ui-text-muted)] border border-[color:var(--ui-border-hairline)]'>
                读取 {stats.read}
              </span>
            )}
            {stats.search > 0 && (
              <span className='text-[10px] font-mono px-1.5 py-0.2 rounded bg-[var(--ui-chip-bg)] text-[var(--ui-text-muted)] border border-[color:var(--ui-border-hairline)]'>
                搜索 {stats.search}
              </span>
            )}
            {stats.edit > 0 && (
              <span className='text-[10px] font-mono px-1.5 py-0.2 rounded bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)] border border-[color:var(--ui-accent-blue-border)]'>
                修改 {stats.edit}
              </span>
            )}
            {stats.command > 0 && (
              <span className='text-[10px] font-mono px-1.5 py-0.2 rounded bg-[var(--ui-accent-emerald-soft)] text-[var(--ui-accent-emerald)] border border-[color:var(--ui-accent-emerald-border)]'>
                命令 {stats.command}
              </span>
            )}
            {stats.subagent > 0 && (
              <span className='text-[10px] font-mono px-1.5 py-0.2 rounded bg-[var(--ui-accent-sky-soft)] text-[var(--ui-accent-sky)] border border-[color:var(--ui-accent-sky-border)]'>
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
        <div className='px-3 py-1.5 border-t border-[color:var(--ui-divider-hairline)] bg-[var(--ui-block-body-bg)] flex flex-col gap-1'>
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
        <div className='p-2 border-t border-[color:var(--ui-divider-hairline)] bg-[var(--ui-block-body-bg)] max-h-64 overflow-y-auto custom-scrollbar flex flex-col gap-1 divide-y ui-divide-hairline'>
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
                      <span className='text-[10px] font-mono text-[var(--ui-text-muted)] bg-[var(--ui-chip-bg)] px-1.5 py-0.2 rounded border border-[color:var(--ui-border-hairline)] truncate max-w-[160px]'>
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

interface FileModificationItem {
  id: string;
  tool: 'edit_file' | 'write_file';
  filePath: string;
  fileName: string;
  status: 'running' | 'done';
  isError: boolean;
  errorMsg?: string;
  actionLabel: '修改' | '新建' | '覆写' | '写入';
  isNewFile: boolean;
  noSnapshot: boolean;
  oldText: string;
  newText: string;
  addedLines: number;
  removedLines: number;
  occurrenceTag?: string;
}

function countDiffLineStats(oldText: string, newText: string, isNewFile: boolean) {
  if (isNewFile) {
    const lines = newText ? newText.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').length : 0;
    return { addedLines: lines, removedLines: 0 };
  }
  const changes = Diff.diffLines(oldText || '', newText || '');
  let addedLines = 0;
  let removedLines = 0;
  for (const part of changes) {
    const clean = part.value.replace(/\r\n/g, '\n').replace(/\n$/, '');
    const cnt = clean ? clean.split('\n').length : (part.value ? 1 : 0);
    if (part.added) addedLines += cnt;
    else if (part.removed) removedLines += cnt;
  }
  return { addedLines, removedLines };
}

function extractFileModifications(events: ToolStatusEvent[]): FileModificationItem[] {
  const rawItems: FileModificationItem[] = [];
  const pathCountMap = new Map<string, number>();

  events.forEach((ev, idx) => {
    if (ev.tool !== 'edit_file' && ev.tool !== 'write_file') return;
    const args = ev.args || {};
    const data = ev.result?.data || {};
    const filePath = String(args.path || data.path || '');
    const fileName = getBaseName(filePath) || '未命名文件';
    const isError =
      ev.status === 'done' &&
      (ev.result?.success === false || Boolean(ev.result?.error) || data?.success === false);
    const errorMsg = ev.result?.error || data?.error;

    let actionLabel: FileModificationItem['actionLabel'] = '修改';
    let isNewFile = false;
    let noSnapshot = false;
    let oldText = '';
    let newText = '';

    if (ev.tool === 'edit_file') {
      actionLabel = '修改';
      oldText = String(args.old_string ?? args.oldString ?? '');
      newText = String(args.new_string ?? args.newString ?? '');
    } else {
      newText = String(args.content ?? '');
      if (data?.action === 'created') {
        actionLabel = '新建';
        isNewFile = true;
      } else if (data?.action === 'modified') {
        actionLabel = '覆写';
        if (typeof data?.originalContent === 'string') {
          oldText = data.originalContent;
        } else {
          noSnapshot = true;
        }
      } else {
        actionLabel = '写入';
        isNewFile = true;
      }
    }

    const { addedLines, removedLines } = isError
      ? { addedLines: 0, removedLines: 0 }
      : countDiffLineStats(oldText, newText, isNewFile);

    const key = filePath || fileName;
    pathCountMap.set(key, (pathCountMap.get(key) || 0) + 1);

    rawItems.push({
      id: ev.callId || `mod_${idx}`,
      tool: ev.tool,
      filePath,
      fileName,
      status: ev.status,
      isError,
      errorMsg: errorMsg ? String(errorMsg) : undefined,
      actionLabel,
      isNewFile,
      noSnapshot,
      oldText,
      newText,
      addedLines,
      removedLines,
    });
  });

  // 同一个文件有多次局部修改时，标注 #1 / #2 便于分辨每一处变更
  const seenIndex = new Map<string, number>();
  return rawItems.map((item) => {
    const key = item.filePath || item.fileName;
    const total = pathCountMap.get(key) || 1;
    if (total <= 1) return item;
    const seq = (seenIndex.get(key) || 0) + 1;
    seenIndex.set(key, seq);
    return { ...item, occurrenceTag: `#${seq}` };
  });
}

interface PopoverCoords {
  top?: number;
  bottom?: number;
  left: number;
  width: number;
  maxBodyHeight: number;
  placement: 'above' | 'below';
  arrowLeft: number;
}

function computeAnchoredPopoverCoords(anchorEl: HTMLElement): PopoverCoords | null {
  const rect = anchorEl.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const margin = 14;
  const gap = 7;

  const width = Math.min(820, Math.max(460, vw - margin * 2));
  const spaceAbove = rect.top - margin - gap;
  const spaceBelow = vh - rect.bottom - margin - gap;
  const placement: 'above' | 'below' =
    spaceAbove >= 320 || spaceAbove >= spaceBelow ? 'above' : 'below';

  const availableVertical = placement === 'above' ? spaceAbove : spaceBelow;
  // 扣除弹出层头部/列头大约 82px，确保整体不溢出视口
  const totalHeightBudget = Math.max(200, Math.min(480, availableVertical));
  const maxBodyHeight = Math.max(120, totalHeightBudget - 82);

  let left = rect.left;
  if (left + width > vw - margin) {
    left = vw - margin - width;
  }
  if (left < margin) {
    left = margin;
  }

  const anchorCenter = rect.left + rect.width / 2;
  const arrowLeft = Math.max(18, Math.min(width - 18, anchorCenter - left));

  if (placement === 'above') {
    return {
      bottom: Math.max(margin, vh - rect.top + gap),
      left,
      width,
      maxBodyHeight,
      placement,
      arrowLeft,
    };
  }

  return {
    top: Math.max(margin, rect.bottom + gap),
    left,
    width,
    maxBodyHeight,
    placement,
    arrowLeft,
  };
}

/**
 * 独立外显的文件变更展示区 + 对应位置吸附悬浮弹出层（左右分块 Diff）
 * - 默认常驻展开可见，不被工具调用折叠列表隐藏
 * - 鼠标悬停在对应文件胶囊上时，吸附在该胶囊上方/下方弹出左右分块差异对比视图
 */
const ModifiedFilesBar: React.FC<{ events: ToolStatusEvent[] }> = ({ events }) => {
  const modItems = useMemo(() => extractFileModifications(events), [events]);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [isPinned, setIsPinned] = useState(false);
  const [coords, setCoords] = useState<PopoverCoords | null>(null);

  const anchorRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  const clearTimers = useCallback(() => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const updateCoordsForId = useCallback((id: string | null) => {
    if (!id) {
      setCoords(null);
      return;
    }
    const el = anchorRefs.current[id];
    if (!el) {
      setCoords(null);
      return;
    }
    const next = computeAnchoredPopoverCoords(el);
    setCoords(next);
  }, []);

  useEffect(() => {
    return () => clearTimers();
  }, [clearTimers]);

  // 滚动或窗口缩放时实时重新吸附定位
  useEffect(() => {
    if (!activeId) return;
    updateCoordsForId(activeId);

    const handleReposition = () => {
      const el = anchorRefs.current[activeId];
      if (!el) {
        setActiveId(null);
        setIsPinned(false);
        return;
      }
      const rect = el.getBoundingClientRect();
      // 锚点滚出可视区域则自动关闭浮层，避免悬空
      if (rect.bottom < 0 || rect.top > window.innerHeight) {
        setActiveId(null);
        setIsPinned(false);
        return;
      }
      updateCoordsForId(activeId);
    };

    window.addEventListener('scroll', handleReposition, true);
    window.addEventListener('resize', handleReposition);
    return () => {
      window.removeEventListener('scroll', handleReposition, true);
      window.removeEventListener('resize', handleReposition);
    };
  }, [activeId, updateCoordsForId]);

  // 固定模式下支持点击外部或按 Esc 关闭
  useEffect(() => {
    if (!activeId) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        clearTimers();
        setActiveId(null);
        setIsPinned(false);
      }
    };
    const handlePointerDown = (e: MouseEvent) => {
      if (!isPinned) return;
      const target = e.target as Node;
      const insidePopover = popoverRef.current?.contains(target);
      const insideAnchor = Object.values(anchorRefs.current).some((el) => el?.contains(target));
      if (!insidePopover && !insideAnchor) {
        setActiveId(null);
        setIsPinned(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [activeId, isPinned, clearTimers]);

  const handleAnchorEnter = (id: string) => {
    if (isPinned && activeId !== id) return;
    clearTimers();
    if (activeId) {
      setActiveId(id);
      updateCoordsForId(id);
    } else {
      openTimerRef.current = window.setTimeout(() => {
        setActiveId(id);
        updateCoordsForId(id);
      }, 80);
    }
  };

  const handleAnchorLeave = () => {
    if (isPinned) return;
    clearTimers();
    closeTimerRef.current = window.setTimeout(() => {
      setActiveId(null);
    }, 180);
  };

  const handlePopoverEnter = () => {
    clearTimers();
  };

  const handlePopoverLeave = () => {
    if (isPinned) return;
    clearTimers();
    closeTimerRef.current = window.setTimeout(() => {
      setActiveId(null);
    }, 180);
  };

  const handleAnchorClick = (id: string) => {
    clearTimers();
    if (activeId === id && isPinned) {
      setIsPinned(false);
      setActiveId(null);
    } else {
      setActiveId(id);
      setIsPinned(true);
      updateCoordsForId(id);
    }
  };

  if (modItems.length === 0) return null;

  const activeItem = activeId ? modItems.find((m) => m.id === activeId) || null : null;

  return (
    <div className='mb-1.5 w-full max-w-full bg-[var(--ui-block-bg)] border border-[color:var(--ui-border-hairline)] hover:border-[color:var(--ui-border-subtle)] rounded-xl px-3 py-2 select-none transition-colors'>
      <div className='flex items-center gap-2 flex-wrap'>
        <div className='flex items-center gap-1.5 text-xs text-[var(--ui-text-secondary)] flex-shrink-0 mr-0.5'>
          <FileDiff size={13} className='text-[var(--ui-accent-amber)]' />
          <span className='font-semibold'>文件变更</span>
          <span className='text-[10px] font-mono text-[var(--ui-text-faint)]'>({modItems.length})</span>
        </div>

        <div className='flex items-center gap-1.5 flex-wrap flex-1 min-w-0'>
          {modItems.map((item) => {
            const isActive = activeId === item.id;
            const isRunning = item.status === 'running';

            return (
              <button
                key={item.id}
                ref={(el) => {
                  anchorRefs.current[item.id] = el;
                }}
                type='button'
                onMouseEnter={() => handleAnchorEnter(item.id)}
                onMouseLeave={handleAnchorLeave}
                onClick={() => handleAnchorClick(item.id)}
                className={`group/mod inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-mono border transition-all cursor-pointer max-w-[260px] ${
                  item.isError
                    ? 'bg-[var(--ui-accent-rose-soft)] border-[color:var(--ui-accent-rose-border)] text-[var(--ui-accent-rose)]'
                    : isActive
                    ? 'bg-[var(--ui-accent-blue-soft)] border-[color:var(--ui-accent-blue-border)] text-[var(--ui-accent-blue)]'
                    : 'bg-[var(--ui-chip-bg)] border-[color:var(--ui-border-hairline)] hover:bg-[var(--ui-chip-hover-bg)] hover:border-[color:var(--ui-border-subtle)] text-[var(--ui-text-primary)]'
                }`}
                title={`${item.filePath || item.fileName} · 悬停或点击对比左右差异`}
              >
                {isRunning ? (
                  <Loader2 size={11} className='text-[var(--ui-accent-blue)] animate-spin flex-shrink-0' />
                ) : item.isError ? (
                  <XCircle size={11} className='text-[var(--ui-accent-rose)] flex-shrink-0' />
                ) : item.isNewFile ? (
                  <FilePlus2 size={11} className='text-[var(--ui-accent-emerald)] flex-shrink-0' />
                ) : (
                  <Edit3 size={11} className='text-[var(--ui-accent-amber)] flex-shrink-0' />
                )}

                <span
                  className={`text-[9.5px] px-1 py-0.2 rounded flex-shrink-0 font-medium ${
                    item.isError
                      ? 'bg-[var(--ui-accent-rose-soft)] text-[var(--ui-accent-rose)]'
                      : item.isNewFile
                      ? 'bg-[var(--ui-accent-emerald-soft)] text-[var(--ui-accent-emerald)]'
                      : 'bg-[var(--ui-accent-amber-soft)] text-[var(--ui-accent-amber)]'
                  }`}
                >
                  {item.actionLabel}
                </span>

                <span className='truncate'>{item.fileName}</span>

                {item.occurrenceTag && (
                  <span className='text-[9.5px] text-[var(--ui-text-muted)] flex-shrink-0'>
                    {item.occurrenceTag}
                  </span>
                )}

                {!item.isError && !isRunning && (item.addedLines > 0 || item.removedLines > 0) && (
                  <span className='flex items-center gap-1 text-[10px] flex-shrink-0 ml-0.5 font-semibold'>
                    {item.addedLines > 0 && (
                      <span className='text-[var(--ui-accent-emerald)]'>+{item.addedLines}</span>
                    )}
                    {item.removedLines > 0 && (
                      <span className='text-[var(--ui-accent-rose)]'>-{item.removedLines}</span>
                    )}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <span className='hidden sm:inline text-[10px] text-[var(--ui-text-faint)] font-sans flex-shrink-0'>
          悬停对比差异 · 点击固定
        </span>
      </div>

      {/* 对应位置吸附悬浮弹出层：左右分块展示修改差异 */}
      {activeItem &&
        coords &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={popoverRef}
            onMouseEnter={handlePopoverEnter}
            onMouseLeave={handlePopoverLeave}
            style={{
              position: 'fixed',
              top: coords.top,
              bottom: coords.bottom,
              left: coords.left,
              width: coords.width,
              zIndex: 9999,
            }}
            className='rounded-xl border border-[color:var(--ui-border-subtle)] bg-[var(--ui-popover-bg)] shadow-[var(--ui-popover-shadow)]'
          >
            {/* 位置吸附指示小三角 */}
            <div
              style={{ left: coords.arrowLeft }}
              className={`absolute -translate-x-1/2 w-2.5 h-2.5 rotate-45 border-[color:var(--ui-border-subtle)] pointer-events-none z-10 ${
                coords.placement === 'above'
                  ? '-bottom-1.5 border-r border-b bg-[var(--ui-code-bg)]'
                  : '-top-1.5 border-l border-t bg-[var(--ui-code-header-bg)]'
              }`}
            />

            <div className='rounded-xl overflow-hidden'>
              {/* 弹出层状态控制顶栏（当固定或需要快捷关闭时） */}
              {isPinned && (
                <div className='px-3 py-1 bg-[var(--ui-code-header-bg)] border-b border-[color:var(--ui-divider-hairline)] flex items-center justify-between text-[10.5px] text-[var(--ui-accent-blue)] select-none'>
                  <span className='flex items-center gap-1.5'>
                    <Pin size={11} />
                    <span>对比浮层已固定（按 Esc 或点击外部关闭）</span>
                  </span>
                  <button
                    type='button'
                    onClick={() => {
                      setIsPinned(false);
                      setActiveId(null);
                    }}
                    className='p-0.5 rounded hover:bg-[var(--ui-chip-hover-bg)] text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] transition-colors'
                    title='关闭'
                  >
                    <X size={12} />
                  </button>
                </div>
              )}

              {activeItem.isError ? (
                <div className='p-3.5 text-xs text-[var(--ui-accent-rose)] font-mono bg-[var(--ui-code-bg)]'>
                  <div className='font-semibold mb-1'>
                    {activeItem.filePath || activeItem.fileName} 执行失败
                  </div>
                  <div className='opacity-80 whitespace-pre-wrap'>
                    {activeItem.errorMsg || '未知修改错误'}
                  </div>
                </div>
              ) : (
                <SplitDiffViewer
                  oldText={activeItem.oldText}
                  newText={activeItem.newText}
                  filePath={activeItem.filePath || activeItem.fileName}
                  isNewFile={activeItem.isNewFile}
                  noSnapshot={activeItem.noSnapshot}
                  actionLabel={activeItem.actionLabel}
                  embedded
                  maxBodyHeightPx={coords.maxBodyHeight}
                />
              )}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
};

/**
 * OpenCode / Claude Code 风格底部实时执行状态条 (固定在会话流最下方)
 * 让用户在任务执行全过程中清晰感知当前动作、所处阶段与实时耗时
 */
const AgentLiveStatusBar: React.FC<{
  activeToolCalls: ToolStatusEvent[];
  activeTodos: TodoItem[];
  hasStreamingText: boolean;
}> = ({ activeToolCalls, activeTodos, hasStreamingText }) => {
  const [elapsedSec, setElapsedSec] = useState(0);

  useEffect(() => {
    setElapsedSec(0);
    const timer = setInterval(() => {
      setElapsedSec((s) => s + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const visibleSteps = activeToolCalls.filter((t) => t.tool !== 'todo_write');
  const runningStep = visibleSteps.slice().reverse().find((t) => t.status === 'running');
  const latestStep = visibleSteps[visibleSteps.length - 1];
  const currentTodo = activeTodos.find((t) => t.status === 'in_progress');

  let statusText = '正在深入思考与规划方案...';
  if (runningStep) {
    const { title, subtitle } = getToolStepSummary(runningStep.tool, runningStep.args);
    statusText = `正在${title}${subtitle ? ` (${subtitle})` : ''}...`;
  } else if (hasStreamingText) {
    statusText = '正在流式生成分析与代码回复...';
  } else if (latestStep) {
    const { title } = getToolStepSummary(latestStep.tool, latestStep.args);
    statusText = `已完成${title}，正在推进下一步...`;
  }

  const formatTimer = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m > 0 ? `${m}m ${s < 10 ? '0' : ''}${s}s` : `${s}s`;
  };

  return (
    <div className='sticky bottom-0 z-10 pt-1 pb-0.5 w-full pointer-events-none'>
      <div className='relative w-full px-3.5 py-2 rounded-xl backdrop-blur-md shadow-sm border border-[color:var(--ui-border-hairline)] bg-[var(--ui-livebar-bg)] flex items-center justify-between gap-3 text-xs select-none overflow-hidden'>
        {/* 一圈光晕紧贴 border 边框顺时针匀速巡航流光 (Border Beam) */}
        <svg
          className='absolute inset-0 w-full h-full pointer-events-none overflow-visible'
          xmlns='http://www.w3.org/2000/svg'
        >
          <defs>
            <linearGradient id='livebar-beam-grad' x1='0%' y1='0%' x2='100%' y2='100%'>
              <stop offset='0%' stopColor='#38bdf8' stopOpacity='0' />
              <stop offset='25%' stopColor='#60a5fa' stopOpacity='0.4' />
              <stop offset='70%' stopColor='#93c5fd' stopOpacity='1' />
              <stop offset='100%' stopColor='#38bdf8' stopOpacity='0' />
            </linearGradient>
          </defs>
          {/* 底层高斯光晕 (沿边框发散) */}
          <rect
            rx='12'
            fill='none'
            stroke='url(#livebar-beam-grad)'
            strokeWidth='3'
            pathLength='100'
            className='omcx-border-beam-glow'
            style={{ width: 'calc(100% - 2px)', height: 'calc(100% - 2px)', x: 1, y: 1 }}
          />
          {/* 顶层高亮细线光核 (精准贴边顺时针流转) */}
          <rect
            rx='12'
            fill='none'
            stroke='url(#livebar-beam-grad)'
            strokeWidth='1.5'
            pathLength='100'
            className='omcx-border-beam-core'
            style={{ width: 'calc(100% - 2px)', height: 'calc(100% - 2px)', x: 1, y: 1 }}
          />
        </svg>

        {/* 左侧：微光呼吸图标 + 当前实时动作语义 (已移除雷达同心圆扩散) */}
        <div className='flex items-center gap-2.5 min-w-0 relative z-10'>
          <div className='relative flex items-center justify-center w-4 h-4 flex-shrink-0'>
            <Sparkles size={13} className='text-[var(--ui-accent-blue)] omcx-icon-pulse-glow' />
          </div>
          <span className='font-medium text-[var(--ui-text-primary)] truncate'>{statusText}</span>
        </div>

        {/* 右侧：当前 Todo 阶段 + 步骤计数 + 实时秒表 */}
        <div className='flex items-center gap-2 flex-shrink-0 font-mono text-[11px] relative z-10'>
          {currentTodo && (
            <span className='hidden sm:inline-block px-2 py-0.5 rounded bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)] border border-[color:var(--ui-accent-blue-border)] truncate max-w-[180px]'>
              阶段: {currentTodo.text}
            </span>
          )}
          {visibleSteps.length > 0 && (
            <span className='px-1.5 py-0.5 rounded bg-[var(--ui-chip-bg)] text-[var(--ui-text-muted)] border border-[color:var(--ui-border-hairline)]'>
              步骤 {visibleSteps.length}
            </span>
          )}
          <span className='text-[var(--ui-accent-blue)] font-semibold min-w-[36px] text-right'>
            {formatTimer(elapsedSec)}
          </span>
        </div>
      </div>
    </div>
  );
};

/**
 * 网页引用来源折叠卡片
 */
const ReferenceLinks: React.FC<{ metadata: any[] }> = ({ metadata }) => (
  <div className='mb-1.5 w-full max-w-full'>
    <details className='group bg-[var(--ui-block-bg)] rounded-xl border border-[color:var(--ui-border-hairline)] hover:border-[color:var(--ui-border-subtle)] text-xs overflow-hidden transition-colors'>
      <summary className='flex items-center justify-between p-2.5 font-medium text-[var(--ui-text-muted)] cursor-pointer hover:bg-[var(--ui-block-hover-bg)] outline-none select-none transition-colors'>
        <div className='flex items-center gap-1.5'>
          <Globe size={13} className='text-[var(--ui-accent-blue)]' />
          <span>参考权威来源 ({metadata.length})</span>
        </div>
        <span className='text-[10px] text-[var(--ui-text-faint)] transition-transform duration-200 group-open:rotate-180'>
          ▼
        </span>
      </summary>
      <div className='p-2.5 border-t border-[color:var(--ui-divider-hairline)] space-y-1.5 bg-[var(--ui-block-body-bg)]'>
        {metadata.map((ref: any, idx: number) => {
          let hostname = '';
          try {
            hostname = new URL(ref.url).hostname;
          } catch {
            hostname = 'link';
          }
          return (
            <a
              key={idx}
              href={ref.url}
              target='_blank'
              rel='noopener noreferrer'
              className='flex items-center justify-between hover:bg-[var(--ui-accent-blue-soft)] p-1.5 rounded-lg text-[var(--ui-text-secondary)] hover:text-[var(--ui-accent-blue)] transition-all font-medium border border-transparent hover:border-[color:var(--ui-accent-blue-border)] group/link'
            >
              <span className='truncate max-w-[80%] flex items-center gap-1.5'>
                <span className='w-4 h-4 rounded-full bg-[var(--ui-chip-bg)] text-[10px] flex items-center justify-center font-bold text-[var(--ui-accent-blue)] flex-shrink-0'>
                  {idx + 1}
                </span>
                <span className='truncate font-sans text-xs'>{ref.title || ref.url}</span>
              </span>
              <span className='text-[10px] text-[var(--ui-text-faint)] font-mono group-hover/link:text-[var(--ui-accent-blue)]'>
                {hostname} ↗
              </span>
            </a>
          );
        })}
      </div>
    </details>
  </div>
);

const MessageBubble: React.FC<{
  msg: Message;
  isLast: boolean;
  activeToolCalls: ToolStatusEvent[];
  activeTodos?: TodoItem[];
  containerWidth: number;
  onCopy: (text: string) => void;
  onRetry: (msg: Message) => void;
  isGenerating: boolean;
}> = ({
  msg,
  isLast,
  activeToolCalls,
  activeTodos,
  onCopy,
  onRetry,
  isGenerating,
}) => {
  const [copied, setCopied] = useState(false);

  const handleCopyText = () => {
    onCopy(msg.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const isUser = msg.role === 'user';
  const durationFormatted = msg.metadata?.durationFormatted;
  const hasContent = Boolean(msg.content && msg.content.trim().length > 0);

  const { thinkingBlocks, isThinkingStreaming, markdownContent } = useMemo(
    () => (isUser ? { thinkingBlocks: [], isThinkingStreaming: false, markdownContent: msg.content } : parseMessageContent(msg.content)),
    [isUser, msg.content]
  );
  const hasVisibleMarkdown = Boolean(markdownContent && markdownContent.trim().length > 0);

  const displayToolEvents =
    !isUser && activeToolCalls.length > 0 && isLast
      ? activeToolCalls
      : Array.isArray(msg.metadata?.toolSteps)
      ? msg.metadata.toolSteps
      : [];

  const displayTodos: TodoItem[] =
    !isUser && activeTodos && activeTodos.length > 0 && isLast
      ? activeTodos
      : Array.isArray(msg.metadata?.todos)
      ? msg.metadata.todos
      : [];

  return (
    <div className={`group flex w-full ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} w-full max-w-full min-w-0`}>
        {/* Assistant 回复顶端：用时展示指示条 */}
        {!isUser && durationFormatted && (
          <div className='flex items-center gap-1 text-[11px] text-[var(--ui-text-faint)] font-mono mb-1.5 px-1 select-none hover:text-[var(--ui-text-muted)] transition-colors'>
            <Clock size={11} className='text-[var(--ui-text-faint)]' />
            <span>用时 {durationFormatted}</span>
            <ChevronRight size={11} className='opacity-70' />
          </div>
        )}

        {/* 1. 深度思考内容块（置顶于工具调用块上方） */}
        {!isUser && thinkingBlocks.length > 0 && (
          <ThinkingBlock
            thoughts={thinkingBlocks}
            isStreaming={isThinkingStreaming}
            className='mb-1.5'
          />
        )}

        {/* 2. 工具执行步进紧凑组件 */}
        {!isUser && displayToolEvents.length > 0 && (
          <ToolStepList events={displayToolEvents} />
        )}

        {/* 3. 独立外显的文件变更展示区（Hover 在对应位置吸附弹出左右分块 Diff） */}
        {!isUser && displayToolEvents.length > 0 && (
          <ModifiedFilesBar events={displayToolEvents} />
        )}

        {/* 4. 任务规划进度条面板（默认展开） */}
        {!isUser && displayTodos.length > 0 && (
          <TodoListCard todos={displayTodos} isActive={Boolean(isGenerating && isLast)} />
        )}

        {/* 5. 网页权威引用来源 */}
        {!isUser && Array.isArray(msg.metadata?.sources) && msg.metadata.sources.length > 0 && (
          <ReferenceLinks metadata={msg.metadata.sources} />
        )}

        {/* 用户消息附带的文件/图片附件展示 */}
        {isUser && Array.isArray(msg.metadata?.attachments) && msg.metadata.attachments.length > 0 && (
          <div className='flex flex-wrap gap-2 justify-end mb-2 max-w-[85%]'>
            {msg.metadata.attachments.map((att: any) => {
              const isImg = isImageAttachment(att.name || '', att.mime || '');
              const category = classifyAttachment(att.name || '', att.mime || '');

              if (isImg) {
                return (
                  <button
                    key={att.id || att.path}
                    onClick={() => window.electronAPI?.showInFolder?.(att.path)}
                    className='w-24 h-24 rounded-xl overflow-hidden border border-[color:var(--ui-border-hairline)] bg-[var(--ui-card-inner-bg)] hover:border-[color:var(--ui-accent-blue-border)] transition-colors cursor-pointer flex-shrink-0 shadow-sm'
                    title={`${att.name || '图片'} (${formatFileSize(att.size)}) · 点击在 Finder 中显示`}
                  >
                    <img
                      src={`local-media://${encodeURI(att.path)}`}
                      alt={att.name || '图片'}
                      className='w-full h-full object-cover'
                    />
                  </button>
                );
              }

              return (
                <button
                  key={att.id || att.path}
                  onClick={() => window.electronAPI?.showInFolder?.(att.path)}
                  className='flex items-center gap-2.5 px-3 py-2 rounded-xl border border-[color:var(--ui-border-hairline)] bg-[var(--ui-card-inner-bg)] hover:bg-[var(--ui-block-hover-bg)] hover:border-[color:var(--ui-accent-blue-border)] transition-all cursor-pointer shadow-sm text-left max-w-[240px]'
                  title={`${att.name} (${formatFileSize(att.size)}) · 点击在 Finder 中显示`}
                >
                  <div className='w-7 h-7 rounded-lg bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)] flex items-center justify-center flex-shrink-0'>
                    {category === 'spreadsheet' && (
                      <FileSpreadsheet size={15} className='text-[var(--ui-accent-emerald)]' />
                    )}
                    {category === 'text' && (
                      <FileCode size={15} className='text-[var(--ui-accent-blue)]' />
                    )}
                    {category === 'document' && (
                      <FileText size={15} className='text-[var(--ui-accent-rose)]' />
                    )}
                    {category === 'archive' && (
                      <FileArchive size={15} className='text-[var(--ui-accent-amber)]' />
                    )}
                    {category === 'binary' && (
                      <GenericFileIcon size={15} className='text-[var(--ui-accent-purple)]' />
                    )}
                  </div>
                  <div className='flex flex-col min-w-0'>
                    <span className='text-xs font-medium text-[var(--ui-text-primary)] truncate'>
                      {att.name}
                    </span>
                    <span className='text-[10px] text-[var(--ui-text-faint)] font-mono'>
                      {formatFileSize(att.size)}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {/* 气泡本体 */}
        {isUser ? (
          <div className='px-4 py-2.5 text-sm leading-relaxed break-words bg-[var(--ui-bubble-user-bg)] text-[var(--ui-text-primary)] border border-[color:var(--ui-border-hairline)] rounded-2xl whitespace-pre-wrap font-sans max-w-[85%]'>
            {msg.content}
          </div>
        ) : hasVisibleMarkdown ? (
          <div className='px-5 py-3.5 text-sm leading-relaxed break-words bg-[var(--ui-bubble-assistant-bg)] text-[var(--ui-text-primary)] border border-[color:var(--ui-border-hairline)] rounded-2xl w-full'>
            <MarkdownContent content={markdownContent} hideThinking />
          </div>
        ) : null}

        {/* 悬浮操作栏 */}
        {(hasContent || isUser) && (
          <div className='flex gap-1.5 mt-1 px-1 opacity-0 group-hover:opacity-100 transition-opacity'>
            <button
              onClick={handleCopyText}
              className='p-1 hover:bg-[var(--ui-chip-hover-bg)] rounded-md text-[var(--ui-text-faint)] hover:text-[var(--ui-text-secondary)] transition-colors flex items-center gap-1 text-[11px]'
              title='复制内容'
            >
              {copied ? <Check size={11} className='text-[var(--ui-accent-emerald)]' /> : <Copy size={11} />}
              {copied && <span className='text-[10px] text-[var(--ui-accent-emerald)]'>已复制</span>}
            </button>
            {!isUser && (
              <button
                onClick={() => onRetry(msg)}
                className='p-1 hover:bg-[var(--ui-chip-hover-bg)] rounded-md text-[var(--ui-text-faint)] hover:text-[var(--ui-text-secondary)] transition-colors'
                title='重新生成'
              >
                <RotateCw size={11} />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export const MessageList: React.FC<Props> = ({
  messages,
  isGenerating,
  activeToolCalls,
  activeTodos = [],
  onCopy,
  onRetry,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isGenerating, activeToolCalls]);

  useEffect(() => {
    if (!scrollRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    observer.observe(scrollRef.current);
    return () => observer.disconnect();
  }, []);

  const lastMessage = messages[messages.length - 1];
  const hasStreamingText = Boolean(
    lastMessage && lastMessage.role === 'assistant' && lastMessage.content?.trim()
  );

  return (
    <div
      ref={scrollRef}
      className='flex-1 overflow-y-auto px-5 py-5 flex flex-col gap-5 custom-scrollbar min-h-0 relative'
    >
      {messages.map((msg, idx) => (
        <MessageBubble
          key={msg.id}
          msg={msg}
          isLast={idx === messages.length - 1}
          activeToolCalls={idx === messages.length - 1 ? activeToolCalls : []}
          activeTodos={idx === messages.length - 1 ? activeTodos : []}
          containerWidth={containerWidth}
          onCopy={onCopy}
          onRetry={onRetry}
          isGenerating={isGenerating}
        />
      ))}

      {/* 会话最下方：OpenCode / Claude Code 风格实时任务执行状态条 */}
      {isGenerating && (
        <AgentLiveStatusBar
          activeToolCalls={activeToolCalls}
          activeTodos={activeTodos}
          hasStreamingText={hasStreamingText}
        />
      )}
    </div>
  );
};

export default MessageList;
