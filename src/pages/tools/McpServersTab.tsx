import React, { useEffect, useState } from 'react';
import {
  Network,
  Power,
  Shield,
  ChevronDown,
  ChevronRight,
  Loader2,
  MessageSquareText,
  KeyRound,
  Trash2,
  Copy,
} from 'lucide-react';

interface McpServersTabProps {
  mcpServers: any[];
  workDir?: string;
  refreshMcpAndSkills: (workDir?: string) => Promise<void>;
}

export const McpServersTab: React.FC<McpServersTabProps> = ({
  mcpServers,
  workDir,
  refreshMcpAndSkills,
}) => {
  const [expandedMcpServer, setExpandedMcpServer] = useState<string | null>(null);
  const [mcpToolState, setMcpToolState] = useState<
    Record<string, { loading: boolean; error?: string; tools: any[] }>
  >({});
  const [expandedPromptServer, setExpandedPromptServer] = useState<string | null>(null);
  const [mcpPromptState, setMcpPromptState] = useState<
    Record<string, { loading: boolean; error?: string; prompts: any[] }>
  >({});
  const [promptNotice, setPromptNotice] = useState('');
  const [oauthState, setOauthState] = useState<Record<string, any>>({});
  const [oauthBusy, setOauthBusy] = useState('');
  const [oauthNotices, setOauthNotices] = useState<Record<string, string>>({});

  const handleDeleteMcpServer = async (server: any) => {
    if (!window.electronAPI?.deleteMcpServer) return;
    const confirmed = window.confirm(
      `确认删除 MCP 服务器「${server.name}」？\n\n将从 ~/.omcx/mcp.json 中移除该配置并断开连接。`
    );
    if (!confirmed) return;
    const res = await window.electronAPI.deleteMcpServer(server.id);
    if (!res?.success) {
      console.error('删除 MCP 服务器失败:', res?.error);
      return;
    }
    await refreshMcpAndSkills(workDir);
  };

  const handleToggleMcpServer = async (serverId: string, currentEnabled: boolean) => {
    if (!window.electronAPI?.toggleMcpServer) return;
    const res = await window.electronAPI.toggleMcpServer(serverId, !currentEnabled);
    if (!res?.success) {
      console.error('切换 MCP 服务器状态失败:', res?.error);
      return;
    }
    await refreshMcpAndSkills(workDir);
  };

  const handleTrustProjectMcp = async (trusted: boolean) => {
    if (!window.electronAPI?.trustProjectMcp || !workDir) return;
    const res = await window.electronAPI.trustProjectMcp(workDir, trusted);
    if (!res?.success) {
      console.error('项目级 MCP 信任操作失败:', res?.error);
      return;
    }
    await refreshMcpAndSkills(workDir);
    setMcpToolState({});
  };

  const loadMcpTools = async (serverId: string) => {
    if (!window.electronAPI?.getMcpTools) return;
    setMcpToolState((prev) => ({
      ...prev,
      [serverId]: { loading: true, tools: prev[serverId]?.tools || [] },
    }));
    const res = await window.electronAPI.getMcpTools(serverId, workDir);
    setMcpToolState((prev) => ({
      ...prev,
      [serverId]: {
        loading: false,
        tools: res?.success ? res.tools || [] : [],
        error: res?.success ? undefined : res?.error || '读取工具失败',
      },
    }));
  };

  const handleToggleMcpTool = async (
    serverId: string,
    toolName: string,
    enabled: boolean
  ) => {
    if (!window.electronAPI?.toggleMcpTool) return;
    const res = await window.electronAPI.toggleMcpTool(
      serverId,
      toolName,
      enabled,
      workDir
    );
    if (!res?.success) {
      console.error('切换 MCP 工具状态失败:', res?.error);
      return;
    }
    setMcpToolState((prev) => ({
      ...prev,
      [serverId]: {
        ...prev[serverId],
        tools: (prev[serverId]?.tools || []).map((tool: any) =>
          tool.name === toolName ? { ...tool, enabled } : tool
        ),
      },
    }));
  };

  const handleExpandMcp = async (serverId: string) => {
    if (expandedMcpServer === serverId) {
      setExpandedMcpServer(null);
      return;
    }
    setExpandedMcpServer(serverId);
    if (!mcpToolState[serverId]?.tools?.length) {
      await loadMcpTools(serverId);
    }
  };

  const loadMcpPrompts = async (serverId: string) => {
    if (!window.electronAPI?.listMcpPrompts) return;
    setMcpPromptState((prev) => ({
      ...prev,
      [serverId]: { loading: true, prompts: prev[serverId]?.prompts || [] },
    }));
    const list = await window.electronAPI.listMcpPrompts(workDir);
    const item = Array.isArray(list) ? list.find((entry: any) => entry.serverId === serverId) : null;
    setMcpPromptState((prev) => ({
      ...prev,
      [serverId]: {
        loading: false,
        prompts: Array.isArray(item?.prompts) ? item.prompts : [],
        error: item?.error || (item ? undefined : '读取提示词失败'),
      },
    }));
  };

  const handleExpandPrompts = async (serverId: string) => {
    if (expandedPromptServer === serverId) {
      setExpandedPromptServer(null);
      return;
    }
    setExpandedPromptServer(serverId);
    await loadMcpPrompts(serverId);
  };

  const handleCopyMcpPrompt = async (serverId: string, prompt: any) => {
    if (!window.electronAPI?.getMcpPrompt) return;
    setPromptNotice('');
    const args: Record<string, string> = {};
    for (const arg of Array.isArray(prompt?.arguments) ? prompt.arguments : []) {
      if (arg?.name) args[arg.name] = '';
    }
    const res = await window.electronAPI.getMcpPrompt(
      serverId,
      prompt.name,
      args,
      workDir
    );
    if (!res?.success) {
      setPromptNotice(res?.error || '获取提示词失败');
      return;
    }
    const text = res.text || '';
    if (!text) {
      setPromptNotice('该提示词没有可复制的文本内容');
      return;
    }
    await navigator.clipboard.writeText(text);
    setPromptNotice(`已复制提示词「${prompt.name}」到剪贴板`);
  };

  const refreshOAuthStatus = async () => {
    if (!window.electronAPI?.getMcpOAuthStatus) return;
    try {
      const list = await window.electronAPI.getMcpOAuthStatus(workDir);
      const map: Record<string, any> = {};
      for (const item of Array.isArray(list) ? list : []) map[item.serverId] = item;
      setOauthState(map);
    } catch {
      // 状态读取失败不影响服务器列表
    }
  };

  useEffect(() => {
    refreshOAuthStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workDir, mcpServers.length]);

  const handleAuthorizeOAuth = async (serverId: string) => {
    if (!window.electronAPI?.authorizeMcpOAuth || oauthBusy) return;
    setOauthBusy(serverId);
    setOauthNotices((prev) => ({ ...prev, [serverId]: '' }));
    try {
      const res = await window.electronAPI.authorizeMcpOAuth(
        serverId,
        workDir
      );
      if (!res?.success) {
        setOauthNotices((prev) => ({
          ...prev,
          [serverId]: res?.error || 'OAuth 授权失败',
        }));
        return;
      }
      setOauthNotices((prev) => ({
        ...prev,
        [serverId]: `OAuth 授权成功${res.scope ? `（${res.scope}）` : ''}`,
      }));
      await refreshOAuthStatus();
    } catch (err: any) {
      setOauthNotices((prev) => ({
        ...prev,
        [serverId]: err?.message || String(err),
      }));
    } finally {
      setOauthBusy('');
    }
  };

  const handleLogoutOAuth = async (serverId: string) => {
    if (!window.electronAPI?.logoutMcpOAuth || oauthBusy) return;
    const confirmed = window.confirm('确认清除该 MCP 服务器的 OAuth 令牌？');
    if (!confirmed) return;
    setOauthBusy(serverId);
    try {
      await window.electronAPI.logoutMcpOAuth(serverId, workDir);
      setOauthNotices((prev) => ({ ...prev, [serverId]: '已清除 OAuth 令牌' }));
      await refreshOAuthStatus();
    } catch (err: any) {
      setOauthNotices((prev) => ({
        ...prev,
        [serverId]: err?.message || String(err),
      }));
    } finally {
      setOauthBusy('');
    }
  };

  const enabledCount = mcpServers.filter((s) => !s.requiresTrust && s.enabled).length;

  return (
    <div className='flex flex-col gap-4'>
      {/* 顶部协议与状态概览条（与 Skills / Subagents Tab 对齐全宽与卡片质感） */}
      <div className='px-4 py-3 rounded-2xl bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-subtle)] shadow-sm flex flex-wrap items-center justify-between gap-4'>
        <div className='flex items-center gap-3 min-w-0'>
          <div className='w-8 h-8 rounded-xl bg-[var(--ui-accent-emerald-soft)] border border-[color:var(--ui-accent-emerald-border)] flex items-center justify-center text-[var(--ui-accent-emerald)] flex-shrink-0'>
            <Network size={16} />
          </div>
          <div className='min-w-0'>
            <div className='text-xs font-semibold text-[var(--ui-text-primary)]'>
              标准 Model Context Protocol 动态工具与提示词连接池
            </div>
            <div className='text-[11px] text-[var(--ui-text-muted)] truncate mt-0.5'>
              兼容 Claude Desktop / Cursor 配置 (~/.omcx/mcp.json)；项目级配置 (.omcx/mcp.json) 需显式授权后方可执行
            </div>
          </div>
        </div>
        <div className='flex items-center gap-2 text-[11px] font-mono text-[var(--ui-text-secondary)] flex-shrink-0'>
          <span className='px-2 py-0.5 rounded-lg bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)]'>
            已启用 {enabledCount} / {mcpServers.length}
          </span>
        </div>
      </div>

      {mcpServers.length === 0 ? (
        <div className='py-16 text-center rounded-2xl bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-subtle)] text-xs text-[var(--ui-text-muted)]'>
          暂无配置的 MCP 服务器
        </div>
      ) : (
        <div className='grid grid-cols-1 md:grid-cols-2 gap-3.5'>
          {mcpServers.map((server) => (
            <div
              key={server.id}
              className='p-4 rounded-2xl bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-subtle)] hover:bg-[var(--ui-card-hover-bg)] hover:border-[color:var(--ui-accent-emerald-border)] hover:shadow-md transition-all duration-150 flex flex-col justify-between gap-3 shadow-sm'
            >
              <div className='flex flex-col gap-2.5'>
                <div className='flex items-center justify-between gap-2'>
                  <div className='flex items-center gap-2.5 min-w-0'>
                    <div className='w-8 h-8 rounded-xl bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)] flex items-center justify-center font-bold text-xs text-[var(--ui-text-primary)] flex-shrink-0'>
                      {server.name.charAt(0).toUpperCase()}
                    </div>
                    <div className='min-w-0'>
                      <div className='flex items-center gap-1.5'>
                        <span className='font-bold text-sm text-[var(--ui-text-primary)] truncate'>
                          {server.name}
                        </span>
                        {server.source === 'project' && (
                          <span className='text-[9.5px] px-1.5 py-0.5 rounded-md bg-[var(--ui-accent-amber-soft)] text-[var(--ui-accent-amber)] border border-[color:var(--ui-accent-amber-border)] font-medium flex-shrink-0'>
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
                              : 'bg-[var(--ui-text-faint)]'
                          }`}
                        />
                        <span className='text-[10.5px] font-mono text-[var(--ui-text-muted)]'>
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
                      className='p-1.5 rounded-lg bg-[var(--ui-accent-amber-soft)] text-[var(--ui-accent-amber)] border border-[color:var(--ui-accent-amber-border)] flex-shrink-0'
                      title='项目级 MCP 配置请在项目 .omcx/mcp.json 中启停'
                    >
                      <Shield size={13} />
                    </span>
                  ) : (
                    <div className='flex items-center gap-1.5 flex-shrink-0'>
                      <button
                        onClick={() => handleToggleMcpServer(server.id, server.enabled)}
                        className={`p-1.5 rounded-lg border transition-colors cursor-pointer ${
                          server.enabled
                            ? 'bg-[var(--ui-accent-emerald-soft)] text-[var(--ui-accent-emerald)] border-[color:var(--ui-accent-emerald-border)] hover:brightness-110'
                            : 'bg-[var(--ui-chip-bg)] text-[var(--ui-text-muted)] border-[color:var(--ui-border-hairline)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-chip-hover-bg)]'
                        }`}
                        title={server.enabled ? '点击停用' : '点击启用'}
                      >
                        <Power size={13} />
                      </button>
                      <button
                        onClick={() => handleDeleteMcpServer(server)}
                        className='p-1.5 rounded-lg bg-[var(--ui-chip-bg)] text-[var(--ui-text-muted)] border border-[color:var(--ui-border-hairline)] hover:text-[var(--ui-accent-rose)] hover:bg-[var(--ui-accent-rose-soft)] hover:border-[color:var(--ui-accent-rose-border)] transition-colors cursor-pointer'
                        title='删除该 MCP 服务器配置'
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  )}
                </div>

                <p className='text-xs text-[var(--ui-text-secondary)] leading-relaxed'>
                  {server.description || '标准 MCP 服务节点'}
                </p>

                      {/* OAuth 2.1 授权（仅启用 oauth 的远程 HTTP 服务） */}
                      {server.url &&
                        (server.oauth || server.auth?.type === 'oauth') && (
                        <div className='flex flex-wrap items-center gap-2 rounded-xl bg-[var(--ui-card-inner-bg)] border border-[color:var(--ui-border-hairline)] px-2.5 py-1.5'>
                          <span className='flex items-center gap-1.5 text-[10px] font-mono text-[var(--ui-text-secondary)]'>
                            <KeyRound size={11} className={oauthState[server.id]?.authorized ? 'text-[var(--ui-accent-emerald)]' : 'text-[var(--ui-text-muted)]'} />
                            {oauthState[server.id]?.authorized ? (
                              <span className='text-[var(--ui-accent-emerald)]'>
                                OAuth 已授权
                                {oauthState[server.id]?.expired ? '（已过期）' : ''}
                              </span>
                            ) : (
                              <span>OAuth 未授权</span>
                            )}
                          </span>
                          {oauthState[server.id]?.scope && (
                            <span className='text-[9.5px] font-mono text-[var(--ui-text-muted)] truncate max-w-[160px]' title={oauthState[server.id].scope}>
                              {oauthState[server.id].scope}
                            </span>
                          )}
                          <div className='ml-auto flex items-center gap-1.5'>
                            <button
                              onClick={() => handleAuthorizeOAuth(server.id)}
                              disabled={Boolean(oauthBusy)}
                              className='px-2 py-0.5 rounded-md bg-[var(--ui-accent-blue-soft)] border border-[color:var(--ui-accent-blue-border)] text-[10px] text-[var(--ui-accent-blue)] hover:brightness-110 disabled:opacity-50 flex items-center gap-1 cursor-pointer'
                              title='打开系统浏览器完成 OAuth 授权（授权码 + PKCE）'
                            >
                              {oauthBusy === server.id ? (
                                <Loader2 size={10} className='animate-spin' />
                              ) : null}
                              {oauthState[server.id]?.authorized ? '重新授权' : 'OAuth 登录'}
                            </button>
                            {oauthState[server.id]?.authorized && (
                              <button
                                onClick={() => handleLogoutOAuth(server.id)}
                                disabled={Boolean(oauthBusy)}
                                className='px-2 py-0.5 rounded-md bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)] text-[10px] text-[var(--ui-text-secondary)] hover:text-[var(--ui-accent-rose)] disabled:opacity-50 cursor-pointer'
                              >
                                退出
                              </button>
                            )}
                          </div>
                          {oauthNotices[server.id] && (
                            <div className='w-full text-[9.5px] text-[var(--ui-text-muted)] break-words'>
                              {oauthNotices[server.id]}
                            </div>
                          )}
                        </div>
                      )}

                      {/* 工具级权限 & 提示词操作行 */}
                      <div className='flex items-center gap-3'>
                        <button
                          onClick={() => handleExpandMcp(server.id)}
                          className='flex items-center gap-1 text-[11px] text-[var(--ui-text-secondary)] hover:text-[var(--ui-accent-blue)] transition-colors cursor-pointer'
                          title='查看并单独启停该 MCP 服务器暴露的工具'
                        >
                          {expandedMcpServer === server.id ? (
                            <ChevronDown size={11} />
                          ) : (
                            <ChevronRight size={11} />
                          )}
                          <span>工具权限</span>
                        </button>

                        <button
                          onClick={() => handleExpandPrompts(server.id)}
                          className='flex items-center gap-1 text-[11px] text-[var(--ui-text-secondary)] hover:text-[var(--ui-accent-emerald)] transition-colors cursor-pointer'
                          title='查看并复制该 MCP 服务器暴露的提示词模板 (prompts/list + prompts/get)'
                        >
                          {expandedPromptServer === server.id ? (
                            <ChevronDown size={11} />
                          ) : (
                            <ChevronRight size={11} />
                          )}
                          <MessageSquareText size={11} />
                          <span>提示词</span>
                        </button>
                      </div>

                      {expandedMcpServer === server.id && (
                        <div className='rounded-xl bg-[var(--ui-card-inner-bg)] border border-[color:var(--ui-border-hairline)] p-2.5 flex flex-col gap-1.5'>
                          {mcpToolState[server.id]?.loading ? (
                            <div className='flex items-center gap-1.5 text-[10.5px] text-[var(--ui-text-muted)] py-1'>
                              <Loader2 size={11} className='animate-spin' />
                              正在读取工具清单…
                            </div>
                          ) : mcpToolState[server.id]?.error ? (
                            <div className='text-[10.5px] text-[var(--ui-accent-rose)] py-1 select-text'>
                              {mcpToolState[server.id].error}
                            </div>
                          ) : (mcpToolState[server.id]?.tools || []).length === 0 ? (
                            <div className='text-[10.5px] text-[var(--ui-text-muted)] py-1'>
                              暂无可用工具（服务器可能尚未启动）
                            </div>
                          ) : (
                            <>
                              <div className='flex items-center justify-between text-[10px] text-[var(--ui-text-muted)]'>
                                <span>已启用 {mcpToolState[server.id].tools.filter((t: any) => t.enabled).length} / {mcpToolState[server.id].tools.length}</span>
                                <button
                                  onClick={() => loadMcpTools(server.id)}
                                  className='text-[var(--ui-accent-blue)] hover:underline cursor-pointer'
                                >
                                  刷新
                                </button>
                              </div>
                              <div className='max-h-[190px] overflow-y-auto custom-scrollbar flex flex-col gap-1 pr-1'>
                                {mcpToolState[server.id].tools.map((tool: any) => (
                                  <label
                                    key={tool.name}
                                    className={`flex items-start gap-2 rounded-lg px-2 py-1.5 cursor-pointer transition-colors ${
                                      server.source === 'project'
                                        ? 'opacity-70 cursor-not-allowed'
                                        : 'hover:bg-[var(--ui-block-hover-bg)]'
                                    }`}
                                    title={tool.description || tool.name}
                                  >
                                    <input
                                      type='checkbox'
                                      checked={!!tool.enabled}
                                      disabled={server.source === 'project'}
                                      onChange={(e) =>
                                        handleToggleMcpTool(server.id, tool.name, e.target.checked)
                                      }
                                      className='mt-0.5 accent-blue-600'
                                    />
                                    <span className='min-w-0'>
                                      <span className='block text-[11px] font-mono text-[var(--ui-text-primary)] truncate'>
                                        {tool.name}
                                      </span>
                                      {tool.description && (
                                        <span className='block text-[10px] text-[var(--ui-text-muted)] truncate'>
                                          {tool.description}
                                        </span>
                                      )}
                                    </span>
                                  </label>
                                ))}
                              </div>
                              {server.source === 'project' && (
                                <div className='text-[9.5px] text-[var(--ui-accent-amber)]'>
                                  项目级工具权限请在项目 .omcx/mcp.json 中配置
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      )}

                      {expandedPromptServer === server.id && (
                        <div className='rounded-xl bg-[var(--ui-card-inner-bg)] border border-[color:var(--ui-border-hairline)] p-2.5 flex flex-col gap-1.5'>
                          {mcpPromptState[server.id]?.loading ? (
                            <div className='flex items-center gap-1.5 text-[10.5px] text-[var(--ui-text-muted)] py-1'>
                              <Loader2 size={11} className='animate-spin' />
                              正在读取提示词…
                            </div>
                          ) : mcpPromptState[server.id]?.error ? (
                            <div className='text-[10.5px] text-[var(--ui-accent-rose)] py-1 select-text'>
                              {mcpPromptState[server.id].error}
                            </div>
                          ) : (mcpPromptState[server.id]?.prompts || []).length === 0 ? (
                            <div className='text-[10.5px] text-[var(--ui-text-muted)] py-1'>
                              该服务器未提供提示词模板
                            </div>
                          ) : (
                            <>
                              <div className='flex items-center justify-between text-[10px] text-[var(--ui-text-muted)]'>
                                <span>共 {mcpPromptState[server.id].prompts.length} 个提示词</span>
                                <button
                                  onClick={() => loadMcpPrompts(server.id)}
                                  className='text-[var(--ui-accent-emerald)] hover:underline cursor-pointer'
                                >
                                  刷新
                                </button>
                              </div>
                              <div className='max-h-[190px] overflow-y-auto custom-scrollbar flex flex-col gap-1 pr-1'>
                                {mcpPromptState[server.id].prompts.map((prompt: any) => (
                                  <button
                                    key={prompt.name}
                                    onClick={() => handleCopyMcpPrompt(server.id, prompt)}
                                    className='text-left rounded-lg px-2 py-1.5 hover:bg-[var(--ui-block-hover-bg)] transition-colors cursor-pointer'
                                    title={prompt.description || `复制提示词 ${prompt.name}`}
                                  >
                                    <span className='flex items-center gap-1.5'>
                                      <span className='text-[11px] font-mono text-[var(--ui-text-primary)] truncate'>
                                        {prompt.name}
                                      </span>
                                      {Array.isArray(prompt.arguments) && prompt.arguments.length > 0 && (
                                        <span className='text-[9px] px-1 rounded bg-[var(--ui-chip-bg)] text-[var(--ui-text-secondary)]'>
                                          {prompt.arguments.length} 参数
                                        </span>
                                      )}
                                      <Copy size={10} className='ml-auto text-[var(--ui-text-muted)] flex-shrink-0' />
                                    </span>
                                    {prompt.description && (
                                      <span className='block text-[10px] text-[var(--ui-text-muted)] truncate'>
                                        {prompt.description}
                                      </span>
                                    )}
                                  </button>
                                ))}
                              </div>
                            </>
                          )}
                          {promptNotice && (
                            <div className='text-[9.5px] text-[var(--ui-accent-emerald)] break-words'>
                              {promptNotice}
                            </div>
                          )}
                        </div>
                      )}

                      {server.requiresTrust && (
                        <div className='flex items-start gap-2 rounded-xl border border-[color:var(--ui-accent-amber-border)] bg-[var(--ui-accent-amber-soft)] px-3 py-2'>
                          <Shield size={13} className='text-[var(--ui-accent-amber)] mt-0.5 flex-shrink-0' />
                          <div className='flex-1 min-w-0'>
                            <p className='text-[11px] text-[var(--ui-text-primary)] leading-relaxed'>
                              该项目自带 MCP 服务器配置，启用后会以当前用户权限执行其中的命令。请确认项目来源可信后再授权；配置文件变更后需要重新授权。
                            </p>
                            <button
                              onClick={() => handleTrustProjectMcp(true)}
                              className='mt-1.5 text-[11px] font-semibold text-[var(--ui-accent-amber)] hover:underline cursor-pointer'
                            >
                              信任此项目并启用
                            </button>
                          </div>
                        </div>
                      )}

                      {server.source === 'project' && server.trusted && (
                        <button
                          onClick={() => handleTrustProjectMcp(false)}
                          className='self-start text-[10px] text-[var(--ui-text-muted)] hover:text-[var(--ui-accent-amber)] cursor-pointer'
                        >
                          撤销项目 MCP 信任
                        </button>
                      )}
                    </div>

                    {/* 执行配置 */}
                    <div className='bg-[var(--ui-card-inner-bg)] border border-[color:var(--ui-border-hairline)] rounded-xl px-3 py-2 flex items-center justify-between text-xs font-mono text-[var(--ui-text-secondary)] overflow-hidden'>
                      <div className='truncate pr-2'>
                        {server.url ? (
                          <>
                            <span className='text-[var(--ui-accent-emerald)] font-semibold'>
                              {server.transport === 'sse' ? 'SSE' : 'HTTP'}
                            </span>{' '}
                            <span>{server.url}</span>
                          </>
                        ) : (
                          <>
                            <span className='text-[var(--ui-accent-blue)] font-semibold'>{server.command}</span>{' '}
                            <span>{(server.args || []).join(' ')}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
  );
};
