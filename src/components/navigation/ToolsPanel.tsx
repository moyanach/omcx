import React, { useState } from 'react';
import { Sparkles, Network, Plus, Trash2, Edit3, X, Check, Power, ExternalLink } from 'lucide-react';
import { useChatStore, SkillItem, McpServerItem } from '@/stores/chatStore';

export const ToolsPanel: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'skills' | 'mcp'>('skills');
  const { skills, mcpServers, refreshMcpAndSkills, sessions, activeSessionId } = useChatStore();
  const activeSession = sessions.find((s) => s.id === activeSessionId);

  // 编辑/新建 Skill 状态
  const [editingSkill, setEditingSkill] = useState<{
    name: string;
    description: string;
    tools: string;
    prompt: string;
  } | null>(null);

  // 编辑/新建 MCP 状态
  const [editingMcp, setEditingMcp] = useState<{
    name: string;
    command: string;
    args: string;
    description: string;
  } | null>(null);

  // 保存或新建 Skill
  const handleSaveSkill = async () => {
    if (!editingSkill || !editingSkill.name.trim()) return;
    const skillContent = `---
name: ${editingSkill.name.trim()}
description: ${editingSkill.description.trim()}
tools: [${editingSkill.tools.trim()}]
---

${editingSkill.prompt.trim()}
`;
    // 通过 Electron 保存技能文件
    if (window.electronAPI?.executeTool) {
      await window.electronAPI.executeTool('write_file', {
        path: `.omcx/skills/${editingSkill.name.trim()}.md`,
        content: skillContent,
      });
      refreshMcpAndSkills(activeSession?.workDir);
    }
    setEditingSkill(null);
  };

  // 保存或新建 MCP 服务器
  const handleSaveMcp = async () => {
    if (!editingMcp || !editingMcp.name.trim()) return;
    if (window.electronAPI?.saveMcpServers) {
      const currentServersMap: Record<string, any> = {};
      mcpServers.forEach((s) => {
        currentServersMap[s.id] = {
          command: s.command,
          args: s.args,
          description: s.description,
          enabled: s.enabled,
        };
      });

      const parsedArgs = editingMcp.args
        .split(' ')
        .map((a) => a.trim())
        .filter(Boolean);

      currentServersMap[editingMcp.name.trim()] = {
        command: editingMcp.command.trim(),
        args: parsedArgs,
        description: editingMcp.description.trim(),
        enabled: true,
      };

      await window.electronAPI.saveMcpServers(currentServersMap);
      refreshMcpAndSkills(activeSession?.workDir);
    }
    setEditingMcp(null);
  };

  // 切换 MCP 启停
  const handleToggleMcp = async (server: McpServerItem) => {
    if (window.electronAPI?.saveMcpServers) {
      const currentServersMap: Record<string, any> = {};
      mcpServers.forEach((s) => {
        currentServersMap[s.id] = {
          command: s.command,
          args: s.args,
          description: s.description,
          enabled: s.id === server.id ? !s.enabled : s.enabled,
        };
      });
      await window.electronAPI.saveMcpServers(currentServersMap);
      refreshMcpAndSkills(activeSession?.workDir);
    }
  };

  // 删除 MCP 服务器
  const handleDeleteMcp = async (serverName: string) => {
    if (window.electronAPI?.saveMcpServers) {
      const currentServersMap: Record<string, any> = {};
      mcpServers
        .filter((s) => s.name !== serverName)
        .forEach((s) => {
          currentServersMap[s.id] = {
            command: s.command,
            args: s.args,
            description: s.description,
            enabled: s.enabled,
          };
        });
      await window.electronAPI.saveMcpServers(currentServersMap);
      refreshMcpAndSkills(activeSession?.workDir);
    }
  };

  return (
    <div className='w-[270px] h-full bg-[#141414] border-r border-[#222222] flex flex-col flex-shrink-0 select-none'>
      {/* 顶部 Tab 切换器 (SKILLS 与 MCP) */}
      <div className='p-2.5 border-b border-[#202020] flex-shrink-0'>
        <div className='w-full grid grid-cols-2 p-0.5 rounded-xl bg-[#1b1b1b] border border-[#2a2a2a]'>
          <button
            onClick={() => setActiveTab('skills')}
            className={`py-1.5 flex items-center justify-center gap-1.5 rounded-lg text-xs font-medium transition-all ${
              activeTab === 'skills'
                ? 'bg-[#262626] text-blue-400 border border-[#333] shadow-sm font-semibold'
                : 'text-neutral-400 hover:text-neutral-200'
            }`}
          >
            <Sparkles size={12} />
            <span>SKILLS</span>
          </button>
          <button
            onClick={() => setActiveTab('mcp')}
            className={`py-1.5 flex items-center justify-center gap-1.5 rounded-lg text-xs font-medium transition-all ${
              activeTab === 'mcp'
                ? 'bg-[#262626] text-blue-400 border border-[#333] shadow-sm font-semibold'
                : 'text-neutral-400 hover:text-neutral-200'
            }`}
          >
            <Network size={12} />
            <span>MCP</span>
          </button>
        </div>
      </div>

      {/* ─── 1. SKILLS 视图 (增删改查) ─── */}
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
            className='w-full h-8 px-3 rounded-xl bg-[#1c1c1c] hover:bg-[#242424] border border-[#2b2b2b] text-xs font-medium text-neutral-300 hover:text-white flex items-center justify-center gap-1.5 transition-colors shadow-sm'
          >
            <Plus size={13} className='text-blue-400' />
            <span>新建技能 (Skill)</span>
          </button>

          {/* 新建/编辑技能内联表单 */}
          {editingSkill && (
            <div className='p-3 rounded-xl bg-[#1e1e1e] border border-blue-500/40 flex flex-col gap-2 shadow-lg'>
              <div className='flex items-center justify-between'>
                <span className='text-xs font-semibold text-blue-400'>
                  编辑技能
                </span>
                <button
                  onClick={() => setEditingSkill(null)}
                  className='text-neutral-500 hover:text-neutral-300'
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
                className='w-full bg-[#161616] border border-[#303030] rounded-lg px-2.5 py-1 text-xs text-neutral-200 outline-none focus:border-blue-500'
              />
              <input
                type='text'
                placeholder='一句话描述'
                value={editingSkill.description}
                onChange={(e) =>
                  setEditingSkill({ ...editingSkill, description: e.target.value })
                }
                className='w-full bg-[#161616] border border-[#303030] rounded-lg px-2.5 py-1 text-xs text-neutral-200 outline-none focus:border-blue-500'
              />
              <textarea
                placeholder='系统提示词说明...'
                value={editingSkill.prompt}
                onChange={(e) =>
                  setEditingSkill({ ...editingSkill, prompt: e.target.value })
                }
                className='w-full h-16 bg-[#161616] border border-[#303030] rounded-lg p-2 text-xs text-neutral-200 outline-none focus:border-blue-500 resize-none font-sans'
              />
              <button
                onClick={handleSaveSkill}
                className='w-full py-1 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium transition-colors'
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
                className='p-2.5 rounded-xl bg-[#1a1a1a] border border-[#262626] hover:border-[#333] transition-all flex flex-col gap-1 group'
              >
                <div className='flex items-center justify-between'>
                  <div className='flex items-center gap-1.5 min-w-0'>
                    <span className='font-semibold text-xs text-neutral-200 truncate'>
                      {skill.name}
                    </span>
                    <span className='px-1.5 py-0.2 rounded text-[9px] bg-[#222] text-neutral-400 border border-[#303030]'>
                      {skill.scope}
                    </span>
                  </div>
                  <div className='flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity'>
                    <button
                      onClick={() =>
                        setEditingSkill({
                          name: skill.name,
                          description: skill.description,
                          tools: skill.tools.join(', '),
                          prompt: 'Markdown 技能',
                        })
                      }
                      className='p-1 text-neutral-500 hover:text-neutral-200'
                      title='编辑'
                    >
                      <Edit3 size={11} />
                    </button>
                  </div>
                </div>
                <p className='text-[11px] text-neutral-400 line-clamp-2 leading-relaxed'>
                  {skill.description || '无详细描述'}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ─── 2. MCP 视图 (增删改查) ─── */}
      {activeTab === 'mcp' && (
        <div className='flex-1 overflow-y-auto p-2.5 flex flex-col gap-2 custom-scrollbar'>
          {/* 新增 MCP 服务器按钮 */}
          <button
            onClick={() =>
              setEditingMcp({
                name: '',
                command: 'npx',
                args: '-y @modelcontextprotocol/server-github',
                description: '外部扩展 MCP 节点',
              })
            }
            className='w-full h-8 px-3 rounded-xl bg-[#1c1c1c] hover:bg-[#242424] border border-[#2b2b2b] text-xs font-medium text-neutral-300 hover:text-white flex items-center justify-center gap-1.5 transition-colors shadow-sm'
          >
            <Plus size={13} className='text-blue-400' />
            <span>添加 MCP 服务器</span>
          </button>

          {/* 新增/编辑 MCP 内联表单 */}
          {editingMcp && (
            <div className='p-3 rounded-xl bg-[#1e1e1e] border border-blue-500/40 flex flex-col gap-2 shadow-lg'>
              <div className='flex items-center justify-between'>
                <span className='text-xs font-semibold text-blue-400'>
                  配置 MCP
                </span>
                <button
                  onClick={() => setEditingMcp(null)}
                  className='text-neutral-500 hover:text-neutral-300'
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
                className='w-full bg-[#161616] border border-[#303030] rounded-lg px-2.5 py-1 text-xs text-neutral-200 outline-none focus:border-blue-500'
              />
              <div className='flex gap-2'>
                <input
                  type='text'
                  placeholder='命令 (npx, node, python)'
                  value={editingMcp.command}
                  onChange={(e) =>
                    setEditingMcp({ ...editingMcp, command: e.target.value })
                  }
                  className='w-24 bg-[#161616] border border-[#303030] rounded-lg px-2.5 py-1 text-xs text-neutral-200 outline-none focus:border-blue-500'
                />
                <input
                  type='text'
                  placeholder='运行参数 (args 空格分隔)'
                  value={editingMcp.args}
                  onChange={(e) =>
                    setEditingMcp({ ...editingMcp, args: e.target.value })
                  }
                  className='flex-1 bg-[#161616] border border-[#303030] rounded-lg px-2.5 py-1 text-xs text-neutral-200 outline-none focus:border-blue-500'
                />
              </div>
              <button
                onClick={handleSaveMcp}
                className='w-full py-1 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium transition-colors'
              >
                保存到 ~/.omcx/mcp.json
              </button>
            </div>
          )}

          {/* MCP 服务器列表 */}
          <div className='flex flex-col gap-1.5'>
            {mcpServers.map((server) => (
              <div
                key={server.id}
                className='p-2.5 rounded-xl bg-[#1a1a1a] border border-[#262626] hover:border-[#333] transition-all flex flex-col gap-1.5 group'
              >
                <div className='flex items-center justify-between'>
                  <div className='flex items-center gap-2 min-w-0'>
                    <div className='w-5 h-5 rounded-md bg-[#252525] border border-[#333] flex items-center justify-center text-[10px] font-bold text-neutral-300'>
                      {server.name.charAt(0).toUpperCase()}
                    </div>
                    <span className='font-semibold text-xs text-neutral-200 truncate'>
                      {server.name}
                    </span>
                  </div>
                  <div className='flex items-center gap-1.5'>
                    <button
                      onClick={() => handleToggleMcp(server)}
                      className={`w-4 h-4 rounded flex items-center justify-center transition-colors ${
                        server.enabled ? 'text-emerald-400' : 'text-neutral-500'
                      }`}
                      title={server.enabled ? '启用中' : '已停用'}
                    >
                      <Power size={11} />
                    </button>
                    <button
                      onClick={() => handleDeleteMcp(server.name)}
                      className='p-1 text-neutral-500 hover:text-rose-400 opacity-0 group-hover:opacity-100 transition-opacity'
                      title='删除'
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                </div>
                <div className='font-mono text-[10px] text-neutral-500 bg-[#161616] px-2 py-0.5 rounded border border-[#232323] truncate'>
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
