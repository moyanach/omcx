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
    initStore,
    updateSessionModel,
    updateSessionTitle,
    setSessionWorkDir,
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
  } = useChatStore();

  const { activeView } = useAppStore();
  const { isGenerating, sendMessage, retryMessage } = useStreamChat();

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
  // 2. browserDrawerOpen: 控制最右侧额外扩展抽屉（图 3 的内置浏览器/终端/工具）
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [browserDrawerOpen, setBrowserDrawerOpen] = useState(false);

  const [enableTools, setEnableTools] = useState(true);
  const [activeToolCalls, setActiveToolCalls] = useState<any[]>([]);
  const [activeTodos, setActiveTodos] = useState<any[]>([]);

  const activeMessages = activeSessionId ? messages[activeSessionId] || [] : [];
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
      setBrowserDrawerOpen(false);
    }
  }, [activeView]);

  // 外部路径越界访问人机协同审批请求
  const [pendingPermission, setPendingPermission] = useState<{
    id: string;
    path: string;
    action: string;
    reason: string;
  } | null>(null);

  const handlePermissionResponse = (allow: boolean) => {
    if (!pendingPermission) return;
    if (window.electronAPI?.respondPermission) {
      window.electronAPI.respondPermission(pendingPermission.id, allow);
    }
    setPendingPermission(null);
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
    setActiveToolCalls([]);
    setActiveTodos([]);
    setPendingPermission(null);
    sendMessage(
      text,
      selectedModel || availableChatModels[0]?.id || 'model_chat_default',
      enableTools,
      {
        onToolStatus: (status) => {
          setActiveToolCalls((prev) => {
            if (status.status === 'running') {
              return [...prev, status];
            }
            return prev.map((t) =>
              t.tool === status.tool && t.callId === status.callId ? status : t
            );
          });
        },
        onPermissionRequest: (perm) => {
          setPendingPermission(perm);
        },
        onTodosUpdate: (todos) => {
          setActiveTodos(todos);
        },
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
    setActiveToolCalls([]);
    setActiveTodos([]);
    setPendingPermission(null);
    retryMessage(
      msg.id,
      selectedModel || availableChatModels[0]?.id || 'model_chat_default',
      enableTools,
      {
        onToolStatus: (status) => {
          setActiveToolCalls((prev) => {
            if (status.status === 'running') {
              return [...prev, status];
            }
            return prev.map((t) =>
              t.tool === status.tool && t.callId === status.callId ? status : t
            );
          });
        },
        onPermissionRequest: (perm) => {
          setPendingPermission(perm);
        },
        onTodosUpdate: (todos) => {
          setActiveTodos(todos);
        },
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
    <div className='flex h-full w-full overflow-hidden bg-[#141414]'>
      <div
        className={`fixed top-6 left-1/2 -translate-x-1/2 z-[120] flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-xl shadow-2xl transition-all duration-300 ${
          toastMsg ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-4 pointer-events-none'
        }`}
      >
        <CheckCircle2 size={15} />
        <span className='text-xs font-medium'>{toastMsg}</span>
      </div>
      {/* 当前会话的主交互区 (包含顶部Header、左消息+贴底输入、右绿色框Inspector) */}
      <div className='flex-1 h-full flex flex-col overflow-hidden bg-[#161616] border-r border-[#242424]'>
        <ChatHeader
          session={activeSession}
          leftPanelOpen={inspectorOpen}
          onToggleLeftPanel={() => setInspectorOpen(!inspectorOpen)}
          rightDrawerOpen={browserDrawerOpen}
          onToggleRightDrawer={() => setBrowserDrawerOpen(!browserDrawerOpen)}
        />

        {/* 会话内容交互容器 */}
        {!activeSessionId ? (
          <div className='flex-1 flex items-center justify-center text-neutral-500 text-sm'>
            请在左侧选择或创建一个会话
          </div>
        ) : (
          <div className='flex-1 min-h-0 flex overflow-hidden bg-[#131313]'>
            {/* 左侧：外层舞台增加 p-3 内边距，中央包裹为一个带圆角与细腻阴影的大 Card */}
            <div className='flex-1 min-h-0 p-3 flex flex-col overflow-hidden'>
              <div className='flex-1 min-h-0 flex flex-col overflow-hidden bg-[#181818] border border-[#262626] rounded-2xl shadow-2xl shadow-black/50 relative'>
                <MessageList
                  messages={activeMessages}
                  isGenerating={isGenerating}
                  activeSearchProgress={null}
                  activeToolCalls={activeToolCalls}
                  activeTodos={activeTodos}
                  onCopy={handleCopy}
                  onRetry={handleRetry}
                />

                {/* 外部路径越界访问人机协同审批卡片 (全宽 px-5 对齐，不再写死 90%) */}
                {pendingPermission && (
                  <div className='px-5 mb-2 w-full flex-shrink-0'>
                    <div className='w-full p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs flex items-center justify-between gap-3 shadow-lg select-none'>
                      <div className='flex items-center gap-2.5 min-w-0 pr-2'>
                        <div className='w-7 h-7 rounded-lg bg-amber-500/20 text-amber-400 flex items-center justify-center flex-shrink-0'>
                          <ShieldAlert size={15} />
                        </div>
                        <div className='flex flex-col min-w-0'>
                          <span className='font-semibold text-neutral-100 flex items-center gap-1.5 truncate'>
                            <span>Agent 正在请求访问未绑定的外部路径</span>
                            <span className='px-1.5 py-0.2 rounded text-[10px] bg-amber-500/20 text-amber-300 font-mono'>
                              {pendingPermission.action}
                            </span>
                          </span>
                          <span className='text-[11px] text-neutral-400 font-mono truncate' title={pendingPermission.path}>
                            {pendingPermission.path}
                          </span>
                        </div>
                      </div>

                      <div className='flex items-center gap-2 flex-shrink-0'>
                        <button
                          onClick={() => handlePermissionResponse(false)}
                          className='px-3 py-1.5 rounded-xl bg-[#222222] hover:bg-[#2c2c2c] text-neutral-300 hover:text-white border border-[#333333] text-xs font-medium transition-colors cursor-pointer'
                        >
                          拒绝
                        </button>
                        <button
                          onClick={() => handlePermissionResponse(true)}
                          className='px-3.5 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-md transition-colors cursor-pointer'
                        >
                          允许并继续
                        </button>
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
                  attachments={attachments}
                  onChangeAttachments={setAttachments}
                  onNotify={showToast}
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

      {/* 栏 3: 最右侧扩展抽屉 (内置浏览器 / 网页测试 / 终端 / 文件树) */}
      <WebWorkspaceDrawer
        isOpen={browserDrawerOpen}
        onClose={() => setBrowserDrawerOpen(false)}
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
