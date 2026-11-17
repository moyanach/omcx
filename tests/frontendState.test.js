const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
const esbuild = require("esbuild");

function loadChatStoreInTestEnv() {
  // 提供极简 window/localStorage 垫片供 Zustand Store 在 Node 下运行
  const memStore = new Map();
  global.window = {
    localStorage: {
      getItem: (k) => (memStore.has(k) ? memStore.get(k) : null),
      setItem: (k, v) => memStore.set(k, String(v)),
      removeItem: (k) => memStore.delete(k),
    },
    electronAPI: {
      dbAddMessage: async () => ({ success: true }),
      dbGetMessages: async () => [],
      dbGetSessionOutputs: async () => [],
      dbAddSession: async () => ({ success: true }),
      dbDeleteMessagesAfter: async () => ({ success: true }),
    },
  };

  const entryPath = path.resolve(__dirname, "../src/stores/chatStore.ts");
  const built = esbuild.buildSync({
    entryPoints: [entryPath],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    alias: {
      "@": path.resolve(__dirname, "../src"),
    },
    external: ["zustand", "zustand/*"],
  });

  const code = built.outputFiles[0].text;
  const mod = new Module(entryPath);
  mod.filename = entryPath;
  mod.paths = Module._nodeModulePaths(path.dirname(entryPath));
  mod._compile(code, entryPath);
  return mod.exports.useChatStore;
}

test("chatStore sessionSlice 消息缓存淘汰上限 (MAX=3) 且保护活跃与生成中会话", async () => {
  const useChatStore = loadChatStoreInTestEnv();

  const sessions = [
    { id: "s1", title: "S1", updatedAt: 100 },
    { id: "s2", title: "S2", updatedAt: 200 },
    { id: "s3", title: "S3", updatedAt: 300 },
    { id: "s4", title: "S4", updatedAt: 400 },
    { id: "s5", title: "S5", updatedAt: 500 },
  ];

  useChatStore.setState({
    sessions,
    activeSessionId: "s1",
    generatingBySession: { s2: true },
    messages: {
      s1: [{ id: "m1", role: "user", content: "1", createdAt: 1 }],
      s2: [{ id: "m2", role: "user", content: "2", createdAt: 2 }],
      s3: [{ id: "m3", role: "user", content: "3", createdAt: 3 }],
      s4: [{ id: "m4", role: "user", content: "4", createdAt: 4 }],
    },
  });

  // 切换到 s5 触发 LRU 淘汰：总数 5 个会话，保留 s5(新活跃)、s1(旧? 不，s5 成为活跃后 s1 不再是 activeSessionId)、s2(正在生成中)、s4(较新)
  await useChatStore.getState().setActiveSession("s5");
  const cacheKeys = Object.keys(useChatStore.getState().messages);

  assert.equal(cacheKeys.length, 3);
  assert.equal(cacheKeys.includes("s5"), true, "新活跃会话必须保留");
  assert.equal(cacheKeys.includes("s2"), true, "正在生成的后台会话必须保留");
  assert.equal(cacheKeys.includes("s1"), false, "最老的闲置会话 s1 应被淘汰");
});

test("chatStore 队列调度与上下文指标按会话隔离不串台", () => {
  const useChatStore = loadChatStoreInTestEnv();

  useChatStore.setState({
    activeSessionId: "sess_A",
    messages: {
      sess_A: [{ id: "msg_a", role: "assistant", content: "", createdAt: 1 }],
      sess_B: [{ id: "msg_b", role: "assistant", content: "", createdAt: 1 }],
    },
    promptQueueBySession: {},
    contextMetricsBySession: {},
    contextMetrics: null,
  });

  // 增量拼接仅作用于对应会话与消息 ID
  useChatStore.getState().appendMessageDelta("sess_A", "msg_a", "hello ");
  useChatStore.getState().appendMessageDelta("sess_A", "msg_a", "world");
  assert.equal(useChatStore.getState().messages.sess_A[0].content, "hello world");
  assert.equal(useChatStore.getState().messages.sess_B[0].content, "");

  // 排队插队顺序
  useChatStore.getState().enqueuePrompt("sess_A", {
    id: "p1",
    sessionId: "sess_A",
    content: "first",
    createdAt: 1,
  });
  useChatStore.getState().enqueuePrompt("sess_A", {
    id: "p2",
    sessionId: "sess_A",
    content: "second",
    createdAt: 2,
  });
  useChatStore.getState().moveQueuedPromptToTop("sess_A", "p2");
  const firstOut = useChatStore.getState().dequeuePrompt("sess_A");
  assert.equal(firstOut.id, "p2");

  // 上下文指标隔离：后台会话 sess_B 的指标不应覆盖当前活跃 sess_A 的 contextMetrics
  useChatStore.getState().setContextMetrics({ totalTokens: 1000, maxTokens: 128000 }, "sess_A");
  useChatStore.getState().setContextMetrics({ totalTokens: 9999, maxTokens: 128000 }, "sess_B");
  assert.equal(useChatStore.getState().contextMetrics.totalTokens, 1000);
  assert.equal(useChatStore.getState().contextMetricsBySession.sess_B.totalTokens, 9999);
});

