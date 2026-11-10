/**
 * chatStore.ts — 全局状态管理中心 (基于 Zustand Slices 架构)
 *
 * 架构重构 (阶段三)：
 * 1. 物理切片解耦：
 *    - sessionSlice: 会话生命周期、多目录工作空间、全局模型池
 *    - conversationSlice: 消息流水、流式状态机、工具步骤、排队队列、上下文指标
 *    - workbenchSlice: 右侧扩展工作台 Tabs、代码预览、集成终端、Diff 浏览器
 *    - serviceSlice: 导出产物、Git 状态同步、MCP 与声明式技能
 * 2. 100% 保持对外 API / 状态结构向后兼容，所有视图零成本平滑无缝消费；
 * 3. 导出常用的高性能细粒度 Selector 助手函数，阻断无谓的级联重渲染。
 */

import { create } from "zustand";
import { createSessionSlice, SessionSlice } from "./slices/sessionSlice";
import { createConversationSlice, ConversationSlice } from "./slices/conversationSlice";
import { createWorkbenchSlice, WorkbenchSlice } from "./slices/workbenchSlice";
import { createServiceSlice, ServiceSlice } from "./slices/serviceSlice";

// ─── 全局类型定义 (保持 100% 兼容) ─────────────────────

export interface ChatAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  width?: number;
  height?: number;
  path: string;
  placeholder: string;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  metadata?: any;
  attachments?: ChatAttachment[];
}

export type PermissionMode = "plan" | "auto-sandbox" | "ask" | "full-access";
export type ReasoningEffort = "off" | "low" | "medium" | "high" | "max";

export interface Session {
  id: string;
  title: string;
  title_source?: string;
  updatedAt: number;
  model?: string;
  workspaceId?: string;
  workDir?: string;
  permissionMode?: PermissionMode;
  reasoningEffort?: ReasoningEffort;
  archived?: boolean;
}

export interface ContextBreakdownItem {
  tokens: number;
  formatted: string;
  percent: number;
  color: string;
  label: string;
}

export interface QueuedPrompt {
  id: string;
  sessionId: string;
  content: string;
  attachments?: ChatAttachment[];
  modelId?: string;
  enableTools?: boolean;
  createdAt: number;
}

export interface CompactionInfo {
  at: number;
  beforeTokens: number;
  afterTokens: number;
  keptMessages: number;
  summarizedMessages: number;
}

export interface ContextMetrics {
  totalLimit: number;
  totalLimitFormatted: string;
  usedTokens: number;
  usedTokensFormatted: string;
  usedPercent: number;
  breakdown: {
    messages: ContextBreakdownItem;
    systemTools: ContextBreakdownItem;
    systemPrompt: ContextBreakdownItem;
    skills: ContextBreakdownItem;
    freeSpace: ContextBreakdownItem;
  };
}

export interface SessionOutput {
  id: string;
  name: string;
  filePath: string;
  fileType: string;
  createdAt: number;
}

export interface WorkbenchTab {
  id: string;
  title: string;
  type: "newtab" | "url" | "files" | "changes" | "terminal";
  url?: string;
  filePath?: string;
  lineNumber?: number;
  lineEnd?: number;
  viewMode?: "preview" | "code";
  refreshKey?: number;
}

export interface WorkspaceGitStatus {
  isGit: boolean;
  branch?: string;
  insertions: number;
  deletions: number;
  modifiedFiles: Array<{ path: string; status: string }>;
}

export interface McpServerItem {
  id: string;
  name: string;
  command: string;
  args: string[];
  description: string;
  enabled: boolean;
}

export interface SkillItem {
  id: string;
  name: string;
  description: string;
  tools: string[];
  scope: string;
}

export interface SubagentItem {
  id: string;
  name: string;
  description: string;
  tools: string[];
  readOnly: boolean;
  modelTier?: string;
  maxRounds?: number;
  scope: string;
  filePath?: string;
  systemPrompt?: string;
}

export interface WorkspaceFolder {
  path: string;
  name: string;
  isPrimary?: boolean;
}

export interface WorkspaceItem {
  id: string;
  name: string;
  folders: WorkspaceFolder[];
  updatedAt?: number;
}

export interface LlmModelItem {
  id: string;
  model_id: string;
  name: string;
  type: string;
  provider: string;
  base_url: string;
  api_key?: string;
  context_limit?: number;
}

// ─── 统一的全局 ChatState 接口 (四大切片聚合) ───────────

export type ChatState = SessionSlice &
  ConversationSlice &
  WorkbenchSlice &
  ServiceSlice;

// ─── 主 Store 实例化 ───────────────────────────────────

export const useChatStore = create<ChatState>()((...a) => ({
  ...createSessionSlice(...a),
  ...createConversationSlice(...a),
  ...createWorkbenchSlice(...a),
  ...createServiceSlice(...a),
}));

// ─── 高性能细粒度 Selector 助手函数 ───────────────────
// 针对性订阅，消除无关字段更新引发的级联渲染

export const selectActiveSession = (state: ChatState) =>
  state.sessions.find((s) => s.id === state.activeSessionId);

export const selectActiveMessages = (state: ChatState) =>
  state.activeSessionId ? state.messages[state.activeSessionId] || [] : [];

export const selectActiveTodos = (state: ChatState) =>
  state.activeSessionId ? state.todosBySession[state.activeSessionId] || [] : [];

export const selectActiveToolCalls = (state: ChatState) =>
  state.activeSessionId ? state.toolCallsBySession[state.activeSessionId] || [] : [];

export const selectIsGenerating = (sessionId: string | null) => (state: ChatState) =>
  Boolean(sessionId && state.generatingBySession[sessionId]);

export const selectActivePromptQueue = (state: ChatState) =>
  state.activeSessionId ? state.promptQueueBySession[state.activeSessionId] || [] : [];
