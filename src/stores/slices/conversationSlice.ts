import { StateCreator } from "zustand";
import type {
  ChatState,
  Message,
  ContextMetrics,
  CompactionInfo,
  QueuedPrompt,
} from "../chatStore";

export interface ConversationSlice {
  messages: Record<string, Message[]>;
  generatingBySession: Record<string, boolean>;
  sessionStartTimeBySession: Record<string, number | null>;
  waitingBySession: Record<string, number>;
  toolCallsBySession: Record<string, any[]>;
  todosBySession: Record<string, any[]>;
  permissionBySession: Record<string, any | null>;
  contextMetricsBySession: Record<string, ContextMetrics | null>;
  contextMetrics: ContextMetrics | null;
  lastCompaction: CompactionInfo | null;
  promptQueueBySession: Record<string, QueuedPrompt[]>;

  addMessage: (sessionId: string, message: Message, skipDb?: boolean) => Promise<void>;
  appendMessageDelta: (
    sessionId: string,
    messageId: string,
    delta: string
  ) => void;
  appendMessageReasoning: (
    sessionId: string,
    messageId: string,
    delta: string
  ) => void;
  saveMessageToDb: (sessionId: string, message: Message) => Promise<void>;
  updateMessageMetadata: (sessionId: string, messageId: string, metadata: any) => void;
  truncateMessages: (
    sessionId: string,
    messageId: string,
    includeTarget?: boolean
  ) => Promise<void>;

  setSessionGenerating: (sessionId: string, isGenerating: boolean) => void;
  setSessionStartTime: (sessionId: string, startTime: number | null) => void;
  setSessionWaiting: (sessionId: string, idleSec: number) => void;
  upsertSessionToolCall: (sessionId: string, status: any) => void;
  clearSessionToolCalls: (sessionId: string) => void;
  setSessionTodos: (sessionId: string, todos: any[]) => void;
  setSessionPermission: (sessionId: string, perm: any | null) => void;
  setContextMetrics: (metrics: ContextMetrics | null, sessionId?: string) => void;
  setLastCompaction: (data: CompactionInfo | null) => void;

  enqueuePrompt: (sessionId: string, prompt: QueuedPrompt) => void;
  dequeuePrompt: (sessionId: string) => QueuedPrompt | null;
  removeQueuedPrompt: (sessionId: string, promptId: string) => void;
  moveQueuedPromptToTop: (sessionId: string, promptId: string) => void;
  updateQueuedPrompt: (sessionId: string, promptId: string, newContent: string) => void;
  clearPromptQueue: (sessionId: string) => void;
}

export const createConversationSlice: StateCreator<
  ChatState,
  [],
  [],
  ConversationSlice
