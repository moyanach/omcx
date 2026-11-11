/**
 * 项目诊断与测试运行服务
 *
 * - 自动识别 Node / Python / Go / Rust 项目的测试、Lint、类型检查任务
 * - 通过子进程执行，带超时与输出上限
 * - TypeScript 类型检查结果解析为结构化诊断（文件/行/列/级别/错误码）
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const MAX_OUTPUT_CHARS = 300000;
const DEFAULT_TIMEOUT_MS = 180000;

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function localBin(workDir, name) {
  const bin = path.join(workDir, "node_modules", ".bin", name);
  return fs.existsSync(bin) ? bin : null;
}

function detectTasks(workDir) {
  const tasks = [];
  if (!workDir || !fs.existsSync(workDir)) return tasks;

  const pkg = readJson(path.join(workDir, "package.json"));
  const scripts = pkg?.scripts || {};
  const hasTsConfig = fs.existsSync(path.join(workDir, "tsconfig.json"));
  const tsc = localBin(workDir, "tsc");

  if (hasTsConfig) {
    tasks.push({
      id: "typecheck",
      label: "TypeScript 类型检查",
      kind: "diagnostics",
      command: tsc
        ? `"${tsc}" --noEmit --pretty false`
        : "npx --no-install tsc --noEmit --pretty false",
    });
  }
  if (scripts.test) {
    tasks.push({ id: "test", label: "运行测试", kind: "test", command: "npm test --silent" });
  }
  if (scripts.lint) {
    tasks.push({ id: "lint", label: "代码规范检查", kind: "lint", command: "npm run lint --silent" });
  }
  if (scripts.typecheck && !hasTsConfig) {
    tasks.push({
      id: "typecheck",
      label: "类型检查",
      kind: "diagnostics",
      command: "npm run typecheck --silent",
    });
  }
  if (!scripts.typecheck && !hasTsConfig && scripts.build) {
    tasks.push({ id: "build", label: "构建校验", kind: "build", command: "npm run build --silent" });
  }

  if (fs.existsSync(path.join(workDir, "pyproject.toml")) || fs.existsSync(path.join(workDir, "pytest.ini"))) {
    tasks.push({ id: "pytest", label: "运行 Pytest", kind: "test", command: "python3 -m pytest -q" });
    tasks.push({ id: "ruff", label: "Ruff Lint", kind: "lint", command: "python3 -m ruff check ." });
  }
  if (fs.existsSync(path.join(workDir, "go.mod"))) {
    tasks.push({ id: "go-test", label: "运行 Go 测试", kind: "test", command: "go test ./..." });
    tasks.push({ id: "go-vet", label: "Go Vet", kind: "lint", command: "go vet ./..." });
  }
  if (fs.existsSync(path.join(workDir, "Cargo.toml"))) {
    tasks.push({ id: "cargo-test", label: "运行 Cargo 测试", kind: "test", command: "cargo test" });
    tasks.push({ id: "cargo-check", label: "Cargo Check", kind: "lint", command: "cargo check" });
  }

  return tasks;
}

function parseTypeScriptDiagnostics(output) {
  const diagnostics = [];
  const re = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/gm;
  let match;
  while ((match = re.exec(output)) !== null) {
    diagnostics.push({
      file: match[1].trim(),
      line: Number(match[2]),
      column: Number(match[3]),
      severity: match[4],
      code: match[5],
      message: match[6].trim(),
    });
    if (diagnostics.length >= 500) break;
  }
  return diagnostics;
}

function runShell(command, workDir, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let child;
    const env = {
      ...process.env,
      PATH: `${path.join(workDir, "node_modules", ".bin")}${path.delimiter}${process.env.PATH || ""}`,
      FORCE_COLOR: "0",
      CI: "1",
    };
    try {
      child = spawn("/bin/sh", ["-c", command], {
        cwd: workDir,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ success: false, error: err.message, durationMs: 0 });
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ success: false, error: err.message, durationMs: Date.now() - startedAt });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        success: code === 0,
        exitCode: code,
        signal,
        timedOut: signal === "SIGKILL",
        stdout: stdout.slice(0, MAX_OUTPUT_CHARS),
        stderr: stderr.slice(0, MAX_OUTPUT_CHARS),
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

async function runTask(workDir, taskId, options = {}) {
  if (!workDir || !fs.existsSync(workDir)) {
    return { success: false, error: "工作目录不存在" };
  }
  const tasks = detectTasks(workDir);
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return { success: false, error: `未找到任务: ${taskId}` };

  const result = await runShell(
    task.command,
    workDir,
    Math.min(600000, Math.max(10000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS))
  );
  const combined = `${result.stdout || ""}\n${result.stderr || ""}`;
  const diagnostics =
    task.kind === "diagnostics" ? parseTypeScriptDiagnostics(combined) : [];
  return {
    ...result,
    task,
    diagnostics,
    summary: result.success
      ? `${task.label} 通过`
      : result.timedOut
      ? `${task.label} 超时`
      : `${task.label} 失败（退出码 ${result.exitCode ?? "?"}）`,
  };
}

module.exports = { detectTasks, runTask, parseTypeScriptDiagnostics };
