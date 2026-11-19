const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateNoToolResponse } = require("../main/runner/continuationPolicy");
const { isParallelSafeCall } = require("../main/runner/toolExecutor");
const {
  isTransientSocketError,
  hasValidToolCalls,
  detectAbruptClose,
} = require("../main/runner/streamTransport");

const dummyBuildReplay = (result, { content } = {}) => ({
  role: "assistant",
  content: content !== undefined ? content : result.content || "",
});

test("continuationPolicy 正确判定模式 A/B/C/D 与正常 break", () => {
  // 模式 A：正文触发 length 上限
  const modeA = evaluateNoToolResponse({
    result: { content: "第一段内容", reasoning: "", toolCalls: [], hitLengthLimit: true },
    steerQueue: [],
    initialTodos: [],
    permissionMode: "auto-sandbox",
    planModeValue: "plan",
    fullGeneratedText: "第一段内容",
    toolRound: 0,
    emptyRoundRetry: 0,
    continuationCount: 0,
    maxContinuations: 4,
    buildAssistantReplayMessage: dummyBuildReplay,
  });
  assert.equal(modeA.action, "continue");
  assert.equal(modeA.mode, "A");

  // 模式 B：思考存在但正文为空
  const modeB = evaluateNoToolResponse({
    result: { content: "", reasoning: "思考推导中...", toolCalls: [], hitLengthLimit: false },
    steerQueue: [],
    initialTodos: [],
    permissionMode: "auto-sandbox",
    planModeValue: "plan",
    fullGeneratedText: "",
    toolRound: 0,
    emptyRoundRetry: 0,
    continuationCount: 0,
    maxContinuations: 4,
    buildAssistantReplayMessage: dummyBuildReplay,
  });
  assert.equal(modeB.action, "continue");
  assert.equal(modeB.mode, "B");

  // 模式 C：未完成 Todo 且输出过短（非 plan 模式）
  const modeC = evaluateNoToolResponse({
    result: { content: "好的", reasoning: "", toolCalls: [], hitLengthLimit: false },
    steerQueue: [],
    initialTodos: [{ id: "1", text: "写测试", status: "in_progress" }],
    permissionMode: "auto-sandbox",
    planModeValue: "plan",
    fullGeneratedText: "好的",
    toolRound: 1,
    emptyRoundRetry: 0,
    continuationCount: 0,
    maxContinuations: 4,
    buildAssistantReplayMessage: dummyBuildReplay,
  });
  assert.equal(modeC.action, "continue");
  assert.equal(modeC.mode, "C");

  // 模式 D：代码块未闭合即结束
  const modeD = evaluateNoToolResponse({
    result: { content: "```js\nconst a = 1;", reasoning: "", toolCalls: [], hitLengthLimit: false },
    steerQueue: [],
    initialTodos: [],
    permissionMode: "auto-sandbox",
    planModeValue: "plan",
    fullGeneratedText: "```js\nconst a = 1;",
    toolRound: 0,
    emptyRoundRetry: 0,
    continuationCount: 0,
    maxContinuations: 4,
    buildAssistantReplayMessage: dummyBuildReplay,
  });
  assert.equal(modeD.action, "continue");
  assert.equal(modeD.mode, "D");

  // 正常完成：闭合文本 + 已完成 Todo -> break
  const done = evaluateNoToolResponse({
    result: { content: "已完成全部任务。", reasoning: "", toolCalls: [], hitLengthLimit: false },
    steerQueue: [],
    initialTodos: [{ id: "1", text: "写测试", status: "completed" }],
    permissionMode: "auto-sandbox",
    planModeValue: "plan",
    fullGeneratedText: "已完成全部任务。",
    toolRound: 2,
    emptyRoundRetry: 0,
    continuationCount: 0,
    maxContinuations: 4,
    buildAssistantReplayMessage: dummyBuildReplay,
  });
  assert.equal(done.action, "break");
});

