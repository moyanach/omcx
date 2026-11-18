const path = require("path");
const workspaceRefreshService = require("../../services/workspaceRefreshService");

const READ_ONLY_TOOLS = new Set([
  "read_file",
  "read_document",
  "list_directory",
  "search_code",
  "search_symbols",
  "find_references",
  "repo_map",
  "web_search",
  "web_fetch",
  "browser_logs",
]);

function isParallelSafeCall(item) {
  const name = item.tc.function.name;
  if (READ_ONLY_TOOLS.has(name)) return true;
  if (name === "dispatch_subagent") {
    const a = item.args || {};
    if (Array.isArray(a.tasks)) {
      return a.tasks.every((t) => t.readOnly !== false && t.agent !== "general");
    }
    return a.readOnly !== false && a.agent !== "general";
  }
  return false;
}

async function executeToolBatch({
  result,
  sessionId,
  sessionWorkDir,
  sessionAbort,
  sessionToolContext,
  mcpTools,
  hooksEnabled,
  hookOptions,
  hookService,
  toolRegistry,
  storageService,
  executedToolSteps,
  persistPartial,
  replyStream,
  apiMessages,
  buildAssistantReplayMessage,
  truncateToolResult,
  contextLimit,
  configuredToolResultMaxChars,
  toolResultMaxChars,
  supportsVision,
}) {
  const preparedCalls = result.toolCalls.map((tc, idx) => {
    const callId = tc.id || `call_${Date.now()}_${idx}`;
    let args = {};
    try {
      args = JSON.parse(tc.function.arguments);
    } catch {
      args = { _parseError: tc.function.arguments };
    }
    return { tc, callId, args };
  });

  for (const item of preparedCalls) {
    replyStream("tool_status", {
      tool: item.tc.function.name,
      status: "running",
      args: item.args,
      callId: item.callId,
    });
  }

  const executeSingleCall = async ({ tc, callId, args }) => {
    if (sessionAbort.cancelled) {
      return { tc, callId, args, execResult: { success: false, error: "已取消" } };
    }

    if (
      sessionToolContext.allowedToolNames &&
      !sessionToolContext.allowedToolNames.has(tc.function.name)
    ) {
      const whitelistBlockedResult = {
        success: false,
        error: `当前激活的技能限制了可用工具范围，已拒绝调用 ${tc.function.name}`,
      };
      executedToolSteps.push({
        tool: tc.function.name,
        status: "done",
        args,
        result: whitelistBlockedResult,
        callId,
      });
      replyStream("tool_status", {
        tool: tc.function.name,
        status: "done",
        args,
        result: whitelistBlockedResult,
        callId,
      });
      persistPartial(true);
      return {
        tc,
        callId,
        args,
        execResult: whitelistBlockedResult,
      };
    }

    if (hooksEnabled) {
      try {
        const preHook = await hookService.runHooks(
          "PreToolUse",
          {
            tool_name: tc.function.name,
            tool_input: args,
            session_id: sessionId,
            cwd: sessionWorkDir,
          },
          hookOptions
        );
        if (preHook.blocked) {
          const blockedResult = {
            success: false,
            error: `Hook 阻断了工具 ${tc.function.name}：${preHook.reason}`,
          };
          executedToolSteps.push({
            tool: tc.function.name,
            status: "done",
            args,
            result: blockedResult,
            callId,
          });
          replyStream("tool_status", {
            tool: tc.function.name,
            status: "done",
            args,
            result: blockedResult,
            callId,
          });
          return { tc, callId, args, execResult: blockedResult };
        }
      } catch (hookErr) {
        console.warn("[hook] PreToolUse 执行异常:", hookErr.message);
      }
    }

    let currentSubSteps = [];
    const callScopedContext =
      tc.function.name === "dispatch_subagent"
        ? {
            ...sessionToolContext,
            onSubagentProgress: (subSteps) => {
              currentSubSteps = subSteps;
              replyStream("tool_status", {
                tool: tc.function.name,
                status: "running",
                args,
                callId,
                subSteps,
              });
            },
          }
        : sessionToolContext;

    const execResult = await toolRegistry.execute(
      tc.function.name,
      args,
      callScopedContext,
      mcpTools
    );

    if (hooksEnabled) {
      try {
        await hookService.runHooks(
          "PostToolUse",
          {
            tool_name: tc.function.name,
            tool_input: args,
            tool_response: execResult,
            session_id: sessionId,
            cwd: sessionWorkDir,
          },
          hookOptions
        );
      } catch (hookErr) {
        console.warn("[hook] PostToolUse 执行异常:", hookErr.message);
      }
    }

    if (
      (tc.function.name === "write_file" ||
        tc.function.name === "edit_file" ||
        tc.function.name === "generate_document") &&
      execResult?.success &&
      execResult?.data?.success !== false
    ) {
      const fullOutPath = path.isAbsolute(args.path)
        ? args.path
        : path.join(sessionWorkDir || "", args.path);
      const outItem = {
        name: path.basename(args.path),
        filePath: fullOutPath,
        fileType: path.extname(args.path).replace(".", "").toLowerCase() || "file",
        action: execResult?.data?.action || "modified",
      };
      storageService.addSessionOutput(sessionId, outItem);
      replyStream("outputs", outItem);
      workspaceRefreshService.emitWorkspaceChanged({
        workDir: sessionWorkDir,
        reason: "tool_write",
        areas: ["files", "git"],
        paths: [fullOutPath],
        invalidate: true,
      });
    } else if (
      tc.function.name === "spec_write" &&
      execResult?.success &&
      execResult?.data?.success !== false
    ) {
      workspaceRefreshService.emitWorkspaceChanged({
        workDir: sessionWorkDir,
        reason: "tool_spec",
        areas: ["files", "specs"],
        invalidate: true,
      });
    } else if (tc.function.name === "run_command" && execResult?.success !== false) {
      workspaceRefreshService.emitWorkspaceChanged({
        workDir: sessionWorkDir,
        reason: "tool_command",
        areas: ["files", "git", "specs", "worktrees", "commands", "skills", "subagents"],
        invalidate: true,
      });
    } else if (
      tc.function.name === "dispatch_subagent" &&
      !isParallelSafeCall({ tc, args })
    ) {
      workspaceRefreshService.emitWorkspaceChanged({
        workDir: sessionWorkDir,
        reason: "subagent",
        areas: ["files", "git", "specs", "worktrees", "commands", "skills", "subagents"],
        invalidate: true,
      });
    }

    executedToolSteps.push({
      tool: tc.function.name,
      status: "done",
      args,
      result: execResult,
      callId,
      ...(currentSubSteps.length > 0 ? { subSteps: currentSubSteps } : {}),
    });

    persistPartial(true);

    replyStream("tool_status", {
      tool: tc.function.name,
      status: "done",
      args,
      result: execResult,
      callId,
      ...(currentSubSteps.length > 0 ? { subSteps: currentSubSteps } : {}),
    });

    return { tc, callId, args, execResult };
  };

  const allReadOnly =
    preparedCalls.length > 1 && preparedCalls.every((item) => isParallelSafeCall(item));

  let completedCalls = [];
  if (allReadOnly) {
    completedCalls = await Promise.all(preparedCalls.map((item) => executeSingleCall(item)));
  } else {
    for (const item of preparedCalls) {
      if (sessionAbort.cancelled) break;
      const res = await executeSingleCall(item);
      completedCalls.push(res);
    }
  }

  if (completedCalls.length > 0) {
    apiMessages.push(
      buildAssistantReplayMessage(result, {
        toolCalls: completedCalls.map(({ tc, callId }) => ({
          id: callId,
          type: "function",
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        })),
      })
    );

    const pendingVisionShots = [];
    for (const { tc, callId, execResult } of completedCalls) {
      let sanitizedResult = execResult;
      if (sanitizedResult && typeof sanitizedResult === "object") {
        if ("__visionImageDataUrl" in sanitizedResult) {
          if (sanitizedResult.__visionImageDataUrl) {
            pendingVisionShots.push(sanitizedResult.__visionImageDataUrl);
          }
          const { __visionImageDataUrl, ...rest } = sanitizedResult;
          sanitizedResult = rest;
        }
        if (
          sanitizedResult.data &&
          typeof sanitizedResult.data === "object" &&
          "originalContent" in sanitizedResult.data
        ) {
          sanitizedResult = {
            ...sanitizedResult,
            data: { ...sanitizedResult.data, originalContent: undefined },
          };
        }
      }
      apiMessages.push({
        role: "tool",
        tool_call_id: callId,
        content: truncateToolResult(JSON.stringify(sanitizedResult), {
          contextLimit,
          configuredMaxChars: configuredToolResultMaxChars,
          maxChars: contextLimit ? undefined : toolResultMaxChars,
          toolName: tc.function.name,
        }),
      });
    }
    if (supportsVision && pendingVisionShots.length > 0) {
      const latestShot = pendingVisionShots[pendingVisionShots.length - 1];
      apiMessages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: "以上浏览器工具已截取当前页面画面，请结合截图内容继续分析或执行下一步操作：",
          },
          {
            type: "image_url",
            image_url: { url: latestShot },
          },
        ],
      });
    }
  }
}

module.exports = {
  isParallelSafeCall,
  executeToolBatch,
};
