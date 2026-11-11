/**
 * evalService — Agent 评测集运行器
 *
 * 评测用例：<OMCX_HOME>/evals/*.json
 * {
 *   "id": "write-hello",
 *   "name": "写入文件并校验内容",
 *   "description": "...",
 *   "prompt": "创建 hello.txt，内容为 Hello OMCX",
 *   "fixtures": [{ "path": "app.js", "content": "..." }],
 *   "expect": {
 *     "tools": ["write_file"],
 *     "noTools": ["run_command"],
 *     "files": [{ "path": "hello.txt", "exists": true, "contains": "Hello OMCX" }],
 *     "response": "创建|完成"
 *   },
 *   "maxRounds": 6,
 *   "tags": ["file", "smoke"]
 * }
 *
 * 运行器在工作区临时目录中跑真实的工具调用循环（OpenAI 兼容 / Anthropic 原生），
 * 校验工具调用轨迹与产物，并把每次评测写入 telemetry（source=eval）。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { toolRegistry } = require("../utils/toolRegistry");
const anthropicClient = require("./anthropicClient");
const telemetryService = require("./telemetryService");

const MAX_TOOL_RESULT_CHARS = 6000;
const MAX_KEEP_RUNS = 40;

function omcxHome() {
  return process.env.OMCX_HOME || path.join(os.homedir(), ".omcx");
}

function evalsDir() {
  return path.join(omcxHome(), "evals");
}

function runsDir() {
  return path.join(evalsDir(), ".runs");
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
}

const SAMPLE_EVALS = [
  {
    id: "write-hello",
    name: "创建文件并校验内容",
    description: "验证 Agent 能使用 write_file 创建指定内容的文件",
    prompt:
      "在当前工作目录创建 hello.txt，文件内容严格为一行：Hello OMCX。完成后简要说明。",
    expect: {
      tools: ["write_file"],
      files: [{ path: "hello.txt", exists: true, contains: "Hello OMCX" }],
    },
    maxRounds: 5,
    tags: ["file", "smoke"],
  },
  {
    id: "edit-existing",
    name: "精确定位并修改已有代码",
    description: "验证 Agent 能读取并编辑既有文件，而不是整文件覆盖",
    prompt:
      "当前目录的 app.js 中 value 的值是 1。请把它改为 2，保持其他内容不变。",
    fixtures: [
      { path: "app.js", content: "const value = 1;\nexport default value;\n" },
    ],
    expect: {
      tools: ["read_file"],
      files: [
        { path: "app.js", contains: "const value = 2;" },
        { path: "app.js", notContains: "const value = 1;" },
      ],
    },
    maxRounds: 6,
    tags: ["edit", "smoke"],
  },
  {
    id: "run-command-output",
    name: "执行命令并复述输出",
    description: "验证 Agent 能运行命令并读取 stdout",
    prompt:
      "请运行 shell 命令 echo OMCX-EVAL-42，并在回答中明确给出命令输出内容。",
    expect: {
      tools: ["run_command"],
      response: "OMCX-EVAL-42",
    },
    maxRounds: 5,
    tags: ["shell", "smoke"],
  },
];

function ensureSampleEvals() {
  const dir = evalsDir();
  ensureDir(dir);
  let existing = [];
  try {
    existing = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {}
  if (existing.length > 0) return;
  for (const sample of SAMPLE_EVALS) {
    try {
      fs.writeFileSync(
        path.join(dir, `${sample.id}.json`),
        JSON.stringify(sample, null, 2),
        "utf-8"
      );
    } catch {}
  }
}

function readEvalFile(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const id =
      raw.id || path.basename(filePath).replace(/\.json$/i, "");
    return {
      id,
      name: raw.name || id,
      description: raw.description || "",
      prompt: raw.prompt || raw.input || "",
      fixtures: Array.isArray(raw.fixtures) ? raw.fixtures : [],
      expect: raw.expect || {},
      maxRounds: Math.min(20, Math.max(1, Number(raw.maxRounds) || 6)),
      tags: Array.isArray(raw.tags) ? raw.tags : [],
      filePath,
    };
  } catch (err) {
    return {
      id: path.basename(filePath).replace(/\.json$/i, ""),
      name: path.basename(filePath),
      description: "",
      prompt: "",
      fixtures: [],
      expect: {},
      maxRounds: 6,
      tags: [],
      filePath,
      error: `解析失败: ${err.message}`,
    };
  }
}

function listEvals() {
  ensureSampleEvals();
  const dir = evalsDir();
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch {}
  return files.map((f) => {
    const item = readEvalFile(path.join(dir, f));
    return {
      id: item.id,
      name: item.name,
      description: item.description,
      prompt: item.prompt,
      tags: item.tags,
      maxRounds: item.maxRounds,
      filePath: item.filePath,
      error: item.error || null,
      expectSummary: Object.keys(item.expect || {}),
    };
  });
}

function getEvalById(id) {
  const dir = evalsDir();
  const direct = path.join(dir, `${id}.json`);
  if (fs.existsSync(direct)) return readEvalFile(direct);
  const found = listEvals().find((item) => item.id === id);
  return found ? readEvalFile(found.filePath) : null;
}

function trimSlash(url) {
  return String(url || "").replace(/\/+$/, "");
}

function normalizeOpenAIUsage(raw) {
  if (!raw) return null;
  return {
    prompt_tokens: Number(raw.prompt_tokens) || 0,
    completion_tokens: Number(raw.completion_tokens) || 0,
    total_tokens:
      Number(raw.total_tokens) ||
      (Number(raw.prompt_tokens) || 0) + (Number(raw.completion_tokens) || 0),
    cached_tokens:
      Number(raw.prompt_tokens_details?.cached_tokens) ||
      Number(raw.cached_tokens) ||
      0,
    cache_creation_tokens: Number(raw.cache_creation_input_tokens) || 0,
  };
}

function mergeUsage(total, usage) {
  if (!usage) return total;
  if (!total) return { ...usage };
  return {
    prompt_tokens: total.prompt_tokens + usage.prompt_tokens,
    completion_tokens: total.completion_tokens + usage.completion_tokens,
    total_tokens: total.total_tokens + usage.total_tokens,
    cached_tokens: (total.cached_tokens || 0) + (usage.cached_tokens || 0),
    cache_creation_tokens:
      (total.cache_creation_tokens || 0) + (usage.cache_creation_tokens || 0),
  };
}

function computeCost(usage, pricing = {}) {
  if (!usage) return 0;
  const input = usage.prompt_tokens || 0;
  const output = usage.completion_tokens || 0;
  const cached = usage.cached_tokens || 0;
  const creation = usage.cache_creation_tokens || 0;
  const perM = (n, price) => (Number(n) || 0) * (Number(price) || 0);
  return (
    perM(Math.max(0, input - cached), pricing.inputPrice) +
    perM(output, pricing.outputPrice) +
    perM(cached, pricing.cacheReadPrice || pricing.inputPrice) +
    perM(creation, pricing.cacheWritePrice || pricing.inputPrice)
  ) / 1_000_000;
}

function buildSystemPrompt(workDir) {
  const docs = toolRegistry.getToolPromptDocs([], { permissionMode: "auto-sandbox" });
  return [
    "你是 OMCX 评测运行器启动的自动化工程代理，只能使用提供的工具完成任务。",
    `当前工作目录：${workDir}`,
    "要求：直接动手执行，不要只给建议；修改文件必须使用工具；完成后用一两句话汇报结果。",
    "可用工具：",
    ...docs,
  ].join("\n");
}

async function callModelOnce({ messages, tools, modelConfig }) {
  const provider = String(modelConfig.provider || "").toLowerCase();
  if (anthropicClient.isAnthropicProvider(provider, modelConfig.baseUrl)) {
    const result = await anthropicClient.streamAnthropicMessage({
      baseUrl: modelConfig.baseUrl,
      apiKey: modelConfig.apiKey,
      model: modelConfig.model,
      messages,
      tools,
      maxTokens: 2048,
      temperature: 0.2,
      onText: () => {},
    });
    return {
      content: result.content || "",
      toolCalls: (result.toolCalls || []).map((tc) => ({
        id: tc.id,
        type: "function",
        function: {
          name: tc.function?.name || "",
          arguments:
            typeof tc.function?.arguments === "string"
              ? tc.function.arguments
              : JSON.stringify(tc.function?.arguments || {}),
        },
      })),
      usage: result.usage || null,
    };
  }

  const body = {
    model: modelConfig.model,
    messages,
    stream: false,
    temperature: 0.2,
  };
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  const response = await fetch(`${trimSlash(modelConfig.baseUrl)}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(modelConfig.apiKey
        ? { Authorization: `Bearer ${modelConfig.apiKey}` }
        : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`模型请求失败 (${response.status}): ${text.slice(0, 600)}`);
  }
  const data = await response.json();
  const message = data?.choices?.[0]?.message || {};
  const toolCalls = (message.tool_calls || []).map((tc, index) => ({
    id: tc.id || `call_${index}`,
    type: "function",
    function: {
      name: tc.function?.name || "",
      arguments:
        typeof tc.function?.arguments === "string"
          ? tc.function.arguments
          : JSON.stringify(tc.function?.arguments || {}),
    },
  }));
  return {
    content: typeof message.content === "string" ? message.content : "",
    toolCalls: toolCalls.filter((tc) => tc.function.name),
    usage: normalizeOpenAIUsage(data.usage),
  };
}

function safeParseArgs(raw) {
  if (raw && typeof raw === "object") return raw;
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

/**
 * 运行一次真实的工具调用循环（可独立测试）
 */
