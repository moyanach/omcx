const test = require("node:test");
const assert = require("node:assert/strict");

const { buildSystemContext } = require("../utils/contextBuilder");
const { toolRegistry } = require("../utils/toolRegistry");
const { AskUserQuestionTool } = require("../utils/tools/askUserTool");
const { createQuestionAsker, supersedeSessionQuestions } = require("../main/runner/questionGate");
const { pendingQuestions } = require("../main/shared");
const { buildStandaloneMarkdownHtml } = require("../utils/markdownHtmlExporter");

test("agentMode=work 切换通用工作行为准则并过滤三个源码符号工具（保留 run_command）", () => {
  const workCtx = buildSystemContext({
    workDir: null,
    agentMode: "work",
    repoMap: "SHOULD_NOT_APPEAR",
    repoWiki: "SHOULD_NOT_APPEAR_WIKI",
    enableTools: true,
    toolDocs: [],
  });
  assert.ok(workCtx.text.includes("通用工作智能体（Work Agent）"));
  assert.ok(workCtx.text.includes("ask_user_question"));
  assert.equal(workCtx.text.includes("SHOULD_NOT_APPEAR"), false);
  assert.equal(workCtx.text.includes("SHOULD_NOT_APPEAR_WIKI"), false);
  assert.equal(workCtx.sections.some((s) => s.name === "worktree"), false);
  assert.equal(workCtx.sections.some((s) => s.name === "git"), false);

  const workDefs = toolRegistry.getToolDefinitions([], null, {
    permissionMode: "auto-sandbox",
    agentMode: "work",
  });
  const workNames = new Set(workDefs.map((d) => d.function.name));
  assert.equal(workNames.has("repo_map"), false);
  assert.equal(workNames.has("search_symbols"), false);
  assert.equal(workNames.has("find_references"), false);
  assert.equal(workNames.has("run_command"), true);
  assert.equal(workNames.has("ask_user_question"), true);

  const workDocs = toolRegistry.getToolPromptDocs([], {
    permissionMode: "auto-sandbox",
    agentMode: "work",
  });
  assert.equal(workDocs.some((d) => d.startsWith("- repo_map(")), false);
  assert.equal(workDocs.some((d) => d.startsWith("- run_command(")), true);
  assert.equal(workDocs.some((d) => d.startsWith("- ask_user_question(")), true);

  // plan 模式下仍保留 ask_user_question 供规划期澄清
  const planDefs = toolRegistry.getToolDefinitions([], null, {
    permissionMode: "plan",
    agentMode: "work",
  });
  assert.equal(planDefs.some((d) => d.function.name === "ask_user_question"), true);
});

test("ask_user_question 在 Headless 无窗口环境返回降级指引，在 GUI 环境挂起并在回复或接管后释放", async () => {
  const tool = new AskUserQuestionTool();
  const headlessRaw = await tool._call({
    title: "确认格式",
    questions: [{ id: "fmt", question: "选择输出格式", type: "single", options: [{ label: "MD" }] }],
    __toolContext: {},
  });
  const headlessRes = JSON.parse(headlessRaw);
  assert.equal(headlessRes.success, true);
  assert.equal(headlessRes.headlessFallback, true);
  assert.equal(headlessRes.skipped, true);

  // 模拟 GUI 事件发送与异步响应
  const emitted = [];
  const fakeEvent = {
    sender: {
      isDestroyed: () => false,
      once: () => {},
      removeListener: () => {},
    },
  };
  const askUser = createQuestionAsker({
    sessionId: "sess_q_test",
    event: fakeEvent,
    replyStream: (type, data) => emitted.push({ type, data }),
  });

  const promise = tool._call({
    title: "选择报告模板",
    questions: [
      {
        id: "style",
        question: "你倾向哪种汇报结构？",
        type: "single",
        options: [{ label: "结论先行" }, { label: "按时间线" }],
      },
    ],
    __toolContext: { askUser },
  });

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].type, "user_question");
  const reqId = emitted[0].data.id;
  assert.ok(pendingQuestions.has(reqId));

  const entry = pendingQuestions.get(reqId);
  pendingQuestions.delete(reqId);
  entry.settle({
    submitted: true,
    skipped: false,
    answers: { style: "结论先行" },
  });

  const resolved = JSON.parse(await promise);
  assert.equal(resolved.submitted, true);
  assert.equal(resolved.skipped, false);
  assert.deepEqual(resolved.answers, { style: "结论先行" });

  // 验证 supersedeSessionQuestions 自动作废悬空提问
  const askPromise2 = askUser({
    title: "再次提问",
    questions: [{ id: "q2", question: "确认", type: "text" }],
  });
  assert.equal(emitted.length, 2);
  supersedeSessionQuestions("sess_q_test", (type, data) => emitted.push({ type, data }), fakeEvent);
  const supersededRes = await askPromise2;
  assert.equal(supersededRes.skipped, true);
  assert.equal(emitted.some((e) => e.type === "user_question_resolved"), true);
});

test("buildStandaloneMarkdownHtml 正确转换表格/代码块/列表并拦截 XSS 脚本与危险链接", () => {
  const md = [
    "# 周报汇总",
    "",
    "- 完成 [文档](https://example.com) 与 [危险](javascript:alert(1))",
    "",
    "| 指标 | 数值 |",
    "| --- | --- |",
    "| 命中率 | 92.5% |",
    "",
    "<script>alert('xss')</script>",
  ].join("\n");

  const html = buildStandaloneMarkdownHtml(md, { title: "周报<Test>" });
  assert.ok(html.includes("<title>周报&lt;Test&gt;</title>"));
  assert.ok(html.includes("<h1>周报汇总</h1>"));
  assert.ok(html.includes("<table><thead><tr><th>指标</th><th>数值</th></tr></thead>"));
  assert.ok(html.includes('href="https://example.com"'));
  assert.equal(html.includes("javascript:alert"), false);
  assert.equal(html.includes("<script>"), false);
});
