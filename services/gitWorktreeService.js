/**
 * Git Worktree 隔离服务
 *
 * 用途：为高风险/长周期任务创建独立的 Git 工作树，Agent 的所有改动都落在
 * 隔离目录中，不污染主工作区；确认无误后再合并回目标分支。
 *
 * 安全约束：
 * 1. 仅允许在 <OMCX_HOME>/worktrees/ 下创建新工作树；
 * 2. 删除时必须命中 `git worktree list` 且不能是主工作树；
 * 3. 分支名与基引用经过字符白名单校验，杜绝参数注入。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const MAX_BUFFER = 2 * 1024 * 1024;

function omcxHomeDir() {
  return process.env.OMCX_HOME || path.join(os.homedir(), ".omcx");
}

function worktreesRoot() {
  return path.join(omcxHomeDir(), "worktrees");
}

function runGit(args, cwd, timeout = 30000) {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, timeout, maxBuffer: MAX_BUFFER, windowsHide: true },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: stdout || "",
          stderr: stderr || (err ? err.message : ""),
        });
      }
    );
  });
}

function safeBranchName(value) {
  const name = String(value || "").trim();
  if (!name) return "";
  if (!/^[A-Za-z0-9._/~^@{}-]+$/.test(name)) return "";
  if (name.startsWith("-") || name.includes("..") || name.endsWith("/")) return "";
  return name;
}

function safePathSegment(value) {
  return (
    String(value || "")
      .trim()
      .replace(/[^A-Za-z0-9._-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "worktree"
  );
}

async function getRepoRoot(workDir) {
  if (!workDir) return null;
  const res = await runGit(["rev-parse", "--show-toplevel"], workDir);
  if (!res.ok) return null;
  const root = res.stdout.trim();
  return root || null;
}

function parsePorcelain(text) {
  const blocks = String(text || "")
    .trim()
    .split(/\r?\n\r?\n/)
    .filter(Boolean);
  return blocks.map((block, index) => {
    const entry = {
      path: "",
      head: "",
      branch: "",
      bare: false,
      detached: false,
      locked: false,
      prunable: false,
      isMain: index === 0,
    };
    for (const raw of block.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith("worktree ")) entry.path = line.slice(9).trim();
      else if (line.startsWith("HEAD ")) entry.head = line.slice(5).trim();
      else if (line.startsWith("branch ")) {
        entry.branch = line.slice(7).trim().replace(/^refs\/heads\//, "");
      } else if (line === "bare") entry.bare = true;
      else if (line === "detached") entry.detached = true;
      else if (line.startsWith("locked")) entry.locked = true;
      else if (line.startsWith("prunable")) entry.prunable = true;
    }
    return entry;
  }).filter((entry) => entry.path);
}

async function listWorktrees(workDir) {
  const repoRoot = await getRepoRoot(workDir);
  if (!repoRoot) {
    return { success: false, error: "当前目录不是有效的 Git 仓库" };
  }
  const res = await runGit(["worktree", "list", "--porcelain"], repoRoot);
  if (!res.ok) return { success: false, error: res.stderr || "读取工作树失败" };
  const worktrees = parsePorcelain(res.stdout);
  return { success: true, repoRoot, worktrees };
}

async function createWorktree(workDir, { branch = "", base = "HEAD", name = "" } = {}) {
  const repoRoot = await getRepoRoot(workDir);
  if (!repoRoot) {
    return { success: false, error: "当前目录不是有效的 Git 仓库" };
  }

  const baseRef = safeBranchName(base) || "HEAD";
  const verifyBase = await runGit(["rev-parse", "--verify", `${baseRef}^{commit}`], repoRoot);
  if (!verifyBase.ok) {
    return { success: false, error: `基引用不存在：${baseRef}` };
  }

  let branchName = safeBranchName(branch);
  const displayName = name || branchName || `task-${new Date().toISOString().slice(0, 10)}`;
  if (branch && !branchName) {
    return { success: false, error: `无效的分支名：${branch}` };
  }

  let createBranch = false;
  if (!branchName) {
    branchName = `omcx/${safePathSegment(displayName)}-${Date.now().toString(36)}`;
    createBranch = true;
  } else {
    const exists = await runGit(
      ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
      repoRoot
    );
    createBranch = !exists.ok;
    if (!createBranch) {
      const listed = await listWorktrees(repoRoot);
      const occupied = (listed.worktrees || []).find((w) => w.branch === branchName);
      if (occupied) {
        return {
          success: false,
          error: `分支 ${branchName} 已检出在工作树 ${occupied.path}，请换一个分支名`,
        };
      }
    }
  }

  const rootDir = worktreesRoot();
  const targetPath = path.join(
    rootDir,
    `${safePathSegment(path.basename(repoRoot))}-${safePathSegment(branchName)}`
  );
  if (path.resolve(targetPath) === path.resolve(repoRoot)) {
    return { success: false, error: "工作树路径不能与主工作区相同" };
  }
  if (fs.existsSync(targetPath)) {
    return { success: false, error: `目标目录已存在：${targetPath}` };
  }
  fs.mkdirSync(rootDir, { recursive: true });

  const args = createBranch
    ? ["worktree", "add", "-b", branchName, targetPath, baseRef]
    : ["worktree", "add", targetPath, branchName];
  const res = await runGit(args, repoRoot, 120000);
  if (!res.ok) {
    return { success: false, error: res.stderr || "创建 Git 工作树失败" };
  }

  return {
    success: true,
    repoRoot,
    path: targetPath,
    branch: branchName,
    base: baseRef,
    createdBranch: createBranch,
  };
}

async function removeWorktree(workDir, targetPath, { force = false } = {}) {
  const listed = await listWorktrees(workDir);
  if (!listed.success) return listed;
  const realPath = (value) => {
    try {
      return fs.realpathSync(value);
    } catch {
      return path.resolve(String(value || ""));
    }
  };
  const resolvedTarget = realPath(String(targetPath || ""));
  const entry = listed.worktrees.find((w) => realPath(w.path) === resolvedTarget);
  if (!entry) {
    return { success: false, error: "目标目录不在该仓库的已注册工作树中" };
  }
  if (entry.isMain || resolvedTarget === realPath(listed.repoRoot)) {
    return { success: false, error: "不能删除主工作树" };
  }
  const args = ["worktree", "remove"];
  if (force) args.push("--force");
  args.push(entry.path);
  const res = await runGit(args, listed.repoRoot, 60000);
  if (!res.ok) {
    return {
      success: false,
      error:
        res.stderr ||
        "删除工作树失败；若存在未提交改动，请勾选强制删除或先提交/丢弃变更",
    };
  }
  await runGit(["worktree", "prune"], listed.repoRoot);
  return { success: true, path: resolvedTarget };
}

async function pruneWorktrees(workDir) {
  const repoRoot = await getRepoRoot(workDir);
  if (!repoRoot) return { success: false, error: "当前目录不是有效的 Git 仓库" };
  const res = await runGit(["worktree", "prune"], repoRoot);
  return res.ok
    ? { success: true }
    : { success: false, error: res.stderr || "清理工作树失败" };
}

module.exports = {
  listWorktrees,
  createWorktree,
  removeWorktree,
  pruneWorktrees,
  worktreesRoot,
};