> = (set, get) => ({
  messages: {},
  generatingBySession: {},
  sessionStartTimeBySession: {},
  waitingBySession: {},
  toolCallsBySession: {},
  todosBySession: {},
  permissionBySession: {},
  contextMetricsBySession: {},
  contextMetrics: null,
  lastCompaction: null,
  promptQueueBySession: {},

  addMessage: async (sessionId, message, skipDb = false) => {
    set((state) => ({
      messages: {
        ...state.messages,
        [sessionId]: [...(state.messages[sessionId] || []), message],
      },
    }));

    if (!skipDb && window.electronAPI?.dbAddMessage) {
      try {
        await window.electronAPI.dbAddMessage({
          id: message.id,
          sessionId,
          role: message.role,
          content: message.content,
          metadata: message.metadata,
          reasoning: message.reasoning,
        });
      } catch (err) {
        console.error("持久化消息失败:", err);
      }
    }
  },

  appendMessageDelta: (sessionId, messageId, delta) => {
    set((state) => {
      const currentMsgs = state.messages[sessionId] || [];
      const msgIndex = currentMsgs.findIndex((m) => m.id === messageId);
      if (msgIndex === -1) return state;

      const updatedMsgs = [...currentMsgs];
      const targetMsg = updatedMsgs[msgIndex];
      updatedMsgs[msgIndex] = {
        ...targetMsg,
        content: targetMsg.content + delta,
      };

      return {
        messages: {
          ...state.messages,
          [sessionId]: updatedMsgs,
        },
      };
    });
  },

  appendMessageReasoning: (sessionId, messageId, delta) => {
    if (!delta) return;
    set((state) => {
      const currentMsgs = state.messages[sessionId] || [];
      const msgIndex = currentMsgs.findIndex((m) => m.id === messageId);
      if (msgIndex === -1) return state;

      const updatedMsgs = [...currentMsgs];
      const targetMsg = updatedMsgs[msgIndex];
      const nextReasoning = `${targetMsg.reasoning || ""}${delta}`;
      updatedMsgs[msgIndex] = {
        ...targetMsg,
        reasoning: nextReasoning,
        reasoningChars: nextReasoning.length,
      };

      return {
        messages: {
          ...state.messages,
          [sessionId]: updatedMsgs,
        },
      };
    });
  },

  saveMessageToDb: async (sessionId, message) => {
    if (!window.electronAPI?.dbAddMessage) return;
    try {
      await window.electronAPI.dbAddMessage({
        id: message.id,
        sessionId,
        role: message.role,
        content: message.content,
        metadata: message.metadata,
        reasoning: message.reasoning,
      });
    } catch (err) {
      console.error("保存消息到存储失败:", err);
    }
  },

  updateMessageMetadata: (sessionId, messageId, metadata) => {
    set((state) => {
      const currentMsgs = state.messages[sessionId] || [];
      const msgIndex = currentMsgs.findIndex((m) => m.id === messageId);
      if (msgIndex === -1) return state;

      const updatedMsgs = [...currentMsgs];
      updatedMsgs[msgIndex] = {
        ...updatedMsgs[msgIndex],
        metadata,
      };

      return {
        messages: {
          ...state.messages,
          [sessionId]: updatedMsgs,
        },
      };
    });
  },

  truncateMessages: async (sessionId, messageId, includeTarget = true) => {
    const currentMsgs = get().messages[sessionId] || [];
    const targetMsg = currentMsgs.find((m) => m.id === messageId);
    if (!targetMsg) return;

    const filtered = currentMsgs.filter((m) =>
      includeTarget
        ? m.createdAt <= targetMsg.createdAt
        : m.createdAt < targetMsg.createdAt
    );
    const removed = currentMsgs.filter((m) =>
      includeTarget
        ? m.createdAt > targetMsg.createdAt
        : m.createdAt >= targetMsg.createdAt
    );
    const cutoff = includeTarget ? targetMsg.createdAt : targetMsg.createdAt - 1;

    set((state) => ({
      messages: {
        ...state.messages,
        [sessionId]: filtered,
      },
    }));

    if (window.electronAPI) {
      try {
        await window.electronAPI.dbDeleteMessagesAfter(sessionId, cutoff);
      } catch (err) {
        console.error("截断消息失败:", err);
      }

      // 清理已删除消息关联的附件物理文件
      for (const msg of removed) {
        const attList = msg.metadata?.attachments;
        if (!Array.isArray(attList)) continue;
        for (const attachment of attList) {
          if (!attachment?.path) continue;
          try {
            await window.electronAPI.deleteChatAttachment(attachment.path);
          } catch (err) {
            console.error("清理附件失败:", err);
          }
        }
      }
    }
  },

  setSessionGenerating: (sessionId, isGenerating) =>
    set((state) => ({
      generatingBySession: {
        ...state.generatingBySession,
        [sessionId]: isGenerating,
      },
    })),

  setSessionStartTime: (sessionId, startTime) =>
    set((state) => ({
      sessionStartTimeBySession: {
        ...state.sessionStartTimeBySession,
        [sessionId]: startTime,
      },
    })),

  setSessionWaiting: (sessionId, idleSec) =>
    set((state) => {
      if ((state.waitingBySession[sessionId] || 0) === idleSec) return state;
      return {
        waitingBySession: {
          ...state.waitingBySession,
          [sessionId]: idleSec,
        },
      };
    }),

  upsertSessionToolCall: (sessionId, status) =>
    set((state) => {
      const prev = state.toolCallsBySession[sessionId] || [];
      const matched = prev.some((t) => t.tool === status.tool && t.callId && t.callId === status.callId);
      const next = matched
        ? prev.map((t) => (t.tool === status.tool && t.callId === status.callId ? status : t))
        : [...prev, status];
      return {
        toolCallsBySession: {
          ...state.toolCallsBySession,
          [sessionId]: next,
        },
      };
    }),

  clearSessionToolCalls: (sessionId) =>
    set((state) => ({
      toolCallsBySession: {
        ...state.toolCallsBySession,
        [sessionId]: [],
      },
    })),

  setSessionTodos: (sessionId, todos) =>
    set((state) => ({
      todosBySession: {
        ...state.todosBySession,
        [sessionId]: Array.isArray(todos) ? todos : [],
      },
    })),

  setSessionPermission: (sessionId, perm) =>
    set((state) => ({
      permissionBySession: {
        ...state.permissionBySession,
        [sessionId]: perm,
      },
    })),

  setContextMetrics: (metrics, sessionId) =>
    set((state) => {
      const targetId = sessionId || state.activeSessionId;
      const nextBySession = targetId
        ? { ...state.contextMetricsBySession, [targetId]: metrics }
        : state.contextMetricsBySession;
      const shouldUpdateCurrent = !sessionId || sessionId === state.activeSessionId;
      return {
        contextMetricsBySession: nextBySession,
        ...(shouldUpdateCurrent ? { contextMetrics: metrics } : {}),
      };
    }),

  setLastCompaction: (data) => set({ lastCompaction: data }),

  enqueuePrompt: (sessionId, prompt) =>
    set((state) => {
      const current = state.promptQueueBySession[sessionId] || [];
      return {
        promptQueueBySession: {
          ...state.promptQueueBySession,
          [sessionId]: [...current, prompt],
        },
      };
    }),

  dequeuePrompt: (sessionId) => {
    const queue = get().promptQueueBySession[sessionId] || [];
    if (queue.length === 0) return null;
    const [first, ...rest] = queue;
    set((state) => ({
      promptQueueBySession: {
        ...state.promptQueueBySession,
        [sessionId]: rest,
      },
    }));
    return first;
  },

  removeQueuedPrompt: (sessionId, promptId) =>
    set((state) => {
      const current = state.promptQueueBySession[sessionId] || [];
      return {
        promptQueueBySession: {
          ...state.promptQueueBySession,
          [sessionId]: current.filter((p) => p.id !== promptId),
        },
      };
    }),

  moveQueuedPromptToTop: (sessionId, promptId) =>
    set((state) => {
      const current = state.promptQueueBySession[sessionId] || [];
      const idx = current.findIndex((p) => p.id === promptId);
      if (idx <= 0) return state;
      const target = current[idx];
      const next = [target, ...current.slice(0, idx), ...current.slice(idx + 1)];
      return {
        promptQueueBySession: {
          ...state.promptQueueBySession,
          [sessionId]: next,
        },
      };
    }),

  updateQueuedPrompt: (sessionId, promptId, newContent) =>
    set((state) => {
      const current = state.promptQueueBySession[sessionId] || [];
      return {
        promptQueueBySession: {
          ...state.promptQueueBySession,
          [sessionId]: current.map((p) =>
            p.id === promptId ? { ...p, content: newContent } : p
          ),
        },
      };
    }),

  clearPromptQueue: (sessionId) =>
    set((state) => ({
      promptQueueBySession: {
        ...state.promptQueueBySession,
        [sessionId]: [],
      },
    })),
});
