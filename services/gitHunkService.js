/**
 * Git 细粒度变更服务：Hunk 级暂存/取消暂存/丢弃、文件级暂存与丢弃、PR 创建
 *
 * Hunk 采用 `git diff -U3` 解析，重新拼装为补丁后通过
 * `git apply --cached [--reverse]` 精确写入索引；
 * 丢弃未暂存变更时通过 `git apply --reverse`（不带 --cached）直接还原工作区。
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile, spawn } = require("child_process");

const MAX_DIFF_BYTES = 4 * 1024 * 1024;

function runGit(args, cwd, options = {}) {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      {
        cwd,
        timeout: options.timeout || 30000,
        maxBuffer: MAX_DIFF_BYTES,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: err ? err.code : 0,
          stdout: stdout || "",
          stderr: stderr || (err ? err.message : ""),
        });
      }
    );
  });
}

function safeRelPath(workDir, filePath) {
  const root = path.resolve(workDir);
  const abs = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(root, filePath);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return path.relative(root, abs).replace(/\\/g, "/");
}

function parseDiff(diffText, filePath, staged) {
  const lines = diffText.split("\n");
  let header = "";
  let headerLines = [];
  const hunks = [];
  let current = null;

  const flush = () => {
    if (!current) return;
    // split("\n") 会让最后一个 Hunk 末尾多出一个空串；空行在 diff 中表示为 " "，
    // 因此该空串可安全剔除，同时保证 Hunk ID 在不同 diff 场景下稳定。
    while (current.lines.length > 1 && current.lines[current.lines.length - 1] === "") {
      current.lines.pop();
    }
    const raw = current.lines.join("\n");
    hunks.push({
      id: crypto
        .createHash("sha1")
        .update(`${staged ? "cached" : "work"}:${filePath}:${current.header}:${raw}`)
        .digest("hex")
        .slice(0, 12),
      header: current.header,
      oldStart: current.oldStart,
      oldLines: current.oldLines,
      newStart: current.newStart,
      newLines: current.newLines,
      lines: current.lines,
      raw,
    });
    current = null;
  };

  for (const line of lines) {
    if (line.startsWith("@@")) {
      flush();
      const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      current = {
        header: line,
        oldStart: m ? Number(m[1]) : 0,
        oldLines: m ? Number(m[2] ?? 1) : 0,
        newStart: m ? Number(m[3]) : 0,
        newLines: m ? Number(m[4] ?? 1) : 0,
        lines: [line],
      };
      continue;
    }
    if (current) {
      current.lines.push(line);
    } else if (line.startsWith("diff --git") || line.startsWith("---") || line.startsWith("+++") || line.startsWith("index ") || line.startsWith("new file") || line.startsWith("deleted file") || line.startsWith("similarity") || line.startsWith("rename") || line.startsWith("old mode") || line.startsWith("new mode")) {
      headerLines.push(line);
    }
  }
  flush();
  header = headerLines.join("\n");
  return { header, hunks };
}

async function readFileDiff(workDir, filePath, staged = false) {
  if (!workDir || !filePath) return { success: false, error: "参数不完整" };
  const rel = safeRelPath(workDir, filePath);
  if (!rel) return { success: false, error: "文件路径超出工作区范围" };

  const statusRes = await runGit(["status", "--porcelain", "--", rel], workDir);
  const statusLine = statusRes.stdout.split("\n").find(Boolean) || "";
  const isUntracked = statusLine.startsWith("??");

  if (isUntracked) {
    return {
      success: true,
      filePath: rel,
      staged,
      untracked: true,
      header: "",
      hunks: [],
      message: "未跟踪文件不支持逐 Hunk 暂存，请直接暂存整个文件",
    };
  }

  const args = ["diff", "--no-color", "--no-ext-diff", "--no-renames", "-U3"];
  if (staged) args.push("--cached");
  args.push("--", rel);
  const res = await runGit(args, workDir);
  if (!res.ok) return { success: false, error: res.stderr || "读取文件 Diff 失败" };
  if (!res.stdout.trim()) {
    return { success: true, filePath: rel, staged, untracked: false, header: "", hunks: [] };
  }

  const parsed = parseDiff(res.stdout, rel, staged);
  return {
    success: true,
    filePath: rel,
    staged,
    untracked: false,
    header: parsed.header,
    hunks: parsed.hunks,
  };
}

async function getFileHunks(workDir, filePath, staged = false) {
  const diff = await readFileDiff(workDir, filePath, staged);
  if (!diff.success) return diff;
  const { hunks, ...rest } = diff;
  return {
    ...rest,
    hunks: hunks.map(({ raw, ...h }) => h),
  };
}

function applyPatch(workDir, patch, options = {}) {
  const opts = typeof options === "boolean" ? { reverse: options } : options || {};
  const cached = opts.cached !== false; // 默认写入索引，保持 Hunk 暂存语义
  return new Promise((resolve) => {
    const args = ["apply", "--whitespace=nowarn"];
    if (cached) args.push("--cached");
    if (opts.reverse) args.push("--reverse");
    args.push("-");
    let child;
    try {
      child = spawn("git", args, { cwd: workDir, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      resolve({ success: false, error: err.message });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", (err) => resolve({ success: false, error: err.message }));
    child.on("close", (code) => {
      resolve(
        code === 0
          ? { success: true, stdout }
          : { success: false, error: stderr.trim() || `git apply 退出码 ${code}` }
      );
    });
    child.stdin.end(patch.endsWith("\n") ? patch : `${patch}\n`);
  });
}

/**
 * 暂存 / 取消暂存 / 丢弃指定 Hunk
 * - target=index（默认）：`git apply --cached`，用于暂存/取消暂存；
 * - target=worktree：`git apply [--reverse]`，用于丢弃未暂存变更。
 * @param {string} workDir
 * @param {string} filePath
 * @param {string[]} hunkIds
 * @param {{staged?: boolean, reverse?: boolean, target?: "index"|"worktree"}} options
 */
