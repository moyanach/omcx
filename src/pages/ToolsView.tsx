import React, { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Sparkles, Network, Wrench, Bot } from 'lucide-react';
import { useChatStore, SkillItem, SubagentItem } from '@/stores/chatStore';
import { SkillsTab } from './tools/SkillsTab';
import { SubagentsTab } from './tools/SubagentsTab';
import { McpServersTab } from './tools/McpServersTab';
import { ToolDetailModals } from './tools/ToolDetailModals';

export const ToolsView: React.FC = () => {
  const { skills, mcpServers, subagents, refreshMcpAndSkills, sessions, activeSessionId } =
    useChatStore(
      useShallow((s) => ({
        skills: s.skills,
        mcpServers: s.mcpServers,
        subagents: s.subagents,
        refreshMcpAndSkills: s.refreshMcpAndSkills,
        sessions: s.sessions,
        activeSessionId: s.activeSessionId,
      }))
    );
  const activeSession = sessions.find((s) => s.id === activeSessionId);

  const [activeTab, setActiveTab] = useState<'skills' | 'subagents' | 'mcp'>('skills');
  const [inspectingSkill, setInspectingSkill] = useState<SkillItem | null>(null);
  const [inspectingSubagent, setInspectingSubagent] = useState<SubagentItem | null>(null);

  return (
    <div className='flex-1 h-full flex flex-col bg-[var(--ui-panel-bg)] backdrop-blur-xl backdrop-saturate-150 overflow-hidden text-[var(--ui-text-primary)] select-none'>
      {/* 顶部 Header */}
      <div className='h-[56px] border-b border-[color:var(--ui-divider-hairline)] bg-transparent px-6 flex items-center justify-between flex-shrink-0 titlebar-drag'>
        <div className='flex items-center gap-3'>
          <div className='w-8 h-8 rounded-xl bg-[var(--ui-accent-blue-soft)] border border-[color:var(--ui-accent-blue-border)] flex items-center justify-center text-[var(--ui-accent-blue)]'>
            <Wrench size={16} />
          </div>
          <div>
            <h1 className='text-sm font-semibold text-[var(--ui-text-primary)]'>工具与技能中心</h1>
            <p className='text-[11px] text-[var(--ui-text-muted)]'>
              管理 Agent 声明式技能、子代理与标准 MCP 外部连接器
            </p>
          </div>
        </div>
      </div>

      {/* 主工作台内容区 */}
      <div className='flex-1 overflow-y-auto p-5 md:p-6 custom-scrollbar'>
        <div className='flex flex-col gap-4 max-w-6xl mx-auto'>
          {/* 内容区主控台卡片：单层微透表面与外层主题面板自然融合 */}
          <div className='rounded-2xl bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-subtle)] px-5 py-3.5 shadow-sm flex flex-wrap items-center justify-between gap-4'>
            <div className='min-w-0 flex-1'>
              <h2 className='text-sm font-bold text-[var(--ui-text-primary)] truncate'>
                {activeTab === 'skills'
                  ? '声明式技能扩展 (Declared Skills)'
                  : activeTab === 'subagents'
                  ? '专家子代理与并行分治引擎 (Autonomous & Parallel Subagents)'
                  : '模型上下文协议服务节点 (Model Context Protocol Servers)'}
              </h2>
              <p className='text-[11px] text-[var(--ui-text-secondary)] mt-0.5 truncate'>
                {activeTab === 'skills'
                  ? '支持 ~/.agents/skills 与当前项目 .agents/skills，任务匹配时按需读取指令'
                  : activeTab === 'subagents'
                  ? '主 Agent 根据任务复杂度自动调度或并行扇出 (Fan-out)，同时支持 ~/.omcx/agents/*.md 自定义扩展与 @agent: 点名'
                  : '标准协议驱动，完全兼容 Claude Desktop / Cursor 配置文件 (~/.omcx/mcp.json)'}
              </p>
            </div>

            {/* 三 Tab 切换器 */}
            <div className='flex items-center gap-1 bg-[var(--ui-card-inner-bg)] p-1 rounded-xl border border-[color:var(--ui-border-hairline)] flex-shrink-0'>
              <button
                onClick={() => setActiveTab('skills')}
                className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs transition-all cursor-pointer ${
                  activeTab === 'skills'
                    ? 'bg-blue-600 text-white font-semibold shadow-sm'
                    : 'text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-block-hover-bg)]'
                }`}
              >
                <Sparkles
                  size={14}
                  className={activeTab === 'skills' ? 'text-yellow-300' : 'text-[var(--ui-accent-amber)]'}
                />
                <span>技能扩展 (Skills)</span>
                <span
                  className={`px-1.5 py-0.2 rounded-full text-[10px] font-mono ${
                    activeTab === 'skills'
                      ? 'bg-white/20 text-white'
                      : 'bg-[var(--ui-chip-bg)] text-[var(--ui-text-muted)]'
                  }`}
                >
                  {skills.length}
                </span>
              </button>
              <button
                onClick={() => setActiveTab('subagents')}
                className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs transition-all cursor-pointer ${
                  activeTab === 'subagents'
                    ? 'bg-blue-600 text-white font-semibold shadow-sm'
                    : 'text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-block-hover-bg)]'
                }`}
              >
                <Bot
                  size={14}
                  className={activeTab === 'subagents' ? 'text-sky-200' : 'text-[var(--ui-accent-sky)]'}
                />
                <span>子代理 (Subagents)</span>
                <span
                  className={`px-1.5 py-0.2 rounded-full text-[10px] font-mono ${
                    activeTab === 'subagents'
                      ? 'bg-white/20 text-white'
                      : 'bg-[var(--ui-chip-bg)] text-[var(--ui-text-muted)]'
                  }`}
                >
                  {subagents.length}
                </span>
              </button>
              <button
                onClick={() => setActiveTab('mcp')}
                className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs transition-all cursor-pointer ${
                  activeTab === 'mcp'
                    ? 'bg-blue-600 text-white font-semibold shadow-sm'
                    : 'text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-block-hover-bg)]'
                }`}
              >
                <Network
                  size={14}
                  className={activeTab === 'mcp' ? 'text-emerald-200' : 'text-[var(--ui-accent-emerald)]'}
                />
                <span>MCP 服务器 (MCP)</span>
                <span
                  className={`px-1.5 py-0.2 rounded-full text-[10px] font-mono ${
                    activeTab === 'mcp'
                      ? 'bg-white/20 text-white'
                      : 'bg-[var(--ui-chip-bg)] text-[var(--ui-text-muted)]'
                  }`}
                >
                  {mcpServers.length}
                </span>
              </button>
            </div>
          </div>

          {/* ═════════ 1. SKILLS 视图 ═════════ */}
        {activeTab === 'skills' && (
          <SkillsTab
            skills={skills}
            workDir={activeSession?.workDir}
            refreshMcpAndSkills={refreshMcpAndSkills}
            onInspectSkill={setInspectingSkill}
          />
        )}

        {activeTab === 'subagents' && (
          <SubagentsTab
            subagents={subagents}
            onInspectSubagent={setInspectingSubagent}
          />
        )}

        {activeTab === 'mcp' && (
          <McpServersTab
            mcpServers={mcpServers}
            workDir={activeSession?.workDir}
            refreshMcpAndSkills={refreshMcpAndSkills}
          />
        )}
        </div>
      </div>

      <ToolDetailModals
        inspectingSkill={inspectingSkill}
        inspectingSubagent={inspectingSubagent}
        onCloseSkill={() => setInspectingSkill(null)}
        onCloseSubagent={() => setInspectingSubagent(null)}
      />
    </div>
  );
};

export default ToolsView;