test("toolExecutor.isParallelSafeCall 与 streamTransport 辅助校验正确区分读写与工具调用", () => {
  assert.equal(isParallelSafeCall({ tc: { function: { name: "read_file" } }, args: {} }), true);
  assert.equal(isParallelSafeCall({ tc: { function: { name: "edit_file" } }, args: {} }), false);
  assert.equal(
    isParallelSafeCall({ tc: { function: { name: "dispatch_subagent" } }, args: { agent: "explore", readOnly: true } }),
    true
  );
  assert.equal(
    isParallelSafeCall({ tc: { function: { name: "dispatch_subagent" } }, args: { agent: "general", readOnly: false } }),
    false
  );

  assert.equal(isTransientSocketError({ message: "fetch failed", cause: { code: "ECONNRESET" } }), true);
  assert.equal(isTransientSocketError({ message: "400 Bad Request" }), false);
  assert.equal(hasValidToolCalls([{ function: { name: "read_file", arguments: "{\"path\":\"a\"}" } }]), true);
  assert.equal(hasValidToolCalls([{ function: { name: "read_file", arguments: "{broken" } }]), false);
});

test("subagentService 显式 is_lite 选模、工具白名单与动态角色权限解析正确", () => {
  const {
    BUILTIN_SUBAGENTS,
    READ_ONLY_TOOL_LIST,
    PLANNER_TOOL_LIST,
    FULL_CODING_TOOL_LIST,
    resolveSubagentProfile,
    selectSubagentModel,
  } = require("../services/subagentService");
  const { selectExplicitLiteModel } = require("../services/storage/configWorkspaceStorage");

  // 1) 内建工具列表与 P0/P1/P2 规范同步
  for (const symTool of ["repo_map", "search_symbols", "find_references"]) {
    assert.ok(READ_ONLY_TOOL_LIST.includes(symTool));
    assert.ok(PLANNER_TOOL_LIST.includes(symTool));
    assert.ok(FULL_CODING_TOOL_LIST.includes(symTool));
  }
  assert.ok(PLANNER_TOOL_LIST.includes("spec_write"));
  assert.ok(FULL_CODING_TOOL_LIST.includes("run_skill_script"));
  const reviewer = BUILTIN_SUBAGENTS.find((a) => a.id === "reviewer");
  assert.ok(reviewer.systemPrompt.includes("P0"));

  // 2) 动态角色 readOnly=false 且未传 agent 时，不应被 explore 降级为只读
  const dynWrite = resolveSubagentProfile({
    role: "单元测试专家",
    readOnly: false,
    permissionMode: "auto-sandbox",
  });
  assert.equal(dynWrite.readOnly, false);
  assert.ok(dynWrite.tools.includes("write_file"));
  assert.ok(dynWrite.tools.includes("run_command"));

  // plan 模式下强制只读
  const dynPlan = resolveSubagentProfile({
    role: "单元测试专家",
    readOnly: false,
    permissionMode: "plan",
  });
  assert.equal(dynPlan.readOnly, true);
  assert.equal(dynPlan.tools.includes("write_file"), false);

  // 3) 显式 is_lite 选模：名称里含 mini/v3 但未勾选 is_lite 绝不选中；同服务商优先；缺 key 过滤
  const parentModel = {
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKey: "sk-ant-parent",
    modelName: "claude-sonnet-4-6",
  };
  const fakeStorage = {
    selectExplicitLiteModel,
    getModels: () => [
      { id: "deepseek-v3", model_id: "deepseek-v3", provider: "deepseek", api_key: "sk-ds", is_lite: false },
      { id: "gpt-4o-mini", model_id: "gpt-4o-mini", provider: "openai", api_key: "", is_lite: true },
      { id: "ds-lite", model_id: "deepseek-chat", provider: "deepseek", base_url: "https://api.deepseek.com/v1", api_key: "sk-ds-lite", is_lite: true },
      { id: "haiku", model_id: "claude-haiku-4-5", provider: "anthropic", base_url: "https://api.anthropic.com", api_key: "sk-ant-haiku", is_lite: true },
    ],
  };
  const picked = selectSubagentModel(parentModel, "lite", fakeStorage);
  assert.equal(picked.modelName, "claude-haiku-4-5");
  assert.equal(picked.provider, "anthropic");
  assert.equal(picked.apiKey, "sk-ant-haiku");

  // 若所有模型均未显式勾选 is_lite（即使名字带 mini/flash/v3），回退继承父模型
  const noLiteStorage = {
    selectExplicitLiteModel,
    getModels: () => [
      { id: "gpt-4o-mini", model_id: "gpt-4o-mini", provider: "openai", api_key: "sk-oai", is_lite: false },
    ],
  };
  const fallback = selectSubagentModel(parentModel, "lite", noLiteStorage);
  assert.equal(fallback, parentModel);
});

