const test = require("node:test");
const assert = require("node:assert/strict");
const {
  estimateMessagesTokens,
  getThresholds,
  shouldMicroCompact,
  microCompact,
  resolveToolResultMaxChars,
  truncateToolResult,
  hardTruncate,
  isContextOverflowError,
} = require("../services/contextCompactor");

test("contextCompactor Token 估算、阈值与微压缩正确工作", () => {
  const thresholds = getThresholds(128000, { thresholdPercent: 85 });
  assert.ok(thresholds.effective > 0);
  assert.ok(thresholds.microThreshold < thresholds.threshold);
  assert.equal(shouldMicroCompact(thresholds.microThreshold + 100, thresholds), true);
  assert.equal(shouldMicroCompact(100, thresholds), false);

  const messages = [
    { role: "system", content: "You are a helpful coding assistant." },
    { role: "user", content: "Inspect repository files" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "read_file", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "A".repeat(4000) },
    { role: "tool", tool_call_id: "c2", content: "B".repeat(4000) },
    { role: "tool", tool_call_id: "c3", content: "C".repeat(4000) },
    { role: "user", content: "Summarize now" },
  ];

  const totalTokens = estimateMessagesTokens(messages);
  assert.ok(totalTokens > 2000);

  const { messages: compacted, cleared, saved } = microCompact(messages, {
    keepRecentToolResults: 1,
  });
  assert.equal(cleared, 2);
  assert.ok(saved > 7000);
  assert.match(compacted[3].content, /旧工具输出已清理/);
  assert.equal(compacted[5].content, "C".repeat(4000));
});

test("truncateToolResult 与 hardTruncate、isContextOverflowError 边界正确", () => {
  const huge = "X".repeat(20000);
  const clipped = truncateToolResult(huge, 8000);
  assert.ok(clipped.length < huge.length);
  assert.match(clipped, /已截断，原始 20000 字符/);

  const longMsgs = [
    { role: "system", content: "sys" },
    { role: "user", content: "U1 ".repeat(500) },
    { role: "assistant", content: "A1 ".repeat(500) },
    { role: "user", content: "latest prompt" },
  ];
  const hard = hardTruncate(longMsgs, 120);
  assert.equal(hard[0].role, "system");
  assert.equal(hard[hard.length - 1].content, "latest prompt");

  assert.equal(isContextOverflowError("maximum context length exceeded"), true);
  assert.equal(isContextOverflowError("network timeout"), false);
});

test("microCompact 启用 batchWatermark 后按批量水位线清理以保护前缀缓存", () => {
  const base = [
    { role: "system", content: "sys" },
    { role: "user", content: "work" },
    { role: "tool", tool_call_id: "t1", content: "R1 ".repeat(200) },
    { role: "tool", tool_call_id: "t2", content: "R2 ".repeat(200) },
    { role: "tool", tool_call_id: "t3", content: "R3 ".repeat(200) },
  ];
  // 只有 1 条旧输出且体积较小（keepRecent=2 -> 仅 t1 可清）时，为保护缓存跳过改写
  const skipped = microCompact(base, {
    keepRecentToolResults: 2,
    batchWatermark: true,
    microBatchMinCount: 3,
    microBatchMinSavedChars: 10000,
  });
  assert.equal(skipped.cleared, 0);
  assert.equal(skipped.skippedForCache, true);
  assert.equal(skipped.messages[2].content, "R1 ".repeat(200));

  // 累积满 3 条可清理或 urgent=true 时一次性批量清理
  const extended = [
    ...base,
    { role: "tool", tool_call_id: "t4", content: "R4 ".repeat(200) },
    { role: "tool", tool_call_id: "t5", content: "R5 ".repeat(200) },
  ];
  const flushed = microCompact(extended, {
    keepRecentToolResults: 2,
    batchWatermark: true,
    microBatchMinCount: 3,
    microBatchMinSavedChars: 10000,
  });
  assert.equal(flushed.skippedForCache, false);
  assert.equal(flushed.cleared, 3);
  assert.match(flushed.messages[2].content, /旧工具输出已清理/);
  assert.equal(flushed.messages[6].content, "R5 ".repeat(200));

  // urgent=true 时即使只有 1 条也立即清理
  const urgent = microCompact(base, {
    keepRecentToolResults: 2,
    batchWatermark: true,
    urgent: true,
  });
  assert.equal(urgent.cleared, 1);
  assert.equal(urgent.skippedForCache, false);
});

test("resolveToolResultMaxChars 与 truncateToolResult 动态窗口分档及头尾保留正确", () => {
  assert.equal(resolveToolResultMaxChars({ contextLimit: 1000000 }), 40000);
  assert.equal(resolveToolResultMaxChars({ contextLimit: 200000 }), 28000);
  assert.equal(resolveToolResultMaxChars({ contextLimit: 128000 }), 20000);
  assert.equal(resolveToolResultMaxChars({ contextLimit: 32000 }), 12000);
  // read_document 对 >=100k 模型至少保留 24000 字符内部预算
  assert.equal(
    resolveToolResultMaxChars({ contextLimit: 128000, toolName: "read_document" }),
    24000
  );
  // 显式用户配置优先
  assert.equal(
    resolveToolResultMaxChars({ contextLimit: 1000000, configuredMaxChars: 15000, toolName: "read_document" }),
    15000
  );

  // 1M 模型下 25000 字符的完整工具输出不再被写死 8000 拦腰截断
  const mediumOutput = "HEAD_INFO\n" + "M".repeat(25000) + "\nTAIL_OK";
  assert.equal(
    truncateToolResult(mediumOutput, { contextLimit: 1000000, toolName: "read_file" }),
    mediumOutput
  );

  // 超长命令报错时保留 35% 头部与 65% 尾部报错堆栈
  const cmdLog =
    "BUILD_START_CMD\n" +
    "compiling normal module...\n".repeat(2200) +
    "\nFATAL_ERROR_STACK: TypeError at src/main.ts:99\n";
  const clippedCmd = truncateToolResult(cmdLog, { contextLimit: 128000, toolName: "run_command" });
  assert.ok(clippedCmd.startsWith("BUILD_START_CMD"));
  assert.ok(clippedCmd.includes("FATAL_ERROR_STACK: TypeError at src/main.ts:99"));
  assert.match(clippedCmd, /已截断，原始 \d+ 字符/);
  assert.match(clippedCmd, /尾部 65%/);
});
