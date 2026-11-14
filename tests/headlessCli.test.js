const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

process.env.OMCX_STORAGE_MEMORY_ONLY = "1";

const storageService = require("../services/storageService");
const browserAutomationService = require("../services/browserAutomationService");
const { runAgentTurn } = require("../main/agentRunner");

test("storageService 在纯内存模式下无需 SQLite 即可完成会话与配置读写", async () => {
  assert.equal(storageService.isMemoryOnlyMode(), true);
  storageService.initStorage();

  storageService.setConfig("cli_test_key", { enabled: true, limit: 42 });
  assert.deepEqual(storageService.getConfig("cli_test_key"), { enabled: true, limit: 42 });

  const sessionId = `mem_sess_${Date.now()}`;
  const saved = storageService.saveSession({
    id: sessionId,
    title: "Memory Mode Test",
    model: "gpt-4o",
    work_dir: process.cwd(),
  });
  assert.equal(saved.success, true);
  assert.ok(storageService.getSessions().some((s) => s.id === sessionId));

  const addRes = storageService.addMessage(sessionId, {
    id: "m1",
    role: "user",
    content: "hello headless",
  });
  assert.equal(addRes.success, true);

  const msgs = await storageService.getMessagesAsync(sessionId);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].content, "hello headless");

  storageService.addSessionOutput(sessionId, {
    name: "out.txt",
    filePath: "/tmp/out.txt",
  });
  const outputs = await storageService.getSessionOutputsAsync(sessionId);
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].filePath, "/tmp/out.txt");
});

test("纯 Node 环境下加载 browserAutomationService 不会崩溃并在调用时提示 Headless 不可用", async () => {
  await assert.rejects(
    () => browserAutomationService.open({ url: "https://example.com" }),
    /Headless CLI/
  );
});

test("runAgentTurn 可脱离 Electron IPC 独立运行并正确返回错误状态", async () => {
  storageService.initStorage();
  storageService.addModel({
    id: "no_key_model",
    name: "no_key_model",
    provider: "openai",
    model_id: "gpt-4o",
    base_url: "https://api.openai.com/v1",
    api_key: "",
  });

  const events = [];
  const res = await runAgentTurn(
    {
      sessionId: "headless_err_test",
      runId: "run_err_1",
      messages: [{ role: "user", content: "hi" }],
      model: "no_key_model",
      enableTools: false,
      workDir: process.cwd(),
    },
    {
      skipTitleSidecar: true,
      onEvent: (type, data) => events.push({ type, data }),
    }
  );

  assert.equal(res.ok, false);
  assert.match(res.error || "", /API Key/);
  assert.ok(events.some((e) => e.type === "error"));
});

test("omcx-cli --help 正常输出使用说明并以 0 退出", () => {
  const cliPath = path.resolve(__dirname, "../bin/omcx-cli.js");
  const stdout = execFileSync(process.execPath, [cliPath, "--help"], {
    encoding: "utf-8",
  });
  assert.match(stdout, /OMCX Headless CLI/);
  assert.match(stdout, /--workspace/);
  assert.match(stdout, /--json-output/);
});
