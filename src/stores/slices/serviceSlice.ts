import { StateCreator } from "zustand";
import type {
  ChatState,
  SessionOutput,
  WorkspaceGitStatus,
  McpServerItem,
  SkillItem,
  SubagentItem,
} from "../chatStore";

export interface ServiceSlice {
  outputs: SessionOutput[];
  gitStatus: WorkspaceGitStatus | null;
  mcpServers: McpServerItem[];
  skills: SkillItem[];
  subagents: SubagentItem[];

  refreshOutputs: (sessionId: string) => Promise<void>;
  refreshGitStatus: (workDir?: string | null) => Promise<void>;
  refreshMcpAndSkills: (workDir?: string | null) => Promise<void>;
}

export const createServiceSlice: StateCreator<
  ChatState,
  [],
  [],
  ServiceSlice
> = (set, get) => ({
  outputs: [],
  gitStatus: null,
  mcpServers: [],
  skills: [],
  subagents: [],

  refreshOutputs: async (sessionId) => {
    if (!window.electronAPI?.getSessionOutputs || !sessionId) return;
    try {
      const outs = await window.electronAPI.getSessionOutputs(sessionId);
      set({ outputs: outs || [] });
    } catch (err) {
      console.error("刷新 Outputs 失败:", err);
    }
  },

  refreshGitStatus: async (workDir) => {
    if (!window.electronAPI?.getWorkspaceGitStatus) return;
    try {
      const status = await window.electronAPI.getWorkspaceGitStatus(workDir || null);
      set({ gitStatus: status || null });
    } catch (err) {
      console.error("刷新 Git 状态失败:", err);
    }
  },

  refreshMcpAndSkills: async (workDir) => {
    if (!window.electronAPI) return;
    try {
      const [mcps, skills, subagents] = await Promise.all([
        window.electronAPI.getMcpServers ? window.electronAPI.getMcpServers(workDir) : [],
        window.electronAPI.getSkills ? window.electronAPI.getSkills(workDir) : [],
        window.electronAPI.getSubagents ? window.electronAPI.getSubagents(workDir) : [],
      ]);
      set({ mcpServers: mcps || [], skills: skills || [], subagents: subagents || [] });

      // 联动重算 ContextMetrics (由主进程基于真实环境构建计算)
      const activeSessionId = get().activeSessionId;
      const currentMsgs = activeSessionId ? get().messages[activeSessionId] || [] : [];
      if (window.electronAPI.getContextMetrics && activeSessionId) {
        const metrics = await window.electronAPI.getContextMetrics({
          sessionId: activeSessionId,
          workDir: workDir || null,
          messages: currentMsgs,
        });
        if (metrics) {
          get().setContextMetrics(metrics, activeSessionId);
        }
      }
    } catch (err) {
      console.error("刷新 MCP 和 Skills 失败:", err);
    }
  },
});
