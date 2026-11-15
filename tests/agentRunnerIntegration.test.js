process.env.OMCX_STORAGE_MEMORY_ONLY = "1";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const storageService = require("../services/storageService");
const { runAgentTurn } = require("../main/agentRunner");

function makeSseResponse(chunks) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

test("agentRunner 端到端 Mock SSE：多轮工具调用 + 上下文初始化 + 指标与结算闭环", async () => {
  storageService.initStorage();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omcx-runner-int-"));
  fs.writeFileSync(path.join(workDir, "hello.txt"), "hello world from test\n", "utf-8");

  storageService.addModel({
    id: "mock-ds",
    model_id: "deepseek-chat",
    provider: "deepseek",
    base_url: "https://mock.local/v1",
    api_key: "sk-mock-secret",
    context_limit: 128000,
    max_output_tokens: 4096,
  });

  const sessionId = `sess_int_${Date.now()}`;
  storageService.saveSession({
    id: sessionId,
    title: "测试工具调用",
    model: "mock-ds",
    work_dir: workDir,
    permission_mode: "auto-sandbox",
  });

  const originalFetch = global.fetch;
  let fetchCount = 0;
  const capturedBodies = [];

  global.fetch = async (url, init) => {
    fetchCount += 1;
    capturedBodies.push(JSON.parse(init.body));

    if (fetchCount === 1) {
      return makeSseResponse([
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_read_1",
                    type: "function",
                    function: { name: "read_file", arguments: '{"path":"hello.txt"}' },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 1200, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 600 } },
        })}\n\n`,
        "data: [DONE]\n\n",
      ]);
    }

    return makeSseResponse([
      `data: ${JSON.stringify({
        choices: [{ delta: { content: "已读取文件内容：hello world from test。" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1400, completion_tokens: 25, prompt_tokens_details: { cached_tokens: 1200 } },
      })}\n\n`,
      "data: [DONE]\n\n",
    ]);
  };

  const events = [];
  try {
    const res = await runAgentTurn(
      {
        sessionId,
        runId: "run_test_1",
        messages: [{ id: "u1", role: "user", content: "请读取 hello.txt 并告诉我里面是什么" }],
        model: "mock-ds",
        enableTools: true,
        workDir,
        permissionMode: "auto-sandbox",
      },
      {
        skipTitleSidecar: true,
        onEvent: (type, data) => events.push({ type, data }),
      }
    );

    assert.equal(res.ok, true);
    assert.equal(fetchCount, 2);
    assert.match(res.content, /hello world from test/);
    assert.equal(res.metadata.toolRounds, 1);
    assert.equal(res.metadata.truncated, false);
    assert.equal(res.metadata.usage.prompt_tokens, 2600);
    assert.equal(res.metadata.usage.cached_tokens, 1800);

    // 验证两轮 System Prompt 完全一致（不破环 Prompt Cache 前缀）
    assert.equal(capturedBodies[0].messages[0].role, "system");
    assert.equal(capturedBodies[0].messages[0].content, capturedBodies[1].messages[0].content);

    // 验证工具结果正确回传给模型第二轮
    const toolMsg = capturedBodies[1].messages.find((m) => m.role === "tool");
    assert.ok(toolMsg && toolMsg.content.includes("hello world from test"));
    assert.ok(events.some((e) => e.type === "tool_status" && e.data.tool === "read_file"));
    assert.ok(events.some((e) => e.type === "end"));
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test("agentRunner 端到端 Mock SSE：无 [DONE] 异常断流自动触发模式 E 续写完成", async () => {
  storageService.initStorage();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omcx-runner-abrupt-"));

  storageService.addModel({
    id: "mock-abrupt",
    model_id: "gpt-4o",
    provider: "openai",
    base_url: "https://mock.local/v1",
    api_key: "sk-mock-secret",
  });

  const sessionId = `sess_abrupt_${Date.now()}`;
  storageService.saveSession({
    id: sessionId,
    title: "测试断流续写",
    model: "mock-abrupt",
    work_dir: workDir,
    permission_mode: "auto-sandbox",
  });

  const originalFetch = global.fetch;
  let fetchCount = 0;

  global.fetch = async () => {
    fetchCount += 1;
    if (fetchCount === 1) {
      // 模拟上游超时断流：发了一半正文后流直接 close，既无 finish_reason 也无 [DONE]
      return makeSseResponse([
        `data: ${JSON.stringify({
          choices: [{ delta: { content: "第一部分分析：" } }],
        })}\n\n`,
      ]);
    }
    return makeSseResponse([
      `data: ${JSON.stringify({
        choices: [{ delta: { content: "已完成补充。" }, finish_reason: "stop" }],
      })}\n\n`,
      "data: [DONE]\n\n",
    ]);
  };

  try {
    const res = await runAgentTurn(
      {
        sessionId,
        runId: "run_abrupt_1",
        messages: [{ id: "u1", role: "user", content: "给出完整分析" }],
        model: "mock-abrupt",
        enableTools: false,
        workDir,
      },
      { skipTitleSidecar: true }
    );

    assert.equal(res.ok, true);
    assert.equal(fetchCount, 2);
    assert.equal(res.content, "第一部分分析：已完成补充。");
    assert.equal(res.metadata.truncated, false);
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});