test("chatStore serviceSlice handleWorkspaceChanged 按区域精确递增版本号并触发刷新", async () => {
  const useChatStore = loadChatStoreInTestEnv();
  let gitCalls = 0;
  let mcpCalls = 0;
  window.electronAPI.getWorkspaceGitStatus = async (wd) => {
    gitCalls += 1;
    return { isGit: true, branch: "main", insertions: 0, deletions: 0, modifiedFiles: [], wd };
  };
  window.electronAPI.getMcpServers = async () => {
    mcpCalls += 1;
    return [];
  };
  window.electronAPI.getSkills = async () => [];
  window.electronAPI.getSubagents = async () => [];

  useChatStore.setState({
    sessions: [{ id: "s1", title: "S1", updatedAt: 1, workDir: "/tmp/ws1" }],
    activeSessionId: "s1",
    filesRevision: 0,
    gitRevision: 0,
    specsRevision: 0,
    commandsRevision: 0,
    wikiRevision: 0,
  });

  useChatStore.getState().handleWorkspaceChanged({
    workDir: "/tmp/ws1",
    reason: "tool_write",
    areas: ["files", "git"],
  });

  let state = useChatStore.getState();
  assert.equal(state.filesRevision, 1);
  assert.equal(state.gitRevision, 1);
  assert.equal(state.specsRevision, 0);
  assert.equal(state.commandsRevision, 0);
  assert.equal(state.wikiRevision, 0);

  useChatStore.getState().handleWorkspaceChanged({
    workDir: "/tmp/ws1",
    reason: "tool_spec",
    areas: ["specs", "wiki"],
  });

  state = useChatStore.getState();
  assert.equal(state.filesRevision, 1);
  assert.equal(state.specsRevision, 1);
  assert.equal(state.wikiRevision, 1);

  useChatStore.getState().handleWorkspaceChanged({
    workDir: "/tmp/ws1",
    reason: "tools_config",
    areas: ["skills", "commands"],
  });

  state = useChatStore.getState();
  assert.equal(state.commandsRevision, 1);

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(gitCalls >= 1, true);
  assert.equal(mcpCalls >= 1, true);
});

test("chatStore setAgentMode 全局与当前会话联动，新会话继承 defaultAgentMode，questionBySession 正确维护", async () => {
  const useChatStore = loadChatStoreInTestEnv();
  let lastSavedMode = null;
  let lastConfigSaved = null;
  window.electronAPI.dbUpdateSessionAgentMode = async (id, agentMode) => {
    lastSavedMode = { id, agentMode };
    return { success: true };
  };
  window.electronAPI.setConfig = async (k, v) => {
    lastConfigSaved = { k, v };
  };

  useChatStore.setState({
    sessions: [{ id: "s1", title: "S1", updatedAt: 1, agentMode: "code" }],
    activeSessionId: "s1",
    defaultAgentMode: "code",
  });

  await useChatStore.getState().setAgentMode("work");
  assert.equal(useChatStore.getState().defaultAgentMode, "work");
  assert.equal(useChatStore.getState().sessions.find((s) => s.id === "s1")?.agentMode, "work");
  assert.deepEqual(lastSavedMode, { id: "s1", agentMode: "work" });
  assert.deepEqual(lastConfigSaved, { k: "default_agent_mode", v: "work" });

  // 新建会话继承当前全局 defaultAgentMode
  const createdId = await useChatStore.getState().addSession({ workDir: "/tmp/work-dir" });
  assert.ok(createdId);
  assert.equal(useChatStore.getState().sessions.find((s) => s.id === createdId)?.agentMode, "work");

  // 交互式提问状态写入与清理
  useChatStore.getState().setSessionQuestion(createdId, {
    id: "q_1",
    title: "确认",
    questions: [{ id: "f1", question: "选哪个？", type: "single", options: [{ label: "A" }] }],
  });
  assert.equal(useChatStore.getState().questionBySession[createdId]?.id, "q_1");
  useChatStore.getState().setSessionQuestion(createdId, null);
  assert.equal(useChatStore.getState().questionBySession[createdId], null);
});


