const { ipcMain } = require("electron");
const {
  safeHandler,
  getStorageService,
  getAutomationService,
  getWebhookService,
  getCronParser,
} = require("../shared");

function registerAutomationIpc() {
  // ─── 定时任务规则 CRUD & 调度 ────────────────────────
  ipcMain.handle(
    "automation-list",
    safeHandler(() => ({
      rules: getStorageService().getAutomations(),
      runtime: getAutomationService().getRuntimeSnapshot(),
      unreadCount: getStorageService().getUnreadAutomationRunCount(),
    }))
  );

  ipcMain.handle(
    "automation-save",
    safeHandler((event, payload = {}) => {
      const rule = getStorageService().saveAutomation(payload);
      return { success: true, rule };
    })
  );

  ipcMain.handle(
    "automation-delete",
    safeHandler((event, id) => {
      const ok = getStorageService().deleteAutomation(id);
      return { success: ok };
    })
  );

  ipcMain.handle(
    "automation-toggle",
    safeHandler((event, { id, enabled } = {}) => {
      const storage = getStorageService();
      const existing = storage.getAutomation(id);
      if (!existing) throw new Error("定时任务规则不存在");
      const rule = storage.saveAutomation({
        id,
        enabled: Boolean(enabled),
      });
      return { success: true, rule };
    })
  );

  ipcMain.handle(
    "automation-run-now",
    safeHandler((event, { id, extraInput } = {}) =>
      getAutomationService().enqueueAutomationRun(id, {
        triggerSource: "manual",
        extraInput: extraInput || "",
      })
    )
  );

  ipcMain.handle(
    "automation-cancel-run",
    safeHandler((event, runId) => ({
      success: getAutomationService().cancelAutomationRun(runId),
    }))
  );

  ipcMain.handle(
    "automation-preview-cron",
    safeHandler((event, expr) => {
      const { validateCronExpression, getNextCronRun, describeSchedule } = getCronParser();
      const check = validateCronExpression(expr);
      if (!check.valid) {
        return { valid: false, error: check.error, nextRuns: [] };
      }
      const nextRuns = [];
      let cursor = Date.now();
      for (let i = 0; i < 3; i++) {
        const nextTs = getNextCronRun(check.parsed, cursor);
        if (!nextTs) break;
        nextRuns.push(nextTs);
        cursor = nextTs;
      }
      return {
        valid: true,
        summary: describeSchedule({ schedule_type: "cron", cron_expr: check.parsed.expr }),
        nextRuns,
      };
    })
  );

  // ─── 收件箱（运行历史与审阅状态） ────────────────────
  ipcMain.handle(
    "automation-list-runs",
    safeHandler((event, filters = {}) => {
      const storage = getStorageService();
      return {
        runs: storage.getAutomationRuns(filters || {}),
        unreadCount: storage.getUnreadAutomationRunCount(),
      };
    })
  );

  ipcMain.handle(
    "automation-update-run-triage",
    safeHandler((event, { runId, triageState } = {}) => {
      const storage = getStorageService();
      const ok = storage.updateAutomationRunTriage(runId, triageState);
      return {
        success: ok,
        unreadCount: storage.getUnreadAutomationRunCount(),
      };
    })
  );

  ipcMain.handle(
    "automation-mark-all-read",
    safeHandler(() => {
      const storage = getStorageService();
      storage.markAllAutomationRunsRead();
      return { success: true, unreadCount: 0 };
    })
  );

  ipcMain.handle(
    "automation-delete-run",
    safeHandler((event, runId) => {
      const storage = getStorageService();
      const ok = storage.deleteAutomationRun(runId);
      return {
        success: ok,
        unreadCount: storage.getUnreadAutomationRunCount(),
      };
    })
  );

  ipcMain.handle(
    "automation-open-run-session",
    safeHandler((event, { runId, sessionId } = {}) => {
      const storage = getStorageService();
      const run = runId ? storage.getAutomationRun(runId) : null;
      const targetSessionId = sessionId || run?.session_id;
      if (!targetSessionId) {
        throw new Error("该运行记录未关联可继续对话的会话");
      }
      const promoted = storage.promoteSessionToChat(targetSessionId);
      if (!promoted) {
        throw new Error("关联会话不存在或已被删除");
      }
      if (run && run.triage_state === "unread") {
        storage.updateAutomationRunTriage(run.id, "read");
      }
      return {
        success: true,
        session: promoted,
        unreadCount: storage.getUnreadAutomationRunCount(),
      };
    })
  );

  // ─── Outbound & Inbound Webhook 配置 ────────────────
  ipcMain.handle(
    "webhook-list-targets",
    safeHandler(() => getStorageService().getWebhookTargetsForRenderer())
  );

  ipcMain.handle(
    "webhook-save-target",
    safeHandler((event, payload = {}) => ({
      success: true,
      target: getStorageService().saveWebhookTarget(payload),
    }))
  );

  ipcMain.handle(
    "webhook-delete-target",
    safeHandler((event, id) => ({
      success: getStorageService().deleteWebhookTarget(id),
    }))
  );

  ipcMain.handle(
    "webhook-test-target",
    safeHandler(async (event, id) => {
      const storage = getStorageService();
      const target = storage.getWebhookTargets().find((t) => t.id === id);
      if (!target) throw new Error("推送通道不存在");
      return getWebhookService().sendTestWebhook(target);
    })
  );

  ipcMain.handle(
    "webhook-get-inbound",
    safeHandler(() => ({
      config: getStorageService().getInboundWebhookConfigForRenderer(),
      status: getWebhookService().getInboundServerStatus(),
    }))
  );

  ipcMain.handle(
    "webhook-save-inbound",
    safeHandler(async (event, payload = {}) => {
      const storage = getStorageService();
      const config = storage.saveInboundWebhookConfig(payload);
      const status = await getWebhookService().syncInboundServerState(storage);
      return { success: true, config, status };
    })
  );

  ipcMain.handle(
    "webhook-rotate-inbound-token",
    safeHandler(async () => {
      const storage = getStorageService();
      const config = storage.rotateInboundWebhookToken();
      const status = await getWebhookService().syncInboundServerState(storage);
      return { success: true, config, status };
    })
  );
}

module.exports = { registerAutomationIpc };
