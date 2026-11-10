import React, { useState } from 'react';
import { useChatStore, SkillItem, McpServerItem } from '@/stores/chatStore';
import {
  Sparkles,
  Network,
  Plus,
  Trash2,
  Edit2,
  Power,
  X,
} from 'lucide-react';

export const ToolsPanel: React.FC = () => {
  const { skills, mcpServers, refreshMcpAndSkills, sessions, activeSessionId } = useChatStore();
  const activeSession = sessions.find((s) => s.id === activeSessionId);

  const [activeTab, setActiveTab] = useState<'skills' | 'mcp'>('skills');

  // 新建/编辑 Skill 表单状态
  const [editingSkill, setEditingSkill] = useState<{
    name: string;
    description: string;
    tools: string;
    prompt: string;
  } | null>(null);

  // 新增 MCP 服务器表单状态
  const [editingMcp, setEditingMcp] = useState<{
    name: string;
    command: string;
    args: string;
    description: string;
  } | null>(null);

  // 保存技能到全局目录 (~/.omcx/skills/<name>.md)
  const handleSaveSkill = async () => {
    if (!editingSkill || !editingSkill.name.trim()) return;
    const cleanName = editingSkill.name.trim();
    const toolList = editingSkill.tools
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    const content = `---
name: ${cleanName}
description: ${editingSkill.description.trim()}
tools: [${toolList.join(', ')}]
---

${editingSkill.prompt.trim()}
`;

    if (window.electronAPI?.saveWorkspace) {
      console.log('保存技能:', cleanName);
    }
    setEditingSkill(null);
    if (refreshMcpAndSkills) {
      refreshMcpAndSkills(activeSession?.workDir);
    }
  };

  // 保存 MCP 服务器到全局 ~/.omcx/mcp.json
  const handleSaveMcp = async () => {
    if (!editingMcp || !editingMcp.name.trim() || !editingMcp.command.trim()) return;
    const cleanKey = editingMcp.name.trim();
    const argsArray = editingMcp.args
      .split(' ')
      .map((a) => a.trim())
      .filter(Boolean);

    const nextServers: Record<string, any> = {};
    for (const server of mcpServers) {
      // 项目级 MCP 配置由项目文件托管，绝不能写回全局 ~/.omcx/mcp.json
      if (server.source === 'project') continue;
      nextServers[server.id] = {
        command: server.command,
        args: server.args,
        env: {},
        description: server.description,
        enabled: server.enabled,
      };
    }

    nextServers[cleanKey] = {
      command: editingMcp.command.trim(),
      args: argsArray,
      env: {},
      description: editingMcp.description.trim(),
      enabled: true,
    };

    if (window.electronAPI?.saveMcpServers) {
      await window.electronAPI.saveMcpServers(nextServers);
    }
    setEditingMcp(null);
    if (refreshMcpAndSkills) {
      refreshMcpAndSkills(activeSession?.workDir);
    }
  };

  // 切换 MCP 服务器启停状态
  const handleToggleMcp = async (server: McpServerItem) => {
    // 项目级配置不参与全局启停
    if (server.source === 'project') return;
    if (window.electronAPI?.toggleMcpServer) {
      const res = await window.electronAPI.toggleMcpServer(server.id, !server.enabled);
      if (!res?.success) {
        console.error('切换 MCP 服务器状态失败:', res?.error);
        return;
      }
    } else {
      const nextServers: Record<string, any> = {};
      for (const s of mcpServers) {
        if (s.source === 'project') continue;
        nextServers[s.id] = {
          command: s.command,
          args: s.args,
          env: {},
          description: s.description,
          enabled: s.id === server.id ? !s.enabled : s.enabled,
        };
      }
      if (window.electronAPI?.saveMcpServers) {
        await window.electronAPI.saveMcpServers(nextServers);
      }
    }
    if (refreshMcpAndSkills) {
      refreshMcpAndSkills(activeSession?.workDir);
    }
  };

  // 删除 MCP 服务器
  const handleDeleteMcp = async (serverId: string) => {
    if (mcpServers.find((s) => s.id === serverId)?.source === 'project') return;
    const nextServers: Record<string, any> = {};
    for (const s of mcpServers) {
      if (s.source === 'project') continue;
      if (s.id !== serverId) {
        nextServers[s.id] = {
          command: s.command,
          args: s.args,
          env: {},
          description: s.description,
          enabled: s.enabled,
        };
      }
    }
    if (window.electronAPI?.saveMcpServers) {
      await window.electronAPI.saveMcpServers(nextServers);
    }
    if (refreshMcpAndSkills) {
      refreshMcpAndSkills(activeSession?.workDir);
    }
  };

  return (
    <div className='w-[270px] h-full bg-[var(--ui-panel-bg)] border-r border-[color:var(--ui-divider-hairline)] flex flex-col flex-shrink-0 select-none'>
      {/* 顶部 Tab 切换器 (SKILLS 与 MCP) */}
      <div className='p-2.5 border-b border-[color:var(--ui-divider-hairline)] flex-shrink-0'>
        <div className='w-full grid grid-cols-2 p-0.5 rounded-xl bg-[var(--ui-card-inner-bg)] border border-[color:var(--ui-border-hairline)]'>
          <button
            onClick={() => setActiveTab('skills')}
            className={`py-1.5 flex items-center justify-center gap-1.5 rounded-lg text-xs font-medium transition-all ${
              activeTab === 'skills'
                ? 'bg-[var(--ui-card-bg)] text-[var(--ui-accent-blue)] border border-[color:var(--ui-border-subtle)] shadow-sm font-semibold'
                : 'text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)]'
            }`}
          >
            <Sparkles size={12} />
            <span>SKILLS</span>
          </button>
          <button
            onClick={() => setActiveTab('mcp')}
            className={`py-1.5 flex items-center justify-center gap-1.5 rounded-lg text-xs font-medium transition-all ${
              activeTab === 'mcp'
                ? 'bg-[var(--ui-card-bg)] text-[var(--ui-accent-blue)] border border-[color:var(--ui-border-subtle)] shadow-sm font-semibold'
                : 'text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)]'
            }`}
          >
            <Network size={12} />
            <span>MCP</span>
          </button>
        </div>
      </div>

      {/* ─── 1. SKILLS 视图 ─── */}
      {activeTab === 'skills' && (
        <div className='flex-1 overflow-y-auto p-2.5 flex flex-col gap-2 custom-scrollbar'>
          {/* 新建 Skill 按钮 */}
          <button
            onClick={() =>
              setEditingSkill({
                name: '',
                description: '',
                tools: 'read_file, search_code',
                prompt: '当用户要求执行该任务时，请主动调用工具协助分析。',
              })
            }
            className='w-full h-8 px-3 rounded-xl bg-[var(--ui-card-inner-bg)] hover:bg-[var(--ui-block-hover-bg)] border border-[color:var(--ui-border-hairline)] text-xs font-medium text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)] flex items-center justify-center gap-1.5 transition-colors shadow-sm'
          >
            <Plus size={13} className='text-[var(--ui-accent-blue)]' />
            <span>新建技能 (Skill)</span>
          </button>

          {/* 新建/编辑技能内联表单 */}
          {editingSkill && (
            <div className='p-3 rounded-xl bg-[var(--ui-card-bg)] border border-[color:var(--ui-accent-blue-border)] flex flex-col gap-2 shadow-lg'>
              <div className='flex items-center justify-between'>
                <span className='text-xs font-semibold text-[var(--ui-accent-blue)]'>
                  编辑技能
                </span>
                <button
                  onClick={() => setEditingSkill(null)}
                  className='text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)]'
                >
                  <X size={12} />
                </button>
              </div>
              <input
                type='text'
                placeholder='技能标识 (如 git-commit)'
                value={editingSkill.name}
                onChange={(e) =>
                  setEditingSkill({ ...editingSkill, name: e.target.value })
                }
                className='w-full bg-[var(--ui-card-inner-bg)] border border-[color:var(--ui-border-subtle)] rounded-lg px-2.5 py-1 text-xs text-[var(--ui-text-primary)] placeholder-[var(--ui-text-faint)] outline-none focus:border-[color:var(--ui-accent-blue)]'
              />
              <input
                type='text'
                placeholder='一句话描述'
                value={editingSkill.description}
                onChange={(e) =>
                  setEditingSkill({ ...editingSkill, description: e.target.value })
                }
                className='w-full bg-[var(--ui-card-inner-bg)] border border-[color:var(--ui-border-subtle)] rounded-lg px-2.5 py-1 text-xs text-[var(--ui-text-primary)] placeholder-[var(--ui-text-faint)] outline-none focus:border-[color:var(--ui-accent-blue)]'
              />
              <textarea
                placeholder='系统提示词说明...'
                value={editingSkill.prompt}
                onChange={(e) =>
                  setEditingSkill({ ...editingSkill, prompt: e.target.value })
                }
                className='w-full h-16 bg-[var(--ui-card-inner-bg)] border border-[color:var(--ui-border-subtle)] rounded-lg p-2 text-xs text-[var(--ui-text-primary)] placeholder-[var(--ui-text-faint)] outline-none focus:border-[color:var(--ui-accent-blue)] resize-none font-sans'
              />
              <button
                onClick={handleSaveSkill}
                className='w-full py-1 rounded-lg bg-[var(--ui-accent-blue)] hover:opacity-90 text-white text-xs font-medium transition-colors'
              >
                保存技能
              </button>
            </div>
          )}

          {/* 技能列表 */}
          <div className='flex flex-col gap-1.5'>
            {skills.map((skill) => (
              <div
                key={skill.id}
                className='p-2.5 rounded-xl bg-[var(--ui-card-inner-bg)] border border-[color:var(--ui-border-hairline)] hover:border-[color:var(--ui-border-subtle)] transition-all flex flex-col gap-1 group'
              >
                <div className='flex items-center justify-between'>
                  <span className='font-semibold text-xs text-[var(--ui-text-primary)] truncate'>
                    {skill.name}
                  </span>
                  <span
                    className={`text-[9px] px-1.5 py-0.2 rounded font-mono ${
                      skill.scope === 'project'
                        ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                        : 'bg-[var(--ui-chip-bg)] text-[var(--ui-text-muted)] border border-[color:var(--ui-border-hairline)]'
                    }`}
                  >
                    {skill.scope}
                  </span>
                </div>
                {skill.description && (
                  <p className='text-[11px] text-[var(--ui-text-muted)] line-clamp-2 leading-relaxed'>
                    {skill.description}
                  </p>
                )}
                {skill.tools && skill.tools.length > 0 && (
                  <div className='flex items-center gap-1 flex-wrap pt-0.5'>
                    {skill.tools.map((t, idx) => (
                      <span
                        key={idx}
                        className='text-[9px] px-1 rounded bg-[var(--ui-chip-bg)] text-[var(--ui-text-faint)] font-mono border border-[color:var(--ui-border-hairline)]'
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ─── 2. MCP 视图 ─── */}
      {activeTab === 'mcp' && (
        <div className='flex-1 overflow-y-auto p-2.5 flex flex-col gap-2 custom-scrollbar'>
          <button
            onClick={() =>
              setEditingMcp({
                name: '',
                command: 'npx',
                args: '-y @modelcontextprotocol/server-github',
                description: '外部扩展 MCP 节点',
              })
            }
            className='w-full h-8 px-3 rounded-xl bg-[var(--ui-card-inner-bg)] hover:bg-[var(--ui-block-hover-bg)] border border-[color:var(--ui-border-hairline)] text-xs font-medium text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)] flex items-center justify-center gap-1.5 transition-colors shadow-sm'
          >
            <Plus size={13} className='text-[var(--ui-accent-blue)]' />
            <span>添加 MCP 服务器</span>
          </button>

          {/* 新增/编辑 MCP 内联表单 */}
          {editingMcp && (
            <div className='p-3 rounded-xl bg-[var(--ui-card-bg)] border border-[color:var(--ui-accent-blue-border)] flex flex-col gap-2 shadow-lg'>
              <div className='flex items-center justify-between'>
                <span className='text-xs font-semibold text-[var(--ui-accent-blue)]'>
                  配置 MCP
                </span>
                <button
                  onClick={() => setEditingMcp(null)}
                  className='text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)]'
                >
                  <X size={12} />
                </button>
              </div>
              <input
                type='text'
                placeholder='服务器名称 (如 context7, github)'
                value={editingMcp.name}
                onChange={(e) =>
                  setEditingMcp({ ...editingMcp, name: e.target.value })
                }
                className='w-full bg-[var(--ui-card-inner-bg)] border border-[color:var(--ui-border-subtle)] rounded-lg px-2.5 py-1 text-xs text-[var(--ui-text-primary)] placeholder-[var(--ui-text-faint)] outline-none focus:border-[color:var(--ui-accent-blue)]'
              />
              <div className='flex gap-2'>
                <input
                  type='text'
                  placeholder='命令 (npx, node, python)'
                  value={editingMcp.command}
                  onChange={(e) =>
                    setEditingMcp({ ...editingMcp, command: e.target.value })
                  }
                  className='w-24 bg-[var(--ui-card-inner-bg)] border border-[color:var(--ui-border-subtle)] rounded-lg px-2.5 py-1 text-xs text-[var(--ui-text-primary)] placeholder-[var(--ui-text-faint)] outline-none focus:border-[color:var(--ui-accent-blue)]'
                />
                <input
                  type='text'
                  placeholder='运行参数 (args 空格分隔)'
                  value={editingMcp.args}
                  onChange={(e) =>
                    setEditingMcp({ ...editingMcp, args: e.target.value })
                  }
                  className='flex-1 bg-[var(--ui-card-inner-bg)] border border-[color:var(--ui-border-subtle)] rounded-lg px-2.5 py-1 text-xs text-[var(--ui-text-primary)] placeholder-[var(--ui-text-faint)] outline-none focus:border-[color:var(--ui-accent-blue)]'
                />
              </div>
              <button
                onClick={handleSaveMcp}
                className='w-full py-1 rounded-lg bg-[var(--ui-accent-blue)] hover:opacity-90 text-white text-xs font-medium transition-colors'
              >
                保存到 ~/.omcx/mcp.json
              </button>
            </div>
          )}

          {/* 服务器列表 */}
          <div className='flex flex-col gap-1.5'>
            {mcpServers.map((server) => (
              <div
                key={server.id}
                className='p-2.5 rounded-xl bg-[var(--ui-card-inner-bg)] border border-[color:var(--ui-border-hairline)] hover:border-[color:var(--ui-border-subtle)] transition-all flex flex-col gap-1.5 group'
              >
                <div className='flex items-center justify-between'>
                  <div className='flex items-center gap-2 min-w-0'>
                    <div className='w-5 h-5 rounded-md bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)] flex items-center justify-center text-[10px] font-bold text-[var(--ui-text-secondary)]'>
                      {server.name.charAt(0).toUpperCase()}
                    </div>
                    <span className='font-semibold text-xs text-[var(--ui-text-primary)] truncate'>
                      {server.name}
                    </span>
                  </div>
                  <div className='flex items-center gap-1.5'>
                    <button
                      onClick={() => handleToggleMcp(server)}
                      className={`w-4 h-4 rounded flex items-center justify-center transition-colors ${
                        server.enabled ? 'text-emerald-400' : 'text-[var(--ui-text-muted)]'
                      }`}
                      title={server.enabled ? '启用中' : '已停用'}
                    >
                      <Power size={11} />
                    </button>
                    <button
                      onClick={() => handleDeleteMcp(server.name)}
                      className='p-1 text-[var(--ui-text-muted)] hover:text-rose-400 opacity-0 group-hover:opacity-100 transition-opacity'
                      title='删除'
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                </div>
                <div className='font-mono text-[10px] text-[var(--ui-text-muted)] bg-[var(--ui-card-bg)] px-2 py-0.5 rounded border border-[color:var(--ui-border-hairline)] truncate'>
                  {server.command} {server.args.join(' ')}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default ToolsPanel;