test("streamTransport.detectAbruptClose 与 continuationPolicy 模式 E 断流续写正确工作", () => {
  assert.equal(
    detectAbruptClose({ cancelled: false, streamFinished: true, finishReason: "stop" }),
    false
  );
  assert.equal(
    detectAbruptClose({ cancelled: false, streamFinished: false, finishReason: "stop" }),
    false
  );
  assert.equal(
    detectAbruptClose({ cancelled: false, streamFinished: false, finishReason: null }),
    true
  );
  assert.equal(
    detectAbruptClose({
      cancelled: false,
      streamFinished: false,
      finishReason: null,
      socketClosedAbruptly: true,
    }),
    true
  );
  assert.equal(
    detectAbruptClose({
      cancelled: true,
      streamFinished: false,
      finishReason: null,
      socketClosedAbruptly: true,
    }),
    false
  );

  const modeE = evaluateNoToolResponse({
    result: {
      content: "第一部分分析：content 内含 `",
      reasoning: "",
      toolCalls: [],
      hitLengthLimit: false,
      abruptlyClosed: true,
    },
    steerQueue: [],
    initialTodos: [],
    permissionMode: "auto-sandbox",
    planModeValue: "plan",
    fullGeneratedText: "第一部分分析：content 内含 `",
    toolRound: 2,
    emptyRoundRetry: 0,
    continuationCount: 0,
    maxContinuations: 4,
    buildAssistantReplayMessage: dummyBuildReplay,
  });
  assert.equal(modeE.action, "continue");
  assert.equal(modeE.mode, "E");
});

