const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateNoToolResponse } = require("../main/runner/continuationPolicy");
const { isParallelSafeCall } = require("../main/runner/toolExecutor");
const { isTransientSocketError, hasValidToolCalls } = require("../main/runner/streamTransport");

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
