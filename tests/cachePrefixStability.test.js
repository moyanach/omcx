const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  buildSystemContext,
  buildGitReminder,
  buildTodoReminder,
  appendReminderToLastUserMessage,
} = require("../utils/contextBuilder");
const { TodoWriteTool } = require("../utils/tools/todoTool");
const { buildSubagentSystemPrompt, resolveSubagentProfile } = require("../services/subagentService");

test("contextBuilder 默认保持 System Prompt 跨 git 变更与 todos 变更的字节级稳定", () => {
  const gitA = {
    branch: "main",
    mainBranch: "main",
    user: "dev",
    statusLines: ["M src/a.ts"],
    commits: ["abc1234 init"],
  };
  const gitB = {
    branch: "main",
    mainBranch: "main",
    user: "dev",
    statusLines: ["M src/a.ts", "M src/b.ts", "?? src/c.ts"],
    commits: ["def5678 feat: update"],
  };
  const baseArgs = {
    workDir: null,
    model: "openai/gpt-4o",
    permissionMode: "auto-sandbox",
    enableTools: false,
  };

  const ctx1 = buildSystemContext({
    ...baseArgs,
    gitInfo: gitA,
    todos: [],
  });
  const ctx2 = buildSystemContext({
    ...baseArgs,
    gitInfo: gitB,
    todos: [{ id: "td_1", text: "重构缓存前缀", status: "in_progress" }],
  });

  // 默认不再把高频变化的 git 与 todos 塞入 system，保证跨轮次与工单更新后字节级一致
  assert.equal(ctx1.text, ctx2.text);
  assert.equal(ctx1.sections.some((s) => s.name === "git"), false);
  assert.equal(ctx2.sections.some((s) => s.name === "todos"), false);

  // 压缩或显式需要时，仍可开启 includeTodosInSystem / includeGitInSystem
  const ctxExplicit = buildSystemContext({
    ...baseArgs,
    gitInfo: gitB,
    todos: [{ id: "td_1", text: "重构缓存前缀", status: "in_progress" }],
    includeTodosInSystem: true,
    includeGitInSystem: true,
  });
  assert.ok(ctxExplicit.text.includes("【当前工单 (Todo List)】"));
  assert.ok(ctxExplicit.text.includes("【Git 快照】"));
});

test("appendReminderToLastUserMessage 仅追加最后一条 user 消息副本，兼容纯文本与多模态，不修改原数组", () => {
  const gitReminder = buildGitReminder({
    branch: "release/v2.1.0",
    mainBranch: "main",
    user: "dev",
    statusLines: ["M a.js"],
    commits: [],
  });
  assert.ok(gitReminder.startsWith("<system-reminder>"));
  assert.ok(gitReminder.includes("M a.js"));

  const todoReminder = buildTodoReminder([
    { id: "td_1", text: "完成验证", status: "in_progress" },
  ]);
  assert.ok(todoReminder.includes("td_1 完成验证"));

  const originalFirstUser = { role: "user", content: "第一轮问题" };
  const originalLastUser = { role: "user", content: "第二轮问题" };
  const messages = [
    { role: "system", content: "SYS" },
    originalFirstUser,
    { role: "assistant", content: "第一轮回答" },
    originalLastUser,
  ];

  const ok = appendReminderToLastUserMessage(messages, gitReminder);
  assert.equal(ok, true);
  // 历史 user 消息完全未被改写
  assert.equal(messages[1].content, "第一轮问题");
  // 原对象未被原地突变（仅替换 messages 数组槽位）
  assert.equal(originalLastUser.content, "第二轮问题");
  assert.ok(messages[3].content.startsWith("第二轮问题\n\n<system-reminder>"));

  // 多模态数组兼容
  const multiMsgs = [
    {
      role: "user",
      content: [
        { type: "text", text: "看截图" },
        { type: "image_url", image_url: { url: "data:image/png;base64,xxx" } },
      ],
    },
  ];
  assert.equal(appendReminderToLastUserMessage(multiMsgs, gitReminder), true);
  assert.equal(multiMsgs[0].content.length, 3);
  assert.equal(multiMsgs[0].content[2].type, "text");
  assert.ok(multiMsgs[0].content[2].text.includes("<system-reminder>"));
});

test("todo_write 正常更新内存工单、触发回调并返回完整状态快照（不依赖重建 system）", async () => {
  const tool = new TodoWriteTool();
  const captured = [];
  const raw = await tool._call({
    todos: [
      { id: "td_1", text: "探索代码", status: "completed" },
      { id: "td_2", text: "实施修改", status: "in_progress" },
      { id: "td_3", text: "运行测试", status: "pending" },
    ],
    __onTodosUpdate: (next) => captured.push(next),
  });

  const parsed = JSON.parse(raw);
  assert.equal(parsed.success, true);
  assert.equal(parsed.total, 3);
  assert.equal(parsed.completed, 1);
  assert.equal(parsed.pending, 1);
  assert.deepEqual(parsed.in_progress, { id: "td_2", text: "实施修改" });
  assert.equal(parsed.todos.length, 3);
  assert.equal(captured.length, 1);
  assert.equal(captured[0][1].status, "in_progress");

  // agentRunner 中 onTodosUpdate 回调不再调用 refreshSystemInstruction，防止破坏缓存前缀
  const runnerSrc = fs.readFileSync(path.join(__dirname, "../main/agentRunner.js"), "utf8");
  const todosHandlerMatch = runnerSrc.match(
    /sessionToolContext\.onTodosUpdate\s*=\s*\(nextTodos\)\s*=>\s*\{[\s\S]*?\};/
  );
  assert.ok(todosHandlerMatch, "应能定位 sessionToolContext.onTodosUpdate");
  assert.equal(
    todosHandlerMatch[0].includes("refreshSystemInstruction"),
    false,
    "onTodosUpdate 中禁止再调用 refreshSystemInstruction()"
  );
});

test("subagent System Prompt 使用按天稳定日期而非精确到秒时间戳", () => {
  const explore = resolveSubagentProfile({ agentId: "explore" });
  const p1 = buildSubagentSystemPrompt(explore, "/tmp/demo", "2026-11-15");
  const p2 = buildSubagentSystemPrompt(explore, "/tmp/demo", "2026-11-15");
  assert.equal(p1, p2);
  assert.ok(p1.includes("当前日期: 2026-11-15"));
  assert.equal(p1.includes("当前系统时间"), false);
});
