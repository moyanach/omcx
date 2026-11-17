const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

process.env.OMCX_STORAGE_MEMORY_ONLY = "1";

const {
  parseCronExpression,
  validateCronExpression,
  getNextCronRun,
  computeNextRunAt,
} = require("../utils/cronParser");
const storageService = require("../services/storageService");
const webhookService = require("../services/webhookService");
const automationService = require("../services/automationService");

test("cronParser：校验工作日、步长表达式与下次执行时间", () => {
  assert.equal(validateCronExpression("0 9 * * 1-5").valid, true);
  assert.equal(validateCronExpression("*/15 * * * *").valid, true);
  assert.equal(validateCronExpression("0 9 * *").valid, false);
  assert.equal(validateCronExpression("99 9 * * *").valid, false);

  const parsedSunday7 = parseCronExpression("30 8 * * 7");
  assert.equal(parsedSunday7.dow.values.has(0), true);

  // 2026-11-13 是周五 08:30 本地时间，下一次工作日 09:00 应为当天 09:00
  const base = new Date(2026, 10, 13, 8, 30, 0, 0).getTime();
  const next = getNextCronRun("0 9 * * 1-5", base);
  const nextDate = new Date(next);
  assert.equal(nextDate.getHours(), 9);
  assert.equal(nextDate.getMinutes(), 0);
  assert.equal(nextDate.getDate(), 13);

  assert.equal(
    computeNextRunAt({ enabled: false, schedule_type: "interval", interval_minutes: 10 }, base),
    null
  );
  assert.equal(
    computeNextRunAt({ enabled: true, schedule_type: "manual" }, base),
    null
  );
  assert.equal(
    computeNextRunAt({ enabled: true, schedule_type: "interval", interval_minutes: 15 }, base),
    base + 15 * 60 * 1000
  );
});

test("automationStorage & sessionType：规则 CRUD、Webhook 脱敏保密钥与自动化会话隔离/转正", async () => {
  storageService.initStorage();

  // 1. Webhook 通道保存与脱敏不泄露原 URL/Secret
  const savedTarget = storageService.saveWebhookTarget({
    id: "wh_test_1",
    name: "研发飞书群",
    provider: "feishu",
    url: "https://open.feishu.cn/open-apis/bot/v2/hook/secret-hook-123456",
    secret: "my-feishu-secret-key",
  });
  assert.equal(savedTarget.has_url, true);
  assert.equal(savedTarget.has_secret, true);
  assert.equal(savedTarget.url_masked.includes("secret-hook"), false);
  assert.equal(savedTarget.secret_masked.includes("my-feishu"), false);

  // 编辑名称并传入 preserveUrl/preserveSecret 不覆盖原有凭据
  storageService.saveWebhookTarget({
    id: "wh_test_1",
    name: "研发飞书群-已更新",
    provider: "feishu",
    url: "",
    preserveUrl: true,
    secret: "",
    preserveSecret: true,
  });
  const decryptedTarget = storageService.getWebhookTargets().find((t) => t.id === "wh_test_1");
  assert.equal(decryptedTarget.name, "研发飞书群-已更新");
  assert.equal(
    decryptedTarget.url,
    "https://open.feishu.cn/open-apis/bot/v2/hook/secret-hook-123456"
  );
  assert.equal(decryptedTarget.secret, "my-feishu-secret-key");

  // 2. 定时规则创建与运行
  const rule = storageService.saveAutomation({
    id: "auto_test_1",
    name: "每周巡检",
    schedule_type: "cron",
    cron_expr: "0 9 * * 1-5",
    prompt: "检查项目待办",
    agent_mode: "work",
    permission_mode: "plan",
    webhook_target_id: "wh_test_1",
  });
  assert.equal(rule.enabled, true);
  assert.ok(rule.next_run_at > Date.now());

  // 3. 自动化隐藏会话在全文搜索中排除，转正后进入常规会话检索
  storageService.saveSession({
    id: "sess_auto_hidden",
    title: "独特自动化巡检关键词XYZ",
    session_type: "automation",
  });
  const hitsBefore = await storageService.searchSessionsAsync("XYZ");
  assert.equal(hitsBefore.length, 0);

  const promoted = storageService.promoteSessionToChat("sess_auto_hidden");
  assert.equal(promoted.session_type, "chat");
  const hitsAfter = await storageService.searchSessionsAsync("XYZ");
  assert.equal(hitsAfter.length, 1);

  storageService.deleteAutomation("auto_test_1");
  storageService.deleteWebhookTarget("wh_test_1");
});

