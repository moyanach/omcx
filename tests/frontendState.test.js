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

test("ToolSteps 状态判定正确识别内层失败并输出失败摘要（杜绝假绿色完成）", async () => {
  const entryPath = path.resolve(__dirname, "../src/pages/chat/messageList/ToolSteps.tsx");
  const built = await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    alias: {
      "@": path.resolve(__dirname, "../src"),
    },
    plugins: [
      {
        name: "stub-codeblock",
        setup(build) {
          build.onResolve({ filter: /CodeBlock$/ }, (args) => ({
            path: args.path,
            namespace: "stub-codeblock",
          }));
          build.onLoad({ filter: /.*/, namespace: "stub-codeblock" }, () => ({
            contents: "module.exports = { default: () => null, DiffViewer: () => null };",
            loader: "js",
          }));
        },
      },
    ],
    external: ["react", "react/*", "lucide-react", "anser"],
  });
  const code = built.outputFiles[0].text;
  const mod = new Module(entryPath);
  mod.filename = entryPath;
  mod.paths = Module._nodeModulePaths(path.dirname(entryPath));
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "react") {
      return {
        default: { createElement: () => null, Fragment: "Fragment", memo: (c) => c },
        createElement: () => null,
        Fragment: "Fragment",
        memo: (c) => c,
      };
    }
    if (request === "react/jsx-runtime" || request === "react/jsx-dev-runtime") {
      return { jsx: () => null, jsxs: () => null, jsxDEV: () => null, Fragment: "Fragment" };
    }
    if (request === "lucide-react") {
      return new Proxy({}, { get: () => () => null });
    }
    if (request === "anser") {
      return { default: { ansiToJson: () => [] }, ansiToJson: () => [] };
    }
    return origLoad.call(this, request, parent, isMain);
  };
  try {
    mod._compile(code, entryPath);
  } finally {
    Module._load = origLoad;
  }

  const { isToolStepSuccess, getToolStepError, getToolOutputSummary } = mod.exports;
  // 历史双层结构：外层 success:true 但内层 data.success:false 时必须判为失败
  const legacyWrappedFail = {
    success: true,
    data: { success: false, error: "fileLockService.withFileLock is not a function" },
  };
  assert.equal(isToolStepSuccess(legacyWrappedFail), false);
  assert.equal(getToolStepError(legacyWrappedFail), "fileLockService.withFileLock is not a function");
  assert.ok(getToolOutputSummary(legacyWrappedFail).startsWith("失败:"));

  // 新外层穿透失败结构
  const outerFail = {
    success: false,
    error: "generate_document 失败",
    data: { success: false, error: "generate_document 失败" },
  };
  assert.equal(isToolStepSuccess(outerFail), false);
  assert.equal(getToolStepError(outerFail), "generate_document 失败");

  // 聚合成功摘要
  const aggSuccess = {
    success: true,
    data: { mode: "aggregate", kind: "grouped_summary", matchedRows: 3181, totalGroups: 12 },
  };
  assert.equal(isToolStepSuccess(aggSuccess), true);
  assert.equal(getToolOutputSummary(aggSuccess), "统计 3181 行 · 12 个分组");
});

test("buildGraphLayout Merge 分叉新辟泳道不产生垂直毛刺，既有并行泳道直连贯通", async () => {
  const entryPath = path.resolve(__dirname, "../src/components/browser/gitGraph/graphLayout.ts");
  const built = await esbuild.build({
    entryPoints: [entryPath],
    bundle: false,
    platform: "node",
    format: "cjs",
    write: false,
  });
  const mod = new Module(entryPath);
  mod.filename = entryPath;
  mod._compile(built.outputFiles[0].text, entryPath);
  const { buildGraphLayout } = mod.exports;

  // 场景 1：单主线 Merge 新开辟泳道 1，不应出现 fromLane:1 -> toLane:1 kind:"out" 的垂直毛刺
  // 场景 2：分支线在泳道 1 内再次 Merge 新开辟泳道 2，此时泳道 0（主线）应继续直连，泳道 2 不应产生垂直毛刺
  const commits = [
    { hash: "m1", shortHash: "m1", parents: ["c1", "b1"], refs: [], author: "a", relativeTime: "1m", subject: "Merge b1" },
    { hash: "b1", shortHash: "b1", parents: ["b2", "f1"], refs: [], author: "a", relativeTime: "2m", subject: "Merge f1 into b" },
    { hash: "f1", shortHash: "f1", parents: ["b2"], refs: [], author: "a", relativeTime: "3m", subject: "feat f1" },
    { hash: "b2", shortHash: "b2", parents: ["c1"], refs: [], author: "a", relativeTime: "4m", subject: "work b2" },
    { hash: "c1", shortHash: "c1", parents: [], refs: [], author: "a", relativeTime: "5m", subject: "init" },
  ];

  const rows = buildGraphLayout(commits);
  assert.equal(rows.length, 5);

  // Row 0 (m1): 新辟泳道 1，仅应有 (0->0 out) 和 (0->1 out)，绝不能有 (1->1 out)
  const r0Out = rows[0].segments.filter((s) => s.kind === "out");
  assert.deepEqual(
    r0Out.map((s) => [s.fromLane, s.toLane]),
    [[0, 0], [0, 1]]
  );

  // Row 1 (b1 在泳道 1): 泳道 0 是原先存在的贯穿泳道应保留 (0->0 out)，新辟泳道 2 绝不能有 (2->2 out)
  const r1Out = rows[1].segments.filter((s) => s.kind === "out");
  assert.ok(r1Out.some((s) => s.fromLane === 0 && s.toLane === 0), "已有并行泳道 0 应保持直连");
  assert.ok(r1Out.some((s) => s.fromLane === 1 && s.toLane === 2), "应存在从泳道 1 弯向新泳道 2 的连线");
  assert.ok(!r1Out.some((s) => s.fromLane === 2 && s.toLane === 2), "新辟泳道 2 不应产生垂直毛刺");
});