async function runAgentTurn({
  prompt,
  workDir,
  modelConfig,
  maxRounds = 6,
  tools = null,
  onStep = null,
}) {
  const toolDefs =
    tools || toolRegistry.getToolDefinitions([], null, { permissionMode: "auto-sandbox" });
  const messages = [
    { role: "system", content: buildSystemPrompt(workDir) },
    { role: "user", content: prompt },
  ];
  const toolCallLog = [];
  let usage = null;
  let response = "";
  let rounds = 0;

  for (let round = 0; round < maxRounds; round += 1) {
    rounds += 1;
    const result = await callModelOnce({ messages, tools: toolDefs, modelConfig });
    usage = mergeUsage(usage, result.usage ? normalizeOpenAIUsage(result.usage) : null);

    if (!result.toolCalls || result.toolCalls.length === 0) {
      response = result.content || "";
      break;
    }

    messages.push({
      role: "assistant",
      content: result.content || "",
      tool_calls: result.toolCalls,
    });

    for (const call of result.toolCalls) {
      const args = safeParseArgs(call.function.arguments);
      const startedAt = Date.now();
      let execResult;
      try {
        execResult = await toolRegistry.execute(call.function.name, args, {
          workDir,
          allowedFolders: [workDir],
          writableFolders: [workDir],
          permissionMode: "auto-sandbox",
          checkPermission: async () => ({ allow: true }),
          sessionId: "eval",
        });
      } catch (err) {
        execResult = { success: false, error: err.message || String(err) };
      }
      const durationMs = Date.now() - startedAt;
      const entry = {
        name: call.function.name,
        args,
        status: execResult?.success ? "ok" : "error",
        durationMs,
        error: execResult?.error || "",
      };
      toolCallLog.push(entry);
      if (typeof onStep === "function") onStep(entry);

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(execResult).slice(0, MAX_TOOL_RESULT_CHARS),
      });
    }
  }

  return { response, toolCalls: toolCallLog, usage, rounds };
}