test("webhookService：飞书/钉钉/企业微信/通用签名载荷与本地 Inbound HTTP 鉴权触发", async () => {
  storageService.initStorage();

  const feishuReq = webhookService.buildWebhookRequest(
    {
      provider: "feishu",
      url: "https://open.feishu.cn/hook/1",
      secret: "sec_123",
    },
    {
      id: "run_1",
      automation_name: "日报汇总",
      status: "success",
      trigger_source: "schedule",
      duration_ms: 3200,
      summary: "全部完成",
      outputs: [{ name: "daily.md", filePath: "/tmp/daily.md" }],
    }
  );
  assert.equal(feishuReq.body.msg_type, "interactive");
  assert.ok(feishuReq.body.sign);
  assert.ok(feishuReq.body.timestamp);

  const dingReq = webhookService.buildWebhookRequest(
    {
      provider: "dingtalk",
      url: "https://oapi.dingtalk.com/robot/send?access_token=abc",
      secret: "SECtest",
    },
    {
      id: "run_2",
      automation_name: "钉钉测试",
      status: "failed",
      error: "超时",
      duration_ms: 5000,
    }
  );
  assert.ok(dingReq.url.includes("&timestamp="));
  assert.ok(dingReq.url.includes("&sign="));

  const genericReq = webhookService.buildWebhookRequest(
    {
      provider: "generic",
      url: "https://example.com/hook",
      secret: "hmac_key",
    },
    { id: "run_3", automation_name: "通用", status: "success", summary: "ok" }
  );
  const expectedSig = crypto
    .createHmac("sha256", "hmac_key")
    .update(JSON.stringify(genericReq.body))
    .digest("hex");
  assert.equal(genericReq.headers["X-OMCX-Signature"], `sha256=${expectedSig}`);

  // 测试本地 Inbound HTTP Server（端口 0 动态或高位随机端口）
  const rotated = storageService.rotateInboundWebhookToken();
  const token = rotated.plain_token;
  assert.ok(token.startsWith("omcx_hook_"));

  let capturedTrigger = null;
  webhookService.setAutomationTriggerHandler(async (automationId, opts) => {
    capturedTrigger = { automationId, opts };
    return { ok: true, runId: "run_inbound_ok", queued: false };
  });

  const testPort = 39000 + Math.floor(Math.random() * 5000);
  const status = await webhookService.startInboundServer(storageService, testPort);
  assert.equal(status.listening, true);

  try {
    // 1) 无鉴权返回 401
    const unauth = await fetch(`http://127.0.0.1:${status.port}/hooks/automation/rule_abc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "hi" }),
    });
    assert.equal(unauth.status, 401);

    // 2) 正确 Bearer Token 返回 202 并触发 handler
    const authed = await fetch(`http://127.0.0.1:${status.port}/hooks/automation/rule_abc`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ input: "补充今日指标" }),
    });
    assert.equal(authed.status, 202);
    const body = await authed.json();
    assert.equal(body.ok, true);
    assert.equal(body.runId, "run_inbound_ok");
    assert.equal(capturedTrigger.automationId, "rule_abc");
    assert.equal(capturedTrigger.opts.triggerSource, "webhook");
    assert.equal(capturedTrigger.opts.extraInput, "补充今日指标");
  } finally {
    webhookService.setAutomationTriggerHandler(null);
    await webhookService.stopInboundServer();
  }
});

test("automationService：后台执行落库收件箱、隐藏会话上下文并支持到期调度", async () => {
  storageService.initStorage();

  const rule = storageService.saveAutomation({
    id: "auto_exec_1",
    name: "模拟后台执行",
    schedule_type: "interval",
    interval_minutes: 30,
    prompt: "生成今日分析摘要",
    agent_mode: "work",
    permission_mode: "auto-sandbox",
    next_run_at: Date.now() - 1000, // 故意设为已到期
  });

  let callCount = 0;
  automationService.setAgentTurnRunner(async (payload, opts) => {
    callCount += 1;
    opts.onEvent?.("outputs", [
      {
        name: "summary.md",
        filePath: "/tmp/summary.md",
        fileType: "markdown",
        action: "created",
      },
    ]);
    return {
      ok: true,
      cancelled: false,
      error: null,
      content: "## 今日总结\n一切正常。",
      reasoning: "",
      metadata: {
        toolRounds: 1,
        costUsd: 0.0123,
      },
    };
  });

  try {
    automationService.tickScheduler(Date.now());
    // 等待异步任务跑完
    for (let i = 0; i < 40; i++) {
      const runs = storageService.getAutomationRuns({ automationId: rule.id });
      if (runs.length > 0 && runs[0].status === "success") break;
      await new Promise((r) => setTimeout(r, 25));
    }

    assert.equal(callCount, 1);
    const runs = storageService.getAutomationRuns({ automationId: rule.id });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, "success");
    assert.equal(runs[0].triage_state, "unread");
    assert.equal(runs[0].trigger_source, "schedule");
    assert.equal(runs[0].outputs.length, 1);
    assert.ok(runs[0].summary.includes("今日总结"));

    // 验证关联会话已创建且默认标记为 automation，且已写入双轮消息便于后续追问
    const linkedSession = storageService.getSession(runs[0].session_id);
    assert.equal(linkedSession.session_type, "automation");
    const msgs = storageService.getMessages(runs[0].session_id);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].role, "user");
    assert.equal(msgs[1].role, "assistant");

    // 标为已读后未读数归零
    storageService.updateAutomationRunTriage(runs[0].id, "read");
    assert.equal(
      storageService
        .getAutomationRuns({ automationId: rule.id, triageState: "unread" })
        .length,
      0
    );
  } finally {
    automationService.setAgentTurnRunner(null);
    storageService.deleteAutomation(rule.id);
  }
});
