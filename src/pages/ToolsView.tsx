import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Sparkles,
  Network,
  Wrench,
  Copy,
  Check,
  X,
  FileCode,
  FolderGit2,
  Globe,
  Power,
  Bot,
  Shield,
} from 'lucide-react';
import { useChatStore, SkillItem, SubagentItem } from '@/stores/chatStore';

export const ToolsView: React.FC = () => {
  const { skills, mcpServers, subagents, refreshMcpAndSkills, sessions, activeSessionId } = useChatStore();
  const activeSession = sessions.find((s) => s.id === activeSessionId);

  const [activeTab, setActiveTab] = useState<'skills' | 'subagents' | 'mcp'>('skills');
  const [skillFilter, setSkillFilter] = useState<'all' | 'project' | 'global'>('all');
  const [inspectingSkill, setInspectingSkill] = useState<SkillItem | null>(null);
  const [inspectingSubagent, setInspectingSubagent] = useState<SubagentItem | null>(null);
  const [copied, setCopied] = useState(false);

  // 技能次级筛选
  const filteredSkills = skills.filter((s) => {
    if (skillFilter === 'project') return s.scope === 'project';
    if (skillFilter === 'global') return s.scope === 'global';
    return true;
  });

  const projectSkillsCount = skills.filter((s) => s.scope === 'project').length;
  const globalSkillsCount = skills.filter((s) => s.scope === 'global').length;

  const handleCopyPrompt = (text: string) => {
    if (!text) return;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleToggleMcpServer = async (serverId: string, currentEnabled: boolean) => {
    if (!window.electronAPI?.toggleMcpServer) return;
    const res = await window.electronAPI.toggleMcpServer(serverId, !currentEnabled);
    if (!res?.success) {
      console.error('切换 MCP 服务器状态失败:', res?.error);
      return;
    }
    await refreshMcpAndSkills(activeSession?.workDir);
  };

  const handleTrustProjectMcp = async (trusted: boolean) => {
    if (!window.electronAPI?.trustProjectMcp || !activeSession?.workDir) return;
    const res = await window.electronAPI.trustProjectMcp(activeSession.workDir, trusted);
    if (!res?.success) {
      console.error('项目级 MCP 信任操作失败:', res?.error);
      return;
    }
    await refreshMcpAndSkills(activeSession.workDir);
  };

  return (
    <div className='flex-1 h-full flex flex-col bg-[var(--ui-app-bg)] overflow-hidden text-[var(--ui-text-primary)] select-none'>
      {/* 顶部 Header：仅保留左侧标题区 */}
      <div className='h-[56px] border-b border-[color:var(--ui-divider-hairline)] bg-[var(--ui-panel-bg)] px-6 flex items-center justify-between flex-shrink-0 titlebar-drag'>
        <div className='flex items-center gap-3'>
          <div className='w-8 h-8 rounded-lg bg-[var(--ui-accent-blue-soft)] border border-[color:var(--ui-accent-blue-border)] flex items-center justify-center text-[var(--ui-accent-blue)]'>
            <Wrench size={16} />
          </div>
          <div>
            <h1 className='text-sm font-semibold text-[var(--ui-text-primary)]'>工具与技能中心</h1>
            <p className='text-[11px] text-[var(--ui-text-muted)]'>
              管理 Agent 声明式技能与标准 MCP 外部连接器
            </p>
          </div>
        </div>
      </div>

      {/* 主工作台内容区 */}
      <div className='flex-1 overflow-y-auto p-6 custom-scrollbar'>
        <div className='flex flex-col gap-5 max-w-6xl mx-auto'>
          {/* 内容区顶栏：左侧分类说明，右上角放三 Tab */}
          <div className='flex items-center justify-between border-b border-[color:var(--ui-divider-hairline)] pb-4'>
            <div>
              <h2 className='text-sm font-bold text-[var(--ui-text-primary)]'>
                {activeTab === 'skills'
                  ? '声明式技能扩展 (Declared Skills)'
                  : activeTab === 'subagents'
                  ? '专家子代理与并行分治引擎 (Autonomous & Parallel Subagents)'
                  : '模型上下文协议服务节点 (Model Context Protocol Servers)'}
              </h2>
              <p className='text-[11px] text-[var(--ui-text-muted)] mt-0.5'>
                {activeTab === 'skills'
                  ? '支持 ~/.agents/skills 与当前项目 .agents/skills，任务匹配时按需读取指令'
                  : activeTab === 'subagents'
                  ? '主 Agent 根据任务复杂度自动调度或并行扇出 (Fan-out)，同时支持 ~/.omcx/agents/*.md 自定义扩展与 @agent: 点名'
                  : '标准协议驱动，完全兼容 Claude Desktop / Cursor 配置文件 (~/.omcx/mcp.json)'}
              </p>
            </div>

            {/* 三 Tab 切换器 (置于渲染内容右上角) */}
            <div className='flex items-center gap-1.5 bg-[var(--ui-card-inner-bg)] p-1 rounded-xl border border-[color:var(--ui-border-hairline)] flex-shrink-0'>
              <button
                onClick={() => setActiveTab('skills')}
                className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs transition-all ${
                  activeTab === 'skills'
                    ? 'bg-blue-600 text-white font-semibold shadow-sm'
                    : 'text-neutral-400 hover:text-neutral-200 hover:bg-white/[0.04]'
                }`}
              >
                <Sparkles
                  size={14}
                  className={activeTab === 'skills' ? 'text-yellow-300' : 'text-yellow-400'}
                />
                <span>技能扩展 (Skills)</span>
                <span className='px-1.5 py-0.2 rounded-full text-[10px] bg-white/20 font-mono'>
                  {skills.length}
                </span>
              </button>
              <button
                onClick={() => setActiveTab('subagents')}
                className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs transition-all ${
                  activeTab === 'subagents'
                    ? 'bg-blue-600 text-white font-semibold shadow-sm'
                    : 'text-neutral-400 hover:text-neutral-200 hover:bg-white/[0.04]'
                }`}
              >
                <Bot
                  size={14}
                  className={activeTab === 'subagents' ? 'text-sky-200' : 'text-sky-400'}
                />
                <span>子代理 (Subagents)</span>
                <span className='px-1.5 py-0.2 rounded-full text-[10px] bg-white/20 font-mono'>
                  {subagents.length}
                </span>
              </button>
              <button
                onClick={() => setActiveTab('mcp')}
                className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs transition-all ${
                  activeTab === 'mcp'
                    ? 'bg-blue-600 text-white font-semibold shadow-sm'
                    : 'text-neutral-400 hover:text-neutral-200 hover:bg-white/[0.04]'
                }`}
              >
                <Network
                  size={14}
                  className={activeTab === 'mcp' ? 'text-emerald-300' : 'text-emerald-400'}
                />
                <span>MCP 服务器 (MCP)</span>
                <span className='px-1.5 py-0.2 rounded-full text-[10px] bg-white/20 font-mono'>
                  {mcpServers.length}
                </span>
              </button>
            </div>
          </div>

          {/* ═════════ 1. SKILLS 视图 ═════════ */}
          {activeTab === 'skills' && (
            <div className='flex flex-col gap-4'>
              {/* 次级筛选栏 */}
              <div className='flex items-center justify-between'>
                <div className='flex items-center gap-1.5 bg-[#181818] p-1 rounded-xl border border-[#282828]'>
                  <button
                    onClick={() => setSkillFilter('all')}
                    className={`px-3 py-1 rounded-lg text-xs transition-colors ${
                      skillFilter === 'all'
                        ? 'bg-[#262626] text-neutral-100 font-semibold'
                        : 'text-neutral-400 hover:text-neutral-200'
                    }`}
                  >
                    全部 ({skills.length})
                  </button>
                  <button
                    onClick={() => setSkillFilter('project')}
                    className={`px-3 py-1 rounded-lg text-xs transition-colors flex items-center gap-1.5 ${
                      skillFilter === 'project'
                        ? 'bg-emerald-500/15 text-emerald-400 font-semibold border border-emerald-500/25'
                        : 'text-neutral-400 hover:text-neutral-200'
                    }`}
                  >
                    <FolderGit2 size={12} />
                    <span>项目专属 ({projectSkillsCount})</span>
                  </button>
                  <button
                    onClick={() => setSkillFilter('global')}
                    className={`px-3 py-1 rounded-lg text-xs transition-colors flex items-center gap-1.5 ${
                      skillFilter === 'global'
                        ? 'bg-blue-500/15 text-blue-400 font-semibold border border-blue-500/25'
                        : 'text-neutral-400 hover:text-neutral-200'
                    }`}
                  >
                    <Globe size={12} />
                    <span>系统全局 ~/.agents/skills ({globalSkillsCount})</span>
                  </button>
                </div>

                <span className='text-[11px] text-neutral-500'>
                  点击卡片可查看完整 Prompt 与执行指南
                </span>
              </div>

            {/* 卡片网格 */}
            {filteredSkills.length === 0 ? (
              <div className='py-16 text-center text-xs text-neutral-500'>
                当前分类下暂无已声明的技能规范
              </div>
            ) : (
              <div className='grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5'>
                {filteredSkills.map((skill) => {
                  const isProject = skill.scope === 'project';
                  return (
                    <div
                      key={skill.id}
                      onClick={() => setInspectingSkill(skill)}
                      className='p-4 rounded-2xl bg-[#1c1c1c] border border-[#292929] hover:border-[#383838] hover:bg-[#202020] transition-all duration-150 cursor-pointer flex flex-col justify-between gap-3 group shadow-sm'
                    >
                      <div className='flex flex-col gap-2'>
                        <div className='flex items-center justify-between'>
                          <div className='flex items-center gap-2 min-w-0'>
                            <Sparkles size={14} className='text-yellow-400 flex-shrink-0' />
                            <span className='font-bold text-sm text-neutral-100 group-hover:text-blue-400 transition-colors truncate'>
                              {skill.name}
                            </span>
                          </div>
                          <div className='flex items-center gap-1.5 flex-shrink-0'>
                            {skill.version && (
                              <span className='px-1.5 py-0.2 rounded text-[10px] font-mono bg-[#252525] text-neutral-400 border border-[#333]'>
                                v{skill.version}
                              </span>
                            )}
                            <span
                              className={`px-2 py-0.5 rounded-full text-[10px] font-mono uppercase tracking-wide border ${
                                isProject
                                  ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25'
                                  : 'bg-[#262626] text-neutral-400 border-[#333]'
                              }`}
                            >
                              {isProject ? 'Project' : 'Global'}
                            </span>
                          </div>
                        </div>

                        <p className='text-xs text-neutral-400 line-clamp-3 leading-relaxed'>
                          {skill.description || '无详细描述'}
                        </p>
                      </div>

                      <div className='space-y-2 pt-2 border-t border-[#262626]'>
                        {/* 依赖工具列表 */}
                        <div className='flex items-center gap-1.5 flex-wrap min-h-[20px]'>
                          {skill.tools && skill.tools.length > 0 ? (
                            skill.tools.map((t, idx) => (
                              <span
                                key={idx}
                                className='px-2 py-0.5 rounded-md bg-[#252525] border border-[#303030] text-[10px] font-mono text-neutral-300'
                              >
                                {t}
                              </span>
                            ))
                          ) : (
                            <span className='text-[10px] text-neutral-500 font-mono'>无特定依赖工具</span>
                          )}
                        </div>

                        {/* 路径缩略 */}
                        {skill.filePath && (
                          <div className='text-[10px] font-mono text-neutral-500 truncate' title={skill.filePath}>
                            {skill.filePath}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ═════════ 1.5 SUBAGENTS 视图 ═════════ */}
        {activeTab === 'subagents' && (
          <div className='flex flex-col gap-4'>
            <div className='p-3.5 rounded-2xl bg-[#181818] border border-[#282828] flex items-center justify-between gap-4'>
              <div className='flex items-center gap-3 min-w-0'>
                <div className='w-8 h-8 rounded-xl bg-sky-500/10 border border-sky-500/20 flex items-center justify-center text-sky-400 flex-shrink-0'>
                  <Bot size={16} />
                </div>
                <div className='min-w-0'>
                  <div className='text-xs font-semibold text-neutral-200'>
                    支持「主 Agent 自主判断 + 零预设动态生成 + 多路并行 Fan-out」
                  </div>
                  <div className='text-[11px] text-neutral-500 truncate'>
                    复杂检索或多模块任务时，主 Agent 会自动通过 dispatch_subagent 单路或多路并发委派；你也可在 ~/.omcx/agents/*.md 定义专属模板或在输入框用 @agent: 点名。
                  </div>
                </div>
              </div>
              <span className='text-[11px] text-neutral-500 flex-shrink-0'>
                点击卡片查看系统提示词
              </span>
            </div>

            <div className='grid grid-cols-1 md:grid-cols-2 gap-3.5'>
              {subagents.map((ag) => (
                <div
                  key={ag.id}
                  onClick={() => setInspectingSubagent(ag)}
                  className='p-4 rounded-2xl bg-[#1c1c1c] border border-[#292929] hover:border-[#383838] hover:bg-[#202020] transition-all duration-150 cursor-pointer flex flex-col justify-between gap-3 group shadow-sm'
                >
                  <div className='flex flex-col gap-2'>
                    <div className='flex items-center justify-between gap-2'>
                      <div className='flex items-center gap-2 min-w-0'>
                        <Bot size={15} className='text-sky-400 flex-shrink-0' />
                        <span className='font-bold text-sm text-neutral-100 group-hover:text-sky-400 transition-colors truncate'>
                          {ag.name}
                        </span>
                        <code className='text-[10px] font-mono px-1.5 py-0.2 rounded bg-[#252525] text-sky-300 border border-[#333]'>
                          @{ag.id}
                        </code>
                      </div>

                      <div className='flex items-center gap-1.5 flex-shrink-0'>
                        <span
                          className={`px-2 py-0.5 rounded-full text-[10px] font-mono border flex items-center gap-1 ${
                            ag.readOnly
                              ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25'
                              : 'bg-amber-500/10 text-amber-300 border-amber-500/25'
                          }`}
                        >
                          <Shield size={10} />
                          <span>{ag.readOnly ? '只读安全' : '完整读写'}</span>
                        </span>
                        <span className='px-2 py-0.5 rounded-full text-[10px] font-mono uppercase bg-[#262626] text-neutral-400 border border-[#333]'>
                          {ag.scope || 'builtin'}
                        </span>
                      </div>
                    </div>

                    <p className='text-xs text-neutral-400 line-clamp-2 leading-relaxed'>
                      {ag.description}
                    </p>
                  </div>

                  <div className='space-y-2 pt-2 border-t border-[#262626]'>
                    <div className='flex items-center justify-between text-[10.5px] font-mono text-neutral-500'>
                      <span>模型策略: {ag.modelTier === 'lite' ? 'Lite (高速轻量优先)' : 'Inherit (继承主模型)'}</span>
                      <span>最大轮次: {ag.maxRounds || 10} 轮</span>
                    </div>
                    <div className='flex items-center gap-1.5 flex-wrap'>
                      {(ag.tools || []).map((t) => (
                        <span
                          key={t}
                          className='px-2 py-0.5 rounded-md bg-[#252525] border border-[#303030] text-[10px] font-mono text-neutral-300'
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ═════════ 2. MCP CONNECTORS 视图 ═════════ */}
        {activeTab === 'mcp' && (
          <div className='flex flex-col gap-4 max-w-5xl mx-auto'>
            <div className='flex items-center justify-between border-b border-[#242424] pb-3'>
              <div>
                <h2 className='text-xs font-bold uppercase tracking-wider text-neutral-300'>
                  模型上下文协议服务节点 (Model Context Protocol Servers)
                </h2>
                <p className='text-[11px] text-neutral-500 mt-0.5'>
                  标准协议驱动，完全兼容 Claude Desktop / Cursor 配置文件 (~/.omcx/mcp.json)
                </p>
              </div>
            </div>

            {mcpServers.length === 0 ? (
              <div className='py-16 text-center text-xs text-neutral-500'>
                暂无配置的 MCP 服务器
              </div>
            ) : (
              <div className='grid grid-cols-1 md:grid-cols-2 gap-3.5'>
                {mcpServers.map((server) => (
                  <div
                    key={server.id}
                    className='p-4 rounded-2xl bg-[#1c1c1c] border border-[#292929] flex flex-col justify-between gap-3 shadow-sm'
                  >
                    <div className='flex flex-col gap-2'>
                      <div className='flex items-center justify-between'>
                        <div className='flex items-center gap-2.5'>
                          <div className='w-8 h-8 rounded-lg bg-[#272727] border border-[#383838] flex items-center justify-center font-bold text-xs text-neutral-200'>
                            {server.name.charAt(0).toUpperCase()}
                          </div>
                          <div>
                            <div className='flex items-center gap-1.5'>
                              <span className='font-bold text-sm text-neutral-100'>
                                {server.name}
                              </span>
                              {server.source === 'project' && (
                                <span className='text-[9px] px-1.5 py-0.5 rounded-md bg-amber-500/10 text-amber-400 border border-amber-500/25 font-medium'>
                                  项目配置
                                </span>
                              )}
                            </div>
                            <div className='flex items-center gap-1.5 mt-0.5'>
                              <span
                                className={`w-1.5 h-1.5 rounded-full ${
                                  server.requiresTrust
                                    ? 'bg-amber-500'
                                    : server.enabled
                                    ? 'bg-emerald-500'
                                    : 'bg-neutral-600'
                                }`}
                              />
                              <span className='text-[10px] font-mono text-neutral-400'>
                                {server.requiresTrust
                                  ? '待授权'
                                  : server.enabled
                                  ? '在线 (Ready)'
                                  : '已停用'}
                              </span>
                            </div>
                          </div>
                        </div>

                        {/* 启用/停用切换按钮（项目级配置由项目文件托管，不在此处改写） */}
                        {server.source === 'project' ? (
                          <span
                            className='p-1.5 rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/20'
                            title='项目级 MCP 配置请在项目 .omcx/mcp.json 中启停'
                          >
                            <Shield size={13} />
                          </span>
                        ) : (
                          <button
                            onClick={() => handleToggleMcpServer(server.id, server.enabled)}
                            className={`p-1.5 rounded-lg border transition-colors ${
                              server.enabled
                                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/20'
                                : 'bg-[#252525] text-neutral-500 border-[#333] hover:text-neutral-300'
                            }`}
                            title={server.enabled ? '点击停用' : '点击启用'}
                          >
                            <Power size={13} />
                          </button>
                        )}
                      </div>

                      <p className='text-xs text-neutral-400 leading-relaxed'>
                        {server.description || '标准 MCP 服务节点'}
                      </p>

                      {server.requiresTrust && (
                        <div className='flex items-start gap-2 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2'>
                          <Shield size={13} className='text-amber-400 mt-0.5 flex-shrink-0' />
                          <div className='flex-1 min-w-0'>
                            <p className='text-[11px] text-amber-200 leading-relaxed'>
                              该项目自带 MCP 服务器配置，启用后会以当前用户权限执行其中的命令。请确认项目来源可信后再授权；配置文件变更后需要重新授权。
                            </p>
                            <button
                              onClick={() => handleTrustProjectMcp(true)}
                              className='mt-1.5 text-[11px] font-semibold text-amber-300 hover:text-amber-200'
                            >
                              信任此项目并启用
                            </button>
                          </div>
                        </div>
                      )}

                      {server.source === 'project' && server.trusted && (
                        <button
                          onClick={() => handleTrustProjectMcp(false)}
                          className='self-start text-[10px] text-neutral-500 hover:text-amber-400'
                        >
                          撤销项目 MCP 信任
                        </button>
                      )}
                    </div>

                    {/* 执行配置 */}
                    <div className='bg-[#161616] border border-[#262626] rounded-xl p-2.5 flex items-center justify-between text-xs font-mono text-neutral-400 overflow-hidden'>
                      <div className='truncate pr-2'>
                        <span className='text-blue-400 font-semibold'>{server.command}</span>{' '}
                        <span>{server.args.join(' ')}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        </div>
      </div>

      {/* ═════════ 3. SKILL 详情弹窗 (createPortal 挂载至 body 顶层，z-[99999] 防遮挡) ═════════ */}
      {inspectingSkill && typeof document !== 'undefined' && createPortal(
        <div
          className='fixed inset-0 z-[99999] bg-black/70 backdrop-blur-sm flex items-center justify-center p-6 select-none animate-in fade-in duration-150'
          onClick={() => setInspectingSkill(null)}
        >
          <div
            className='w-full max-w-2xl bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-subtle)] rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh] text-[var(--ui-text-primary)]'
            onClick={(e) => e.stopPropagation()}
          >
            {/* 弹窗头部 */}
            <div className='px-5 py-3.5 border-b border-[color:var(--ui-divider-hairline)] bg-[var(--ui-card-header-bg)] flex items-center justify-between flex-shrink-0'>
              <div className='flex items-center gap-2 min-w-0'>
                <Sparkles size={16} className='text-yellow-400 flex-shrink-0' />
                <h3 className='font-bold text-sm text-[var(--ui-text-primary)] truncate'>
                  {inspectingSkill.name}
                </h3>
                <span
                  className={`px-2 py-0.5 rounded-full text-[10px] font-mono border ${
                    inspectingSkill.scope === 'project'
                      ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25'
                      : 'bg-[var(--ui-chip-bg)] text-[var(--ui-text-muted)] border-[color:var(--ui-border-hairline)]'
                  }`}
                >
                  {inspectingSkill.scope === 'project' ? 'Project' : 'Global'}
                </span>
                {inspectingSkill.version && (
                  <span className='px-1.5 py-0.2 rounded text-[10px] font-mono bg-[var(--ui-chip-bg)] text-[var(--ui-text-muted)] border border-[color:var(--ui-border-hairline)]'>
                    v{inspectingSkill.version}
                  </span>
                )}
              </div>

              <div className='flex items-center gap-1.5 flex-shrink-0'>
                <button
                  onClick={() => handleCopyPrompt(inspectingSkill.prompt)}
                  className='px-2.5 py-1 rounded-lg bg-[var(--ui-chip-bg)] hover:bg-[var(--ui-chip-hover-bg)] text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)] text-xs flex items-center gap-1 transition-colors'
                  title='复制 Prompt'
                >
                  {copied ? <Check size={12} className='text-emerald-400' /> : <Copy size={12} />}
                  <span>{copied ? '已复制' : '复制'}</span>
                </button>
                <button
                  onClick={() => setInspectingSkill(null)}
                  className='p-1 rounded-lg text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-block-hover-bg)] transition-colors'
                  title='关闭'
                >
                  <X size={15} />
                </button>
              </div>
            </div>

            {/* 弹窗信息栏 */}
            <div className='px-5 py-3 border-b border-[color:var(--ui-divider-hairline)] bg-[var(--ui-card-inner-bg)] flex flex-col gap-2 flex-shrink-0 text-xs'>
              {inspectingSkill.description && (
                <p className='text-[var(--ui-text-secondary)] leading-relaxed'>{inspectingSkill.description}</p>
              )}
              {inspectingSkill.filePath && (
                <div className='flex items-center gap-1.5 text-[11px] text-[var(--ui-text-muted)] font-mono truncate'>
                  <FileCode size={12} className='flex-shrink-0 text-[var(--ui-text-muted)]' />
                  <span className='truncate'>{inspectingSkill.filePath}</span>
                </div>
              )}
              {inspectingSkill.tools && inspectingSkill.tools.length > 0 && (
                <div className='flex items-center gap-1.5 flex-wrap pt-1'>
                  <span className='text-[10px] text-[var(--ui-text-faint)]'>依赖工具:</span>
                  {inspectingSkill.tools.map((t, idx) => (
                    <span
                      key={idx}
                      className='px-2 py-0.5 rounded-md bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)] text-[10px] font-mono text-[var(--ui-text-secondary)]'
                    >
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* Prompt 正文 */}
            <div className='flex-1 overflow-y-auto p-5 custom-scrollbar bg-[var(--ui-app-bg)]'>
              <pre className='text-xs font-mono text-[var(--ui-text-primary)] whitespace-pre-wrap leading-relaxed select-text'>
                {inspectingSkill.prompt || '该技能未包含额外的提示词正文'}
              </pre>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* ═════════ 4. SUBAGENT 详情弹窗 (createPortal 挂载至 body 顶层) ═════════ */}
      {inspectingSubagent && typeof document !== 'undefined' && createPortal(
        <div
          className='fixed inset-0 z-[99999] bg-black/70 backdrop-blur-sm flex items-center justify-center p-6 select-none animate-in fade-in duration-150'
          onClick={() => setInspectingSubagent(null)}
        >
          <div
            className='w-full max-w-2xl bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-subtle)] rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh] text-[var(--ui-text-primary)]'
            onClick={(e) => e.stopPropagation()}
          >
            <div className='px-5 py-3.5 border-b border-[color:var(--ui-divider-hairline)] bg-[var(--ui-card-header-bg)] flex items-center justify-between flex-shrink-0'>
              <div className='flex items-center gap-2 min-w-0'>
                <Bot size={16} className='text-sky-400 flex-shrink-0' />
                <h3 className='font-bold text-sm text-[var(--ui-text-primary)] truncate'>
                  {inspectingSubagent.name}
                </h3>
                <code className='px-2 py-0.5 rounded text-[10px] font-mono bg-[var(--ui-chip-bg)] text-sky-400 border border-[color:var(--ui-border-hairline)]'>
                  @agent:{inspectingSubagent.id}
                </code>
                <span
                  className={`px-2 py-0.5 rounded-full text-[10px] font-mono border ${
                    inspectingSubagent.readOnly
                      ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25'
                      : 'bg-amber-500/10 text-amber-300 border-amber-500/25'
                  }`}
                >
                  {inspectingSubagent.readOnly ? '只读安全' : '完整读写'}
                </span>
              </div>

              <div className='flex items-center gap-1.5 flex-shrink-0'>
                <button
                  onClick={() => handleCopyPrompt(inspectingSubagent.systemPrompt || '')}
                  className='px-2.5 py-1 rounded-lg bg-[var(--ui-chip-bg)] hover:bg-[var(--ui-chip-hover-bg)] text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)] text-xs flex items-center gap-1 transition-colors'
                  title='复制系统提示词'
                >
                  {copied ? <Check size={12} className='text-emerald-400' /> : <Copy size={12} />}
                  <span>{copied ? '已复制' : '复制'}</span>
                </button>
                <button
                  onClick={() => setInspectingSubagent(null)}
                  className='p-1 rounded-lg text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-block-hover-bg)] transition-colors'
                  title='关闭'
                >
                  <X size={15} />
                </button>
              </div>
            </div>

            <div className='px-5 py-3 border-b border-[color:var(--ui-divider-hairline)] bg-[var(--ui-card-inner-bg)] flex flex-col gap-2 flex-shrink-0 text-xs'>
              <p className='text-[var(--ui-text-secondary)] leading-relaxed'>{inspectingSubagent.description}</p>
              <div className='flex items-center gap-1.5 flex-wrap pt-1'>
                <span className='text-[10px] text-[var(--ui-text-faint)]'>授权工具白名单:</span>
                {(inspectingSubagent.tools || []).map((t) => (
                  <span
                    key={t}
                    className='px-2 py-0.5 rounded-md bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)] text-[10px] font-mono text-[var(--ui-text-secondary)]'
                  >
                    {t}
                  </span>
                ))}
              </div>
            </div>

            <div className='flex-1 overflow-y-auto p-5 custom-scrollbar bg-[var(--ui-app-bg)]'>
              <pre className='text-xs font-mono text-[var(--ui-text-primary)] whitespace-pre-wrap leading-relaxed select-text'>
                {inspectingSubagent.systemPrompt || '无独立系统提示词'}
              </pre>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};

export default ToolsView;