function verifyCase(evalCase, { toolCalls, response, workDir }) {
  const checks = [];
  const expect = evalCase.expect || {};
  const names = toolCalls.map((t) => t.name);

  for (const tool of expect.tools || []) {
    checks.push({
      label: `调用了工具 ${tool}`,
      pass: names.includes(tool),
      detail: names.includes(tool) ? "" : `实际调用: ${names.join(", ") || "无"}`,
    });
  }
  for (const tool of expect.noTools || []) {
    checks.push({
      label: `未调用工具 ${tool}`,
      pass: !names.includes(tool),
      detail: names.includes(tool) ? "该工具被意外调用" : "",
    });
  }
  if (Number(expect.minToolCalls) > 0) {
    checks.push({
      label: `工具调用次数 ≥ ${expect.minToolCalls}`,
      pass: toolCalls.length >= Number(expect.minToolCalls),
      detail: `实际 ${toolCalls.length} 次`,
    });
  }

  for (const file of expect.files || []) {
    const fullPath = path.join(workDir, file.path);
    const exists = fs.existsSync(fullPath);
    if (file.exists === false) {
      checks.push({ label: `文件 ${file.path} 不存在`, pass: !exists, detail: "" });
      continue;
    }
    if (!exists) {
      checks.push({ label: `文件 ${file.path} 已创建`, pass: false, detail: "文件不存在" });
      continue;
    }
    const content = (() => {
      try {
        return fs.readFileSync(fullPath, "utf-8");
      } catch {
        return "";
      }
    })();
    if (file.contains) {
      checks.push({
        label: `${file.path} 包含 ${JSON.stringify(file.contains)}`,
        pass: content.includes(file.contains),
        detail: content.includes(file.contains) ? "" : content.slice(0, 300),
      });
    }
    if (file.notContains) {
      checks.push({
        label: `${file.path} 不包含 ${JSON.stringify(file.notContains)}`,
        pass: !content.includes(file.notContains),
        detail: content.includes(file.notContains) ? "仍存在旧内容" : "",
      });
    }
    if (file.matches) {
      let pass = false;
      try {
        pass = new RegExp(file.matches, "m").test(content);
      } catch {
        pass = false;
      }
      checks.push({ label: `${file.path} 匹配 /${file.matches}/`, pass, detail: "" });
    }
  }

  if (expect.response) {
    let pass = false;
    try {
      pass = new RegExp(expect.response, "i").test(response || "");
    } catch {
      pass = String(response || "").includes(expect.response);
    }
    checks.push({
      label: `回答匹配 /${expect.response}/`,
      pass,
      detail: pass ? "" : (response || "").slice(0, 300),
    });
  }

  return checks;
}

