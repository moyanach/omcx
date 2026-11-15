const path = require("path");
const {
  pendingPermissions,
  PERMISSION_TIMEOUT_MS,
  asyncStatSafe,
} = require("../shared");

function supersedeSessionPermissions(sessionId, replyStream, event) {
  for (const [permId, entry] of pendingPermissions) {
    if (entry.sessionId !== sessionId) continue;
    pendingPermissions.delete(permId);
    try {
      entry.settle({
        allow: false,
        decision: "superseded",
        reason: "新的执行请求已接管当前会话，旧审批自动作废",
      });
    } catch {}
    try {
      if (event?.sender && !event.sender.isDestroyed()) {
        replyStream("permission_resolved", {
          id: permId,
          reason: "新的执行请求已接管当前会话，旧审批自动作废",
        });
      }
    } catch {}
  }
}

function createPermissionChecker({
  sessionId,
  event,
  replyStream,
  customCheckPermission,
  isBuiltinTrustedPath,
  resolvedPermissionMode,
  PERMISSION_MODES,
  allowedFolders,
  writableFolders,
  sessionAbort,
  storageService,
}) {
  return async (targetPath, actionDesc, meta = {}) => {
    if (customCheckPermission) {
      return await customCheckPermission(targetPath, actionDesc, meta);
    }
    const kind = meta?.kind || "external_path";
    if (
      kind === "external_path" &&
      actionDesc === "读取" &&
      isBuiltinTrustedPath(targetPath, sessionId)
    ) {
      return true;
    }
    if (!event?.sender) {
      return resolvedPermissionMode === PERMISSION_MODES.FULL_ACCESS;
    }
    const reqId = `perm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    return new Promise((resolve) => {
      let settled = false;
      let destroyedHandler = null;
      let timer = null;
      const settleOnce = async (resp) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        pendingPermissions.delete(reqId);
        if (destroyedHandler && event?.sender) {
          try {
            event.sender.removeListener("destroyed", destroyedHandler);
          } catch {}
        }
        const allow = typeof resp === "object" ? !!resp.allow : !!resp;
        const decision =
          typeof resp === "object" && resp.decision
            ? resp.decision
            : allow
            ? "allow_once"
            : "deny";

        if (allow) {
          if (decision === "allow_session" && kind === "external_path" && targetPath) {
            const resolvedTarget = path.resolve(targetPath);
            const st = await asyncStatSafe(resolvedTarget);
            const folderToTrust =
              st && st.isDirectory() ? resolvedTarget : path.dirname(resolvedTarget);
            if (!allowedFolders.includes(folderToTrust)) {
              allowedFolders.push(folderToTrust);
            }
            if (actionDesc !== "读取" && actionDesc !== "浏览目录") {
              if (!writableFolders.includes(folderToTrust)) {
                writableFolders.push(folderToTrust);
              }
            }
          } else if (decision === "switch_auto_sandbox") {
            if (sessionAbort.toolContext) {
              sessionAbort.toolContext.permissionMode = PERMISSION_MODES.AUTO_SANDBOX;
            }
            const targetSess = storageService.getSessions().find((s) => s.id === sessionId);
            if (targetSess) {
              targetSess.permission_mode = PERMISSION_MODES.AUTO_SANDBOX;
              storageService.saveSession(targetSess);
            }
            event?.reply?.("session-permission-mode-updated", {
              sessionId,
              permissionMode: PERMISSION_MODES.AUTO_SANDBOX,
            });
          }
        }
        resolve(allow);
      };

      const notifyResolved = (reason) => {
        try {
          if (event?.sender && !event.sender.isDestroyed()) {
            replyStream("permission_resolved", { id: reqId, reason });
          }
        } catch {}
      };

      timer = setTimeout(() => {
        void settleOnce({
          allow: false,
          decision: "deny",
          reason: "审批等待超时，已自动拒绝",
        });
        notifyResolved("审批等待超时，已自动拒绝");
      }, PERMISSION_TIMEOUT_MS);

      destroyedHandler = () => {
        void settleOnce({
          allow: false,
          decision: "deny",
          reason: "窗口已关闭，审批自动作废",
        });
      };
      try {
        event?.sender?.once("destroyed", destroyedHandler);
      } catch {}

      pendingPermissions.set(reqId, { sessionId, settle: settleOnce });
      replyStream("permission", {
        id: reqId,
        path: targetPath,
        action: actionDesc,
        kind,
        command: meta?.command || undefined,
        allowSwitchAutoSandbox: Boolean(meta?.allowSwitchAutoSandbox),
        reason:
          meta?.reason ||
          "该路径位于当前已选定的工作空间源文件夹之外，请确认是否允许 Agent 访问该外部路径",
      });
    });
  };
}

module.exports = {
  supersedeSessionPermissions,
  createPermissionChecker,
};
