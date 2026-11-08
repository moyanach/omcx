import React, { useState, useEffect, useRef } from 'react';
import { useChatStore, type ChatAttachment } from '../stores/chatStore';
import { useStreamChat } from '../hooks/useStreamChat';
import { useAppStore } from '../stores/appStore';
import { readFileAsBase64, type DraftChatAttachment } from '@/lib/chatAttachment';
import ChatHeader from '@/pages/chat/ChatHeader';
import MessageList from '@/pages/chat/MessageList';
import MessageInput from '@/pages/chat/MessageInput';
import SessionInspectorColumn from '@/components/agent/SessionInspectorColumn';
import WebWorkspaceDrawer from '@/components/browser/WebWorkspaceDrawer';
import EditWorkspaceModal, { WorkspaceData } from '@/components/agent/EditWorkspaceModal';
import { ShieldAlert, CheckCircle2 } from 'lucide-react';

const formatTokenCount = (value: number) => {
  if (value === undefined || value === null || Number.isNaN(value)) return '-';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
};

const ChatView: React.FC = () => {
  const {
    sessions,
    activeSessionId,
    messages,
    toolCallsBySession,
    todosBySession,
    permissionBySession,
    setSessionPermission,
    initStore,
    updateSessionModel,
    updateSessionTitle,
    setSessionWorkDir,
    setSessionPermissionMode,
    refreshOutputs,
    refreshGitStatus,
    refreshMcpAndSkills,
    isWorkspaceModalOpen,
    activeEditingWorkspace,
    openWorkspaceModal,
    closeWorkspaceModal,
    saveWorkspace,
    deleteWorkspace,
    models,
    fetchModels,
    setLastCompaction,
    workbenchOpen,
    setWorkbenchOpen,
    pendingMentionInsert,
    setPendingMentionInsert,
  } = useChatStore();

  const { activeView } = useAppStore();
  const { isGenerating, sendMessage, retryMessage, cancelMessage } = useStreamChat();

  const [input, setInput] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [attachments, setAttachments] = useState<DraftChatAttachment[]>([]);
  const [toastMsg, setToastMsg] = useState('');

  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  const showToast = (msg: string, duration = 3000) => {
    setToastMsg(msg);
    window.setTimeout(() => setToastMsg(''), duration);
  };

  useEffect(() => {
    return () => {
      attachmentsRef.current.forEach((item) => URL.revokeObjectURL(item.previewUrl));
    };
  }, []);

  // 顶部两个控制开关状态：
  // 1. inspectorOpen: 控制当前会话右侧（图 4 绿色框区域）的工作空间与 Inspector 监控
  // 2. workbenchOpen: 控制最右侧额外扩展抽屉（内置浏览器/终端/文件树/Git Diff，由 chatStore 全局托管）
  const [inspectorOpen, setInspectorOpen] = useState(true);

  // 当从文件树点击“@引用”时，自动插入到当前输入框
  useEffect(() => {
    if (pendingMentionInsert) {
      setInput((prev) => {
        const prefix = prev && !prev.endsWith(' ') ? `${prev} ` : prev;
        return `${prefix}${pendingMentionInsert}`;
      });
      setPendingMentionInsert(null);
    }
  }, [pendingMentionInsert, setPendingMentionInsert]);

  const [enableTools, setEnableTools] = useState(true);

  const activeMessages = activeSessionId ? messages[activeSessionId] || [] : [];
  const activeToolCalls = activeSessionId ? toolCallsBySession[activeSessionId] || [] : [];
  const activeTodos = activeSessionId ? todosBySession[activeSessionId] || [] : [];
  const pendingPermission = activeSessionId ? permissionBySession[activeSessionId] || null : null;
  const activeSession = sessions.find((s) => s.id === activeSessionId);

  // 全局响应式模型列表 (过滤 chat 类型)
  const availableChatModels = models.filter((m) => !m.type || m.type === 'chat');

  // 同步选中的模型 (当全局模型池变化或会话切换时即时对齐)
  useEffect(() => {
    if (activeSessionId && availableChatModels.length > 0) {
      const sessionModel = activeSession?.model;
      const matchedModel = availableChatModels.find(
        (m) => m.id === sessionModel || m.model_id === sessionModel
      );
      const usableFallback = availableChatModels.find(
        (m) => m.api_key || m.provider === 'ollama'
      );
      const chosen = matchedModel?.id || usableFallback?.id || availableChatModels[0].id;
      setSelectedModel(chosen);
      if (!sessionModel || sessionModel !== chosen) {
        updateSessionModel(activeSessionId, chosen);
      }
    }
  }, [activeSessionId, availableChatModels, activeSession?.model]);

  // 初始化 Store 与全局模型池
  useEffect(() => {
    initStore();
    fetchModels();
  }, []);

  // 当会话改变或工作区更新时刷新 Inspector 数据
  useEffect(() => {
    if (activeSessionId) {
      refreshOutputs(activeSessionId);
      refreshGitStatus(activeSession?.workDir);
      refreshMcpAndSkills(activeSession?.workDir);
    }
  }, [activeSessionId, activeSession?.workDir]);

  // 离开 chat 视图时收起抽屉
  useEffect(() => {
    if (activeView !== 'chat') {
      setInspectorOpen(false);
      setWorkbenchOpen(false);
    }
  }, [activeView]);

  const handlePermissionResponse = (
    allow: boolean,
    decision?: 'allow_once' | 'allow_session' | 'switch_auto_sandbox' | 'deny'
  ) => {
    if (!pendingPermission || !activeSessionId) return;
    if (window.electronAPI?.respondPermission) {
      window.electronAPI.respondPermission(pendingPermission.id, allow, decision);
    }
    setSessionPermission(activeSessionId, null);
  };

  const handleSend = async () => {
    if (!input.trim() || !activeSessionId || isGenerating) return;
    const text = input;

    let savedAttachments: ChatAttachment[] = [];
    if (attachments.length > 0) {
      try {
        savedAttachments = await Promise.all(
          attachments.map(async (draft) => {
            const base64 = await readFileAsBase64(draft.file);
            const saved = await window.electronAPI.saveChatAttachment({
              sessionId: activeSessionId,
              name: draft.name,
              mime: draft.mime,
              base64,
            });
            return {
              id: saved.id,
              name: draft.name,
              mime: saved.mime,
              size: saved.size,
              width: saved.width,
              height: saved.height,
              path: saved.path,
              placeholder: draft.placeholder,
            } as ChatAttachment;
          })
        );
      } catch (err: any) {
        showToast(`图片保存失败: ${err?.message || '未知错误'}`);
        return;
      }
    }

    attachments.forEach((item) => URL.revokeObjectURL(item.previewUrl));
    setAttachments([]);
    setInput('');
    sendMessage(
      text,
      selectedModel || availableChatModels[0]?.id || 'model_chat_default',
      enableTools,
      {
        onCompaction: (data) => {
          setLastCompaction(data);
          showToast(
            `上下文已自动压缩：${formatTokenCount(data.beforeTokens)} → ${formatTokenCount(data.afterTokens)} tokens（保留最近 ${data.keptMessages} 条消息）`,
            4000
          );
        },
      },
      savedAttachments.length > 0 ? savedAttachments : undefined
    );
  };

  const handleRetry = (msg: any) => {
    if (isGenerating || !activeSessionId) return;
    retryMessage(
      msg.id,
      selectedModel || availableChatModels[0]?.id || 'model_chat_default',
      enableTools,
      {
        onCompaction: (data) => {
          setLastCompaction(data);
          showToast(
            `上下文已自动压缩：${formatTokenCount(data.beforeTokens)} → ${formatTokenCount(data.afterTokens)} tokens（保留最近 ${data.keptMessages} 条消息）`,
            4000
          );
        },
      }
    );
  };

  const handleRenameSession = (id: string, title: string) => {
    updateSessionTitle(id, title);
  };

  const handleSelectWorkDir = () => {
    openWorkspaceModal();
  };

  const handleSaveWorkspaceModal = async (updated: WorkspaceData) => {
    await saveWorkspace(updated);
    if (activeSessionId) {
      const primary = updated.folders.find((f) => f.isPrimary) || updated.folders[0];
      if (primary) {
        await setSessionWorkDir(activeSessionId, primary.path);
      }
    }
  };

  const handleCopy = (text: string) => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text);
    }
  };

  return (
    <div className='flex h-full w-full overflow-hidden relative'>
      <div
        className={`fixed top-6 left-1/2 -translate-x-1/2 z-[120] flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-xl shadow-2xl transition-all duration-300 ${
          toastMsg ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-4 pointer-events-none'
        }`}
      >
        <CheckCircle2 size={15} />
        <span className='text-xs font-medium'>{toastMsg}</span>
      </div>
      {/* 当前会话的主交互区 (包含顶部Header、左消息+贴底输入、右绿色框Inspector) */}
      <div className='flex-1 min-w-0 h-full flex flex-col overflow-hidden bg-[var(--ui-panel-bg)] border-r border-[color:var(--ui-divider-hairline)]'>
        <ChatHeader
          session={activeSession}
          leftPanelOpen={inspectorOpen}
          onToggleLeftPanel={() => setInspectorOpen(!inspectorOpen)}
          rightDrawerOpen={workbenchOpen}
          onToggleRightDrawer={() => setWorkbenchOpen(!workbenchOpen)}
        />

        {/* 会话内容交互容器 */}
        {!activeSessionId ? (
          <div className='flex-1 flex items-center justify-center text-[var(--ui-text-faint)] text-sm'>
            请在左侧选择或创建一个会话
          </div>
        ) : (
          <div className='flex-1 min-h-0 flex overflow-hidden bg-[var(--ui-stage-wrap-bg)]'>
            {/* 左侧：外层舞台增加 p-3 内边距，中央包裹为一个带圆角与微弱边界的舞台 Card */}
            <div className='flex-1 min-h-0 p-3 flex flex-col overflow-hidden'>
              <div className='flex-1 min-h-0 flex flex-col overflow-hidden bg-[var(--ui-stage-bg)] border border-[color:var(--ui-border-hairline)] rounded-2xl shadow-[var(--ui-stage-shadow)] relative'>
                <MessageList
                  messages={activeMessages}
                  isGenerating={isGenerating}
                  activeSearchProgress={null}
                  activeToolCalls={activeToolCalls}
                  activeTodos={activeTodos}
                  onCopy={handleCopy}
                  onRetry={handleRetry}
                />

                {/* 多场景沙箱与人机协同权限审批卡片 */}
                {pendingPermission && (
                  <div className='px-5 mb-2 w-full flex-shrink-0'>
                    <div className='w-full p-3 rounded-xl bg-[var(--ui-accent-amber-soft)] border border-[color:var(--ui-accent-amber-border)] text-xs flex items-center justify-between gap-3 shadow-sm select-none'>
                      <div className='flex items-center gap-2.5 min-w-0 pr-2'>
                        <div className='w-7 h-7 rounded-lg bg-[var(--ui-accent-amber-soft)] text-[var(--ui-accent-amber)] flex items-center justify-center flex-shrink-0'>
                          <ShieldAlert size={15} />
                        </div>
                        <div className='flex flex-col min-w-0 gap-0.5'>
                          <span className='font-semibold text-[var(--ui-text-primary)] flex items-center gap-1.5 truncate'>
                            <span>
                              {pendingPermission.kind === 'sandbox_escape'
                                ? '沙箱安全拦截 · 申请在沙箱外重试命令'
                                : pendingPermission.kind === 'dangerous_command'
                                ? '高危命令拦截 · 请确认操作风险'
                                : pendingPermission.kind === 'protected_write'
                                ? '受保护配置拦截 · 请求修改敏感工程配置'
                                : pendingPermission.kind === 'ask_write' || pendingPermission.kind === 'ask_command'
                                ? '询问确认模式 · 请确认是否执行此操作'
                                : '越界访问拦截 · 请求访问工作空间外部路径'}
                            </span>
                            <span className='px-1.5 py-0.2 rounded text-[10px] bg-[var(--ui-accent-amber-soft)] text-[var(--ui-accent-amber)] font-mono flex-shrink-0'>
                              {pendingPermission.action}
                            </span>
                          </span>
                          <span className='text-[11px] text-[var(--ui-text-secondary)] font-mono truncate' title={pendingPermission.command || pendingPermission.path}>
                            {pendingPermission.command ? `$ ${pendingPermission.command}` : pendingPermission.path}
                          </span>
                          {pendingPermission.reason && (
                            <span className='text-[11px] text-[var(--ui-text-muted)] truncate' title={pendingPermission.reason}>
                              {pendingPermission.reason}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className='flex items-center gap-2 flex-shrink-0'>
                        <button
                          onClick={() => handlePermissionResponse(false, 'deny')}
                          className='px-3 py-1.5 rounded-xl bg-[var(--ui-chip-bg)] hover:bg-[var(--ui-chip-hover-bg)] text-[var(--ui-text-secondary)] border border-[color:var(--ui-border-subtle)] text-xs font-medium transition-colors cursor-pointer'
                        >
                          拒绝
                        </button>

                        {pendingPermission.kind === 'sandbox_escape' ? (
                          <button
                            onClick={() => handlePermissionResponse(true, 'allow_once')}
                            className='px-3.5 py-1.5 rounded-xl bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold shadow-sm transition-colors cursor-pointer'
                          >
                            仅本次沙箱外重跑
                          </button>
                        ) : pendingPermission.allowSwitchAutoSandbox ? (
                          <>
                            <button
                              onClick={() => handlePermissionResponse(true, 'allow_once')}
                              className='px-3 py-1.5 rounded-xl bg-[var(--ui-chip-bg)] hover:bg-[var(--ui-chip-hover-bg)] text-[var(--ui-text-primary)] border border-[color:var(--ui-border-subtle)] text-xs font-medium transition-colors cursor-pointer'
                            >
                              仅本次允许
                            </button>
                            <button
                              onClick={() => handlePermissionResponse(true, 'switch_auto_sandbox')}
                              className='px-3.5 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-sm transition-colors cursor-pointer'
                            >
                              切换为工作区沙箱并允许
                            </button>
                          </>
                        ) : pendingPermission.kind === 'external_path' ? (
                          <>
                            <button
                              onClick={() => handlePermissionResponse(true, 'allow_once')}
                              className='px-3 py-1.5 rounded-xl bg-[var(--ui-chip-bg)] hover:bg-[var(--ui-chip-hover-bg)] text-[var(--ui-text-primary)] border border-[color:var(--ui-border-subtle)] text-xs font-medium transition-colors cursor-pointer'
                            >
                              仅本次允许
                            </button>
                            <button
                              onClick={() => handlePermissionResponse(true, 'allow_session')}
                              className='px-3.5 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-sm transition-colors cursor-pointer'
                            >
                              允许并加入会话白名单
                            </button>
                          </>
                        ) : (
                          <button
                            onClick={() => handlePermissionResponse(true, 'allow_once')}
                            className='px-3.5 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-sm transition-colors cursor-pointer'
                          >
                            确认并允许本次执行
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                <MessageInput
                  value={input}
                  onChange={setInput}
                  onSend={handleSend}
                  isGenerating={isGenerating}
                  disabled={!activeSessionId}
                  containerWidth={0}
                  workDir={activeSession?.workDir || null}
                  onSelectWorkDir={handleSelectWorkDir}
                  permissionMode={activeSession?.permissionMode || 'auto-sandbox'}
                  onChangePermissionMode={(mode) => {
                    if (activeSessionId) {
                      setSessionPermissionMode(activeSessionId, mode);
                    }
                  }}
                  attachments={attachments}
                  onChangeAttachments={setAttachments}
                  onNotify={showToast}
                  onCancel={cancelMessage}
                  selectedModel={selectedModel}
                  chatModels={availableChatModels}
                  onChangeModel={(val) => {
                    setSelectedModel(val);
                    if (activeSessionId) {
                      updateSessionModel(activeSessionId, val);
                    }
                  }}
                />
              </div>
            </div>

            {/* 右侧：原红色框内容正式迁移至此绿色框区域！随当前会话上下文实时同步 */}
            <SessionInspectorColumn isOpen={inspectorOpen} />
          </div>
        )}
      </div>

      {/* 栏 3: 最右侧扩展抽屉 (内置浏览器 / 网页测试 / 终端 / 文件树 / Git Diff) */}
      <WebWorkspaceDrawer
        isOpen={workbenchOpen}
        onClose={() => setWorkbenchOpen(false)}
      />

      {/* 100% 还原参考图 8 的编辑工作空间 Modal 弹窗 */}
      <EditWorkspaceModal
        isOpen={isWorkspaceModalOpen}
        workspace={activeEditingWorkspace}
        onClose={closeWorkspaceModal}
        onSave={handleSaveWorkspaceModal}
        onDelete={async (id) => {
          await deleteWorkspace(id);
        }}
      />
    </div>
  );
};

export default ChatView;
