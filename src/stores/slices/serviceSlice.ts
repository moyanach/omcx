import { StateCreator } from "zustand";
import { invalidateFileIndex } from "@/lib/fileMention";
import type {
  ChatState,
  SessionOutput,
  WorkspaceGitStatus,
  McpServerItem,
  SkillItem,
  SubagentItem,
} from "../chatStore";

// 各类监控数据的请求序号：只允许最新一次请求落地，避免快速切换会话时旧响应覆盖新状态
let outputsRefreshSeq = 0;
let gitRefreshSeq = 0;
let mcpRefreshSeq = 0;

export interface WorkspaceChangedEvent {
  workDir?: string | null;
  reason?: string;
  areas?: string[];
  paths?: string[];
  ts?: number;
}

export interface ServiceSlice {
  outputs: SessionOutput[];
  gitStatus: WorkspaceGitStatus | null;
  gitRevision: number;
  filesRevision: number;
  specsRevision: number;
  commandsRevision: number;
  wikiRevision: number;
  mcpServers: McpServerItem[];
  skills: SkillItem[];
  subagents: SubagentItem[];

  refreshOutputs: (sessionId: string) => Promise<void>;
  refreshGitStatus: (workDir?: string | null) => Promise<void>;
  notifyGitUpdated: () => void;
  handleWorkspaceChanged: (payload?: WorkspaceChangedEvent) => void;
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
  gitRevision: 0,
  filesRevision: 0,
  specsRevision: 0,
  commandsRevision: 0,
  wikiRevision: 0,
  mcpServers: [],
  skills: [],
  subagents: [],

  notifyGitUpdated: () => set((s) => ({ gitRevision: s.gitRevision + 1 })),

  handleWorkspaceChanged: (payload) => {
    const areas =
      Array.isArray(payload?.areas) && payload.areas.length > 0
        ? payload.areas
        : ["files", "git"];
    const has = (name: string) => areas.includes("all") || areas.includes(name);

    const state = get();
    const activeSession = state.sessions.find((s) => s.id === state.activeSessionId);
    const activeWorkDir = activeSession?.workDir || null;

    if (has("files")) {
      if (!payload?.workDir || payload.reason === "window_focus" || payload.reason === "workspace_config") {
        invalidateFileIndex();
      } else {
        invalidateFileIndex(payload.workDir);
        if (activeWorkDir && activeWorkDir !== payload.workDir) {
          invalidateFileIndex(activeWorkDir);
        }
      }
    }

    const bumpFiles = has("files");
    const bumpGit = has("git");
    const bumpSpecs = has("specs") || has("worktrees");
    const bumpCommands =
      has("commands") || has("skills") || has("subagents") || has("mcp");
    const bumpWiki = has("wiki");

    set((s) => ({
      filesRevision: bumpFiles ? s.filesRevision + 1 : s.filesRevision,
      gitRevision: bumpGit ? s.gitRevision + 1 : s.gitRevision,
      specsRevision: bumpSpecs ? s.specsRevision + 1 : s.specsRevision,
      commandsRevision: bumpCommands ? s.commandsRevision + 1 : s.commandsRevision,
      wikiRevision: bumpWiki ? s.wikiRevision + 1 : s.wikiRevision,
    }));

    if (activeWorkDir && bumpGit) {
      void get().refreshGitStatus(activeWorkDir);
    }
    if (has("skills") || has("subagents") || has("mcp")) {
      void get().refreshMcpAndSkills(activeWorkDir);
    }
  },

  refreshOutputs: async (sessionId) => {
    if (!window.electronAPI?.getSessionOutputs || !sessionId) return;
    const seq = ++outputsRefreshSeq;
    try {
      const outs = await window.electronAPI.getSessionOutputs(sessionId);
      if (seq !== outputsRefreshSeq || get().activeSessionId !== sessionId) return;
      set({ outputs: outs || [] });
    } catch (err) {
      console.error("刷新 Outputs 失败:", err);
    }
  },

  refreshGitStatus: async (workDir) => {
    if (!window.electronAPI?.getWorkspaceGitStatus) return;
    const seq = ++gitRefreshSeq;
    try {
      const status = await window.electronAPI.getWorkspaceGitStatus(workDir || null);
      if (seq !== gitRefreshSeq) return;
      set({ gitStatus: status || null });
    } catch (err) {
      console.error("刷新 Git 状态失败:", err);
    }
  },

  refreshMcpAndSkills: async (workDir) => {
    if (!window.electronAPI) return;
    const seq = ++mcpRefreshSeq;
    try {
      const [mcps, skills, subagents] = await Promise.all([
        window.electronAPI.getMcpServers ? window.electronAPI.getMcpServers(workDir) : [],
        window.electronAPI.getSkills ? window.electronAPI.getSkills(workDir, true) : [],
        window.electronAPI.getSubagents ? window.electronAPI.getSubagents(workDir) : [],
      ]);
      if (seq !== mcpRefreshSeq) return;
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
        if (seq !== mcpRefreshSeq || get().activeSessionId !== activeSessionId) return;
        if (metrics) {
          get().setContextMetrics(metrics, activeSessionId);
        }
      }
    } catch (err) {
      console.error("刷新 MCP 和 Skills 失败:", err);
    }
  },
});