async function applyHunks(workDir, filePath, hunkIds, options = {}) {
  const staged = Boolean(options.staged);
  const reverse = Boolean(options.reverse);
  const target = options.target === "worktree" ? "worktree" : "index";
  if (!Array.isArray(hunkIds) || hunkIds.length === 0) {
    return { success: false, error: "未选择任何 Hunk" };
  }
  // 工作区丢弃必须基于未暂存 diff；索引操作沿用调用方的 staged 语义
  const readStaged = target === "worktree" ? false : staged;
  const diff = await readFileDiff(workDir, filePath, readStaged);
  if (!diff.success) return diff;
  if (diff.untracked) {
    if (target === "worktree") {
      return discardFile(workDir, filePath, { staged: false });
    }
    return staged
      ? { success: false, error: "未跟踪文件无法取消暂存 Hunk" }
      : stageFile(workDir, filePath);
  }
  const selected = diff.hunks.filter((h) => hunkIds.includes(h.id));
  if (selected.length !== hunkIds.length) {
    return { success: false, error: "部分 Hunk 已失效，请刷新变更后重试" };
  }

  const patch = [diff.header, ...selected.map((h) => h.raw)].filter(Boolean).join("\n");
  const applied = await applyPatch(workDir, patch, {
    reverse,
    cached: target === "index",
  });
  if (!applied.success) return applied;
  return {
    success: true,
    applied: selected.map((h) => h.id),
    count: selected.length,
    target,
  };
}

/**
 * 丢弃整个文件的变更
 * @param {string} workDir
 * @param {string} filePath
 * @param {{staged?: boolean}} options staged=true 时同时丢弃索引与工作区（回到 HEAD）
 */