test("subagentService SSE 流式解析、JSON 兼容与空闲超时看门狗正确工作", async () => {
  const { readSubagentOpenAIResponse, isTransientSubagentError } = require("../services/subagentService");

  // 1) SSE 分片拼接与 tool_calls 解析
  const sseChunks = [
    'data: {"choices":[{"delta":{"reasoning_content":"思考"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"你好，"}}]}\n',
    'data: {"choices":[{"delta":{"content":"世界","tool_calls":[{"index":0,"id":"c1","function":{"name":"read_file","arguments":"{\\"path\\":"}}]}}]}\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.js\\"}"}}]}}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n',
    "data: [DONE]\n",
  ];
  const encoder = new TextEncoder();
  let idx = 0;
  const sseResponse = {
    headers: { get: () => "text/event-stream" },
    body: {
      getReader: () => ({
        read: async () =>
          idx < sseChunks.length
            ? { done: false, value: encoder.encode(sseChunks[idx++]) }
            : { done: true },
        cancel: async () => {},
      }),
    },
  };
  const parsedSse = await readSubagentOpenAIResponse(sseResponse, 5000);
  assert.equal(parsedSse.rawContent, "你好，世界");
  assert.equal(parsedSse.reasoning, "思考");
  assert.equal(parsedSse.toolCalls.length, 1);
  assert.equal(parsedSse.toolCalls[0].function.name, "read_file");
  assert.equal(parsedSse.toolCalls[0].function.arguments, '{"path":"a.js"}');
  assert.equal(parsedSse.usage.total_tokens, 15);

  // 2) 空闲超时看门狗触发 SUBAGENT_IDLE_TIMEOUT 并被识别为可重试瞬时错误
  const hangingResponse = {
    headers: { get: () => "text/event-stream" },
    body: {
      getReader: () => ({
        read: () => new Promise(() => {}),
        cancel: async () => {},
      }),
    },
  };
  await assert.rejects(
    () => readSubagentOpenAIResponse(hangingResponse, 40),
    (err) => err.code === "SUBAGENT_IDLE_TIMEOUT" && isTransientSubagentError(err)
  );

  // 3) 兼容 application/json 响应
  const jsonResponse = {
    headers: { get: () => "application/json" },
    json: async () => ({
      choices: [{ message: { content: "ok", reasoning_content: "r" } }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }),
  };
  const parsedJson = await readSubagentOpenAIResponse(jsonResponse, 5000);
  assert.equal(parsedJson.rawContent, "ok");
  assert.equal(parsedJson.reasoning, "r");
});

test("repoIndexService 异步扫描与符号/引用检索正确返回结果", async () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const {
    scanRepoAsync,
    buildRepoMapAsync,
    searchSymbolsAsync,
    findReferencesAsync,
  } = require("../services/repoIndexService");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omcx-repo-async-"));
  try {
    fs.writeFileSync(
      path.join(tmpDir, "alpha.js"),
      "function computeCacheHit(a, b) {\n  return a + b;\n}\nmodule.exports = { computeCacheHit };\n",
      "utf-8"
    );
    fs.writeFileSync(
      path.join(tmpDir, "beta.js"),
      "const { computeCacheHit } = require('./alpha');\nconst val = computeCacheHit(1, 2);\n",
      "utf-8"
    );

    const index = await scanRepoAsync(tmpDir, { force: true });
    assert.ok(index.stats.fileCount >= 2 || index.stats.symbolCount >= 1);

    const map = await buildRepoMapAsync(tmpDir);
    assert.match(map, /computeCacheHit/);

    const syms = await searchSymbolsAsync(tmpDir, "computeCacheHit");
    assert.ok(syms.some((s) => s.name === "computeCacheHit" && s.path === "alpha.js"));

    const refs = await findReferencesAsync(tmpDir, "computeCacheHit");
    assert.ok(refs.definitions.length >= 1);
    assert.ok(refs.references.some((r) => r.path === "beta.js" && r.kind === "call"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("3 档权限模式 (plan / auto / full-access)、灾难命令硬拦截与安全裁判方案 B 裁决流", async () => {
  const {
    PERMISSION_MODES,
    normalizePermissionMode,
    getPermissionModePolicy,
  } = require("../services/sandboxPolicyService");
  const {
    DEFAULT_CLASSIFIER_MAX_TOKENS,
    DEFAULT_CLASSIFIER_TIMEOUT_MS,
    parseClassifierDecision,
    evaluateActionSafety,
  } = require("../services/safetyClassifierService");
  const { createPermissionChecker } = require("../main/runner/permissionGate");
  const { isCatastrophicCommand, isDangerousCommand } = require("../utils/tools/shellTools");
  const { pendingPermissions } = require("../main/shared");

  // 1) auto-sandbox 与 ask 自动兼容归一到 auto
  assert.equal(normalizePermissionMode("auto-sandbox"), "auto");
  assert.equal(normalizePermissionMode("ask"), "auto");
  assert.equal(normalizePermissionMode("auto"), "auto");
  assert.equal(normalizePermissionMode("plan"), "plan");
  assert.equal(normalizePermissionMode("full-access"), "full-access");
  assert.equal(getPermissionModePolicy("auto-sandbox").id, "auto");
  assert.equal(getPermissionModePolicy("auto").useAiSafetyClassifier, true);

  // 2) 放宽预算常量校验 (maxTokens=1024, timeout=45000)
  assert.equal(DEFAULT_CLASSIFIER_MAX_TOKENS, 1024);
  assert.equal(DEFAULT_CLASSIFIER_TIMEOUT_MS, 45000);

  // 3) 灾难性系统命令硬拦截
  assert.equal(isCatastrophicCommand("rm -rf /"), true);
  assert.equal(isCatastrophicCommand("sudo rm -rf ~"), true);
  assert.equal(isCatastrophicCommand("mkfs.ext4 /dev/sda1"), true);
  assert.equal(isCatastrophicCommand("rm -rf ./dist"), false);
  assert.equal(isDangerousCommand("rm -rf ./dist"), true);

  // 4) 安全裁判输出解析（兼容 <think> 思考块与 JSON 围栏）
  const allowVerdict = parseClassifierDecision(
    '<think>用户要求清理构建目录</think>```json\n{"decision":"allow","risk":"low","reason":"清理当前构建产物 dist"}\n```'
  );
  assert.equal(allowVerdict.allow, true);
  assert.equal(allowVerdict.risk, "low");

  const denyVerdict = await evaluateActionSafety({
    targetPath: "/opt/app",
    actionDesc: "执行高危命令",
    meta: { kind: "dangerous_command", command: "git push --force origin main" },
    userIntent: "仅运行单元测试",
    workDir: "/opt/app",
    modelConfig: {
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-test",
      modelId: "lite-judge",
      provider: "openai",
    },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: '{"decision":"deny","risk":"high","reason":"与跑单测意图无关的强推主干"}',
            },
          },
        ],
      }),
    }),
  });
  assert.equal(denyVerdict.allow, false);
  assert.equal(denyVerdict.reason, "与跑单测意图无关的强推主干");

  // 5) permissionGate 方案 B：auto 模式下 AI allow 直接静默通过（不弹窗）；AI deny 则降级触发人工确认弹窗并附带 aiReview
  const emittedEvents = [];
  const fakeEvent = {
    sender: {
      isDestroyed: () => false,
      once: () => {},
      removeListener: () => {},
    },
  };
  const replyStream = (type, data) => {
    emittedEvents.push({ type, data });
    if (type === "permission") {
      const pending = pendingPermissions.get(data.id);
      if (pending) {
        pending.settle({ allow: false, decision: "deny" });
      }
    }
  };

  let nextAiDecision = { allow: true, decision: "allow", risk: "low", reason: "局部构建目录清理" };
  const checker = createPermissionChecker({
    sessionId: "sess_auto_judge",
    event: fakeEvent,
    replyStream,
    customCheckPermission: null,
    isBuiltinTrustedPath: () => false,
    resolvedPermissionMode: PERMISSION_MODES.AUTO,
    PERMISSION_MODES,
    allowedFolders: ["/opt/app"],
    writableFolders: ["/opt/app"],
    sessionAbort: { toolContext: { permissionMode: "auto" } },
    storageService: { getSessions: () => [], saveSession: () => {} },
    workDir: "/opt/app",
    currentModelId: "test-model",
    getUserIntent: () => "清理 dist 目录并重新打包",
    safetyClassifier: {
      evaluateActionSafety: async () => nextAiDecision,
    },
  });

  // 5a) AI allow -> 静默返回 true，不发 permission 事件
  const passResult = await checker("/opt/app ($ rm -rf ./dist)", "执行高危命令", {
    kind: "dangerous_command",
    command: "rm -rf ./dist",
  });
  assert.equal(passResult, true);
  assert.equal(emittedEvents.length, 0);

  // 5b) AI deny -> 方案 B 降级触发前端 permission 弹窗并携带 aiReview
  nextAiDecision = {
    allow: false,
    decision: "deny",
    risk: "high",
    reason: "未授权强制重置主干分支",
  };
  const fallbackResult = await checker("/opt/app ($ git reset --hard)", "执行高危命令", {
    kind: "dangerous_command",
    command: "git reset --hard",
  });
  assert.equal(fallbackResult, false);
  assert.equal(emittedEvents.length, 1);
  assert.equal(emittedEvents[0].type, "permission");
  assert.equal(emittedEvents[0].data.aiReview.reason, "未授权强制重置主干分支");
});
