#!/usr/bin/env node
/**
 * OMCX Headless CLI 入口
 *
 * 用于无头执行单次 Agent 任务（支持自动化测试与 Harbor/FrontierHarness 评测容器）。
 */

const fs = require("fs");
const path = require("path");

function printHelp() {
  console.log(`OMCX Headless CLI

用法:
  omcx-cli [选项] [prompt]

选项:
  -p, --prompt <text>         任务提示词内容
      --prompt-file <path>    从文件读取任务提示词
  -w, --workspace <dir>       工作空间目录（默认: 当前工作目录）
  -m, --model <model>         模型标识（支持 provider/model 格式，如 openrouter/deepseek/deepseek-chat）
      --provider <name>       显式指定服务商（openai / anthropic / openrouter / deepseek）
      --base-url <url>        自定义 API Base URL
      --api-key <key>         API Key（未传时自动读取对应环境变量）
      --permission-mode <m>   权限模式（默认: full-access，可选 plan/auto-sandbox/ask/full-access）
      --reasoning-effort <e>  推理深度（默认: medium，可选 off/low/medium/high/max）
      --max-rounds <n>        最大工具调用轮次上限
      --json-output <path>    将最终结构化结果（含 usage、costUsd）写入指定 JSON 文件
      --persist               关闭纯内存存储模式，使用本地 SQLite 持久化
  -h, --help                  显示帮助信息并退出

环境变量:
  OPENAI_API_KEY / OPENAI_BASE_URL
  OPENROUTER_API_KEY / OPENROUTER_BASE_URL
  ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_BASE_URL
  DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL
`);
}

function parseArgs(argv) {
  const opts = {
    prompt: "",
    promptFile: "",
    workspace: process.cwd(),
    model: process.env.OMCX_MODEL || "gpt-4o",
    provider: process.env.OMCX_PROVIDER || "",
    baseUrl: process.env.OMCX_BASE_URL || "",
    apiKey: process.env.OMCX_API_KEY || "",
    permissionMode: process.env.OMCX_PERMISSION_MODE || "full-access",
    reasoningEffort: process.env.OMCX_REASONING_EFFORT || "medium",
    maxRounds: process.env.OMCX_MAX_ROUNDS || "",
    jsonOutput: "",
    persist: false,
    help: false,
  };
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
    } else if (arg === "--persist") {
      opts.persist = true;
    } else if (arg === "-p" || arg === "--prompt") {
      opts.prompt = argv[++i] ?? "";
    } else if (arg === "--prompt-file") {
      opts.promptFile = argv[++i] ?? "";
    } else if (arg === "-w" || arg === "--workspace") {
      opts.workspace = argv[++i] ?? opts.workspace;
    } else if (arg === "-m" || arg === "--model") {
      opts.model = argv[++i] ?? opts.model;
    } else if (arg === "--provider") {
      opts.provider = argv[++i] ?? "";
    } else if (arg === "--base-url") {
      opts.baseUrl = argv[++i] ?? "";
    } else if (arg === "--api-key") {
      opts.apiKey = argv[++i] ?? "";
    } else if (arg === "--permission-mode") {
      opts.permissionMode = argv[++i] ?? opts.permissionMode;
    } else if (arg === "--reasoning-effort") {
      opts.reasoningEffort = argv[++i] ?? opts.reasoningEffort;
    } else if (arg === "--max-rounds") {
      opts.maxRounds = argv[++i] ?? "";
    } else if (arg === "--json-output") {
      opts.jsonOutput = argv[++i] ?? "";
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }

  if (!opts.prompt && positional.length > 0) {
    opts.prompt = positional.join(" ");
  }
  return opts;
}

function resolveModelAndAuth(opts) {
  const rawModel = String(opts.model || "gpt-4o").trim();
  let provider = String(opts.provider || "").trim().toLowerCase();
  let apiModelId = rawModel;

  if (!provider) {
    if (rawModel.startsWith("openrouter/")) {
      provider = "openrouter";
      apiModelId = rawModel.slice("openrouter/".length);
    } else if (rawModel.startsWith("anthropic/")) {
      provider = "anthropic";
      apiModelId = rawModel.slice("anthropic/".length);
    } else if (rawModel.startsWith("deepseek/")) {
      provider = "deepseek";
      apiModelId = rawModel.slice("deepseek/".length);
    } else if (rawModel.startsWith("openai/")) {
      provider = "openai";
      apiModelId = rawModel.slice("openai/".length);
    } else if (/claude/i.test(rawModel)) {
      provider = "anthropic";
    } else if (/deepseek/i.test(rawModel)) {
      provider = "deepseek";
    } else {
      provider = "openai";
    }
  } else if (rawModel.startsWith(`${provider}/`)) {
    apiModelId = rawModel.slice(provider.length + 1);
  }

  let apiKey = String(opts.apiKey || "").trim();
  let baseUrl = String(opts.baseUrl || "").trim();

  if (provider === "openrouter") {
    apiKey = apiKey || process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || "";
    baseUrl =
      baseUrl ||
      process.env.OPENROUTER_BASE_URL ||
      process.env.OPENAI_BASE_URL ||
      "https://openrouter.ai/api/v1";
  } else if (provider === "anthropic") {
    apiKey =
      apiKey || process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN || "";
    baseUrl = baseUrl || process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
  } else if (provider === "deepseek") {
    apiKey = apiKey || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || "";
    baseUrl =
      baseUrl ||
      process.env.DEEPSEEK_BASE_URL ||
      process.env.OPENAI_BASE_URL ||
      "https://api.deepseek.com/v1";
  } else {
    apiKey = apiKey || process.env.OPENAI_API_KEY || "";
    baseUrl = baseUrl || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  }

  return { provider, apiModelId, apiKey, baseUrl };
}