function cleanupOldRuns(keep = MAX_KEEP_RUNS) {
  const dir = runsDir();
  let entries = [];
  try {
    entries = fs
      .readdirSync(dir)
      .map((name) => ({ name, full: path.join(dir, name) }))
      .filter((e) => {
        try {
          return fs.statSync(e.full).isDirectory();
        } catch {
          return false;
        }
      })
      .sort((a, b) => {
        try {
          return fs.statSync(b.full).mtimeMs - fs.statSync(a.full).mtimeMs;
        } catch {
          return 0;
        }
      });
  } catch {
    return;
  }
  for (const stale of entries.slice(keep)) {
    try {
      fs.rmSync(stale.full, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * 运行单个评测
 */
async function runEval(evalId, { modelConfig, maxRounds } = {}) {
  const evalCase = getEvalById(evalId);
  if (!evalCase) return { success: false, error: `未找到评测用例: ${evalId}` };
  if (!evalCase.prompt) return { success: false, error: "评测用例缺少 prompt" };
  if (!modelConfig?.baseUrl || !modelConfig?.model) {
    return { success: false, error: "缺少可用的模型配置" };
  }

  const workDir = path.join(
    runsDir(),
    `${evalCase.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  );
  ensureDir(workDir);
  for (const fixture of evalCase.fixtures) {
    if (!fixture?.path) continue;
    const target = path.join(workDir, fixture.path);
    ensureDir(path.dirname(target));
    try {
      fs.writeFileSync(target, String(fixture.content ?? ""), "utf-8");
    } catch {}
  }

  const telemetryRun = telemetryService.startRun({
    sessionId: "",
    runId: "",
    model: modelConfig.model,
    provider: modelConfig.provider,
    source: "eval",
    meta: { evalId: evalCase.id, evalName: evalCase.name },
  });

  const startedAt = Date.now();
  try {
    const turn = await runAgentTurn({
      prompt: evalCase.prompt,
      workDir,
      modelConfig,
      maxRounds: Math.min(
        20,
        Math.max(1, Number(maxRounds) || evalCase.maxRounds || 6)
      ),
      onStep: (step) =>
        telemetryService.recordToolCall(telemetryRun.id, {
          name: step.name,
          status: step.status,
          durationMs: step.durationMs,
          summary: JSON.stringify(step.args || {}).slice(0, 240),
        }),
    });

    const checks = verifyCase(evalCase, {
      toolCalls: turn.toolCalls,
      response: turn.response,
      workDir,
    });
    const success = checks.length > 0 ? checks.every((c) => c.pass) : true;
    const costUsd = computeCost(turn.usage, {
      inputPrice: modelConfig.inputPrice,
      outputPrice: modelConfig.outputPrice,
      cacheReadPrice: modelConfig.cacheReadPrice,
      cacheWritePrice: modelConfig.cacheWritePrice,
    });

    telemetryService.finishRun(telemetryRun.id, {
      success,
      rounds: turn.rounds,
      contentChars: (turn.response || "").length,
      usage: turn.usage,
      costUsd,
    });

    cleanupOldRuns();
    return {
      success,
      evalId: evalCase.id,
      name: evalCase.name,
      checks,
      response: turn.response,
      toolCalls: turn.toolCalls.map((t) => ({
        name: t.name,
        status: t.status,
        durationMs: t.durationMs,
        error: t.error,
      })),
      usage: turn.usage,
      costUsd,
      durationMs: Date.now() - startedAt,
      workspace: workDir,
      telemetryRunId: telemetryRun.id,
    };
  } catch (err) {
    telemetryService.finishRun(telemetryRun.id, {
      success: false,
      error: err.message || String(err),
      rounds: 0,
    });
    return {
      success: false,
      evalId: evalCase.id,
      name: evalCase.name,
      error: err.message || String(err),
      durationMs: Date.now() - startedAt,
      workspace: workDir,
    };
  }
}

async function runAll({ modelConfig, ids = null, maxRounds } = {}) {
  const targets = Array.isArray(ids) && ids.length
    ? ids
    : listEvals()
        .filter((item) => !item.error)
        .map((item) => item.id);
  const results = [];
  for (const id of targets) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await runEval(id, { modelConfig, maxRounds }));
  }
  return {
    total: results.length,
    passed: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
    results,
  };
}

module.exports = {
  SAMPLE_EVALS,
  evalsDir,
  listEvals,
  getEvalById,
  runEval,
  runAll,
  runAgentTurn,
  verifyCase,
  ensureSampleEvals,
};