async function discardFile(workDir, filePath, options = {}) {
  if (!workDir || !filePath) return { success: false, error: "参数不完整" };
  const rel = safeRelPath(workDir, filePath);
  if (!rel) return { success: false, error: "文件路径超出工作区范围" };

  const status = await runGit(["status", "--porcelain", "--", rel], workDir);
  if (!status.ok) return { success: false, error: status.stderr || "无法读取文件状态" };
  const line = status.stdout.trim();
  if (!line) return { success: false, error: "该文件没有可丢弃的变更" };

  if (line.startsWith("??")) {
    try {
      fs.rmSync(path.join(workDir, rel), { recursive: true, force: true });
      return { success: true, action: "removed", path: rel };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  const args = options.staged
    ? ["restore", "--source=HEAD", "--staged", "--worktree", "--", rel]
    : ["restore", "--worktree", "--", rel];
  const res = await runGit(args, workDir);
  if (res.ok) return { success: true, action: "discarded", path: rel };
  return { success: false, error: res.stderr || "丢弃变更失败" };
}

async function stageFile(workDir, filePath) {
  if (!workDir || !filePath) return { success: false, error: "参数不完整" };
  const rel = safeRelPath(workDir, filePath);
  if (!rel) return { success: false, error: "文件路径超出工作区范围" };
  const res = await runGit(["add", "--", rel], workDir);
  return res.ok ? { success: true } : { success: false, error: res.stderr };
}

async function unstageFile(workDir, filePath) {
  if (!workDir || !filePath) return { success: false, error: "参数不完整" };
  const rel = safeRelPath(workDir, filePath);
  if (!rel) return { success: false, error: "文件路径超出工作区范围" };
  let res = await runGit(["reset", "HEAD", "--", rel], workDir);
  if (!res.ok) {
    // 首次提交尚无 HEAD
    res = await runGit(["rm", "--cached", "--", rel], workDir);
  }
  return res.ok ? { success: true } : { success: false, error: res.stderr };
}

async function stageAll(workDir) {
  const res = await runGit(["add", "-A"], workDir);
  return res.ok ? { success: true } : { success: false, error: res.stderr };
}

async function createPullRequest(workDir, { title, body, base = "main", draft = false } = {}) {
  if (!workDir || !fs.existsSync(path.join(workDir, ".git"))) {
    return { success: false, error: "当前目录不是有效的 Git 仓库" };
  }
  if (!title || !title.trim()) {
    return { success: false, error: "PR 标题不能为空" };
  }
  const branchRes = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], workDir);
  const branch = branchRes.stdout.trim();
  if (!branch || branch === "HEAD") {
    return { success: false, error: "当前处于分离 HEAD 状态，无法创建 PR" };
  }
  const upstream = await runGit(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    workDir
  );
  if (!upstream.ok) {
    return {
      success: false,
      error: `当前分支 ${branch} 尚未推送到远端，请先执行 git push -u origin ${branch}`,
    };
  }
  const countRes = await runGit(["rev-list", "--count", `${base}..HEAD`], workDir);
  const ahead = Number(countRes.stdout.trim()) || 0;
  if (ahead === 0) {
    return { success: false, error: `当前分支相对 ${base} 没有新提交` };
  }

  return new Promise((resolve) => {
    const args = ["pr", "create", "--title", title.trim(), "--base", base, "--body-file", "-"];
    if (draft) args.push("--draft");
    let child;
    try {
      child = spawn("gh", args, { cwd: workDir, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      resolve({ success: false, error: `无法启动 gh CLI: ${err.message}` });
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      resolve({ success: false, error: "gh pr create 超时（>60s）" });
    }, 60000);
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        success: false,
        error:
          err.code === "ENOENT"
            ? "未检测到 GitHub CLI (gh)，请先安装并执行 gh auth login"
            : err.message,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        const url = stdout.match(/https?:\/\/\S+/)?.[0] || stdout.trim();
        resolve({ success: true, url, branch, base, stdout: stdout.trim() });
      } else {
        resolve({ success: false, error: stderr.trim() || `gh pr create 退出码 ${code}` });
      }
    });
    child.stdin.end(body || "");
  });
}

module.exports = {
  getFileHunks,
  applyHunks,
  discardFile,
  stageFile,
  unstageFile,
  stageAll,
  createPullRequest,
};