async function readStdinText() {
  if (process.stdin.isTTY) return "";
  return await new Promise((resolve) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    process.stdin.on("error", () => resolve(""));
  });
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[omcx-cli] 参数错误: ${err.message}`);
    process.exit(1);
  }

  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  if (!opts.persist && !process.env.OMCX_STORAGE_MEMORY_ONLY) {
    process.env.OMCX_STORAGE_MEMORY_ONLY = "1";
  }

  let promptText = opts.prompt;
  if (!promptText && opts.promptFile) {
    promptText = fs.readFileSync(path.resolve(opts.promptFile), "utf-8");
  }
  if (!promptText) {
    promptText = await readStdinText();
  }
  promptText = String(promptText || "").trim();
  if (!promptText) {
    console.error("[omcx-cli] 缺少任务提示词，请使用 --prompt、--prompt-file 或标准输入传入。");
    process.exit(1);
  }

  const workspaceDir = path.resolve(opts.workspace || process.cwd());
  if (!fs.existsSync(workspaceDir) || !fs.statSync(workspaceDir).isDirectory()) {
    console.error(`[omcx-cli] 工作空间目录不存在或不是目录: ${workspaceDir}`);
    process.exit(1);
  }

  const {
    getStorageService,
    getMcpClientService,
    flushActiveRunsAndStorageOnExit,
  } = require("../main/shared");
  const { runAgentTurn } = require("../main/agentRunner");

  const storageService = getStorageService();
  storageService.initStorage();

  if (opts.maxRounds) {
    const parsedRounds = Number(opts.maxRounds);
    if (Number.isFinite(parsedRounds) && parsedRounds > 0) {
      storageService.setConfig("max_tool_rounds", Math.floor(parsedRounds));
    }
  }

  const { provider, apiModelId, apiKey, baseUrl } = resolveModelAndAuth(opts);
  const cliModelId = "omcx-cli-model";
  storageService.addModel({
    id: cliModelId,
    name: apiModelId,
    provider,
    model_id: apiModelId,
    base_url: baseUrl,
    api_key: apiKey,
  });

  const sessionId = `cli_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const runId = `run_${Date.now()}`;

  storageService.saveWorkspace({
    id: "ws_cli",
    name: path.basename(workspaceDir) || "workspace",
    folders: [{ path: workspaceDir, name: path.basename(workspaceDir) || "workspace", isPrimary: true }],
  });
  storageService.saveSession({
    id: sessionId,
    title: "CLI Eval",
    model: cliModelId,
    workspace_id: "ws_cli",
    work_dir: workspaceDir,
    permission_mode: opts.permissionMode,
    reasoning_effort: opts.reasoningEffort,
  });

  const userMessages = [{ role: "user", content: promptText }];
  const startedAt = Date.now();
  let endedWithNewline = true;

  const result = await runAgentTurn(
    {
      sessionId,
      runId,
      messages: userMessages,
      model: cliModelId,
      enableTools: true,
      workDir: workspaceDir,
      permissionMode: opts.permissionMode,
      reasoningEffort: opts.reasoningEffort,
    },
    {
      skipTitleSidecar: true,
      checkPermission: async () => true,
      onEvent: (type, data) => {
        if (type === "data" && typeof data === "string" && data.length > 0) {
          process.stdout.write(data);
          endedWithNewline = data.endsWith("\n");
        } else if (type === "tool_status" && data?.tool) {
          process.stderr.write(`[tool:${data.status || "info"}] ${data.tool}\n`);
        } else if (type === "error" && data) {
          process.stderr.write(`[error] ${typeof data === "string" ? data : JSON.stringify(data)}\n`);
        }
      },
    }
  );

  if (!endedWithNewline) {
    process.stdout.write("\n");
  }

  const durationMs = Date.now() - startedAt;
  const summary = {
    ok: Boolean(result?.ok),
    cancelled: Boolean(result?.cancelled),
    error: result?.error || null,
    content: result?.content || "",
    reasoning: result?.reasoning || "",
    durationMs,
    toolRounds: result?.metadata?.toolRounds || 0,
    usage: result?.metadata?.usage || null,
    costUsd: result?.metadata?.costUsd || 0,
    model: result?.metadata?.model || apiModelId,
    provider: result?.metadata?.provider || provider,
  };

  if (opts.jsonOutput) {
    const outPath = path.resolve(opts.jsonOutput);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(summary, null, 2), "utf-8");
  }

  const promptTokens = summary.usage?.prompt_tokens || 0;
  const completionTokens = summary.usage?.completion_tokens || 0;
  const cachedTokens = summary.usage?.cached_tokens || 0;
  process.stderr.write(
    `[omcx-cli] ok=${summary.ok} rounds=${summary.toolRounds} durationMs=${durationMs} ` +
      `tokens(in=${promptTokens},cached=${cachedTokens},out=${completionTokens}) costUsd=${summary.costUsd}\n`
  );

  try {
    getMcpClientService().closeAll?.();
  } catch {}
  try {
    flushActiveRunsAndStorageOnExit();
  } catch {}

  process.exit(summary.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(`[omcx-cli] 未捕获异常: ${err?.stack || err}`);
  process.exit(1);
});
