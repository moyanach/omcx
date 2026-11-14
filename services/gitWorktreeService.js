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
  const topLevel = await getRepoRoot(workDir);
  if (!topLevel) {
    return { success: false, error: "当前目录不是有效的 Git 仓库" };
  }
  const res = await runGit(["worktree", "list", "--porcelain"], topLevel);
  if (!res.ok) return { success: false, error: res.stderr || "读取工作树失败" };
  const worktrees = parsePorcelain(res.stdout);
  const mainEntry = worktrees.find((w) => w.isMain && w.path);
  const repoRoot = mainEntry ? mainEntry.path : topLevel;
  for (const entry of worktrees) {
    if (!entry.isMain && entry.branch) {
      const cfg = await runGit(["config", "--get", `branch.${entry.branch}.omcxBase`], repoRoot);
      if (cfg.ok && cfg.stdout.trim()) {
        entry.sourceBranch = cfg.stdout.trim();
      }
    }
  }
  return { success: true, repoRoot, worktrees };
}

function isUnderWorktreesRoot(targetPath) {
  if (!targetPath) return false;
  const resolvedRoot = path.resolve(worktreesRoot());
  const resolvedTarget = path.resolve(String(targetPath));
  return (
    resolvedTarget !== resolvedRoot &&
    resolvedTarget.startsWith(resolvedRoot + path.sep)
  );
}

function groupsFilePath() {
  return path.join(worktreesRoot(), "groups.json");
}

function readGroupsFile() {
  try {
    const file = groupsFilePath();
    if (!fs.existsSync(file)) return {};
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeGroupsFile(data) {
  fs.mkdirSync(worktreesRoot(), { recursive: true });
  fs.writeFileSync(groupsFilePath(), JSON.stringify(data || {}, null, 2), "utf8");
}

function saveSessionWorktreeGroup(sessionId, entries = []) {
  const sid = String(sessionId || "").trim();
  if (!sid) return { success: false, error: "缺少 sessionId" };
  const all = readGroupsFile();
  all[sid] = Array.isArray(entries) ? entries : [];
  writeGroupsFile(all);
  return { success: true, entries: all[sid] };
}

function getSessionWorktreeGroup(sessionId) {
  const sid = String(sessionId || "").trim();
  if (!sid) return [];
  const all = readGroupsFile();
  const entries = Array.isArray(all[sid]) ? all[sid] : [];
  return entries.filter((item) => item && item.worktreePath && fs.existsSync(item.worktreePath));
}

function removeSessionWorktreeGroup(sessionId) {
  const sid = String(sessionId || "").trim();
  if (!sid) return { success: true };
  const all = readGroupsFile();
  if (Object.prototype.hasOwnProperty.call(all, sid)) {
    delete all[sid];
    writeGroupsFile(all);
  }
  return { success: true };
}

async function inspectManagedWorktree(targetPath, sessionId = "") {
  const groupEntries = sessionId ? getSessionWorktreeGroup(sessionId) : [];
  if (!isUnderWorktreesRoot(targetPath) || !fs.existsSync(targetPath)) {
    return { success: true, isManagedWorktree: false, groupEntries };
  }
  const listed = await listWorktrees(targetPath);
  if (!listed.success) {
    return { success: true, isManagedWorktree: false, groupEntries };
  }
  const realPath = (value) => {
    try {
      return fs.realpathSync(value);
    } catch {
      return path.resolve(String(value || ""));
    }
  };
  const resolvedTarget = realPath(targetPath);
  const entry = (listed.worktrees || []).find((w) => realPath(w.path) === resolvedTarget);
  if (!entry || entry.isMain) {
    return { success: true, isManagedWorktree: false, groupEntries };
  }
  return {
    success: true,
    isManagedWorktree: true,
    path: entry.path,
    branch: entry.branch || "",
    sourceBranch: entry.sourceBranch || "",
    repoRoot: listed.repoRoot,
    groupEntries,
  };
}

async function listBranches(workDir) {
  const listed = await listWorktrees(workDir);
  if (!listed.success) return listed;
  const res = await runGit(
    ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    listed.repoRoot
  );
  if (!res.ok) {
    return { success: false, error: res.stderr || "读取本地分支失败" };
  }
  const branches = res.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const mainEntry = (listed.worktrees || []).find((w) => w.isMain);
  return {
    success: true,
    repoRoot: listed.repoRoot,
    currentMainBranch: mainEntry?.branch || "",
    branches,
  };
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

  let sourceBranch = "";
  if (baseRef === "HEAD") {
    const headBranchRes = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
    if (headBranchRes.ok) {
      const nameOut = headBranchRes.stdout.trim();
      if (nameOut && nameOut !== "HEAD") sourceBranch = nameOut;
    }
  } else {
    const refCheck = await runGit(
      ["show-ref", "--verify", "--quiet", `refs/heads/${baseRef}`],
      repoRoot
    );
    if (refCheck.ok) sourceBranch = baseRef;
  }
  if (sourceBranch) {
    await runGit(["config", `branch.${branchName}.omcxBase`, sourceBranch], repoRoot);
  }

  return {
    success: true,
    repoRoot,
    path: targetPath,
    branch: branchName,
    base: baseRef,
    sourceBranch,
    createdBranch: createBranch,
  };
}

async function mergeWorktree(
  workDir,
  {
    sourcePath,
    targetBranch,
    autoCommit = true,
    commitMessage = "",
    removeAfterMerge = false,
  } = {}
) {
  const listed = await listWorktrees(workDir);
  if (!listed.success) return listed;

  const realPath = (value) => {
    try {
      return fs.realpathSync(value);
    } catch {
      return path.resolve(String(value || ""));
    }
  };
  const resolvedSource = realPath(String(sourcePath || ""));
  const entry = (listed.worktrees || []).find((w) => realPath(w.path) === resolvedSource);
  if (!entry || entry.isMain) {
    return { success: false, error: "未找到要合并的非主工作树" };
  }
  if (!entry.branch) {
    return { success: false, error: "该工作树处于游离 HEAD 状态，无法按分支合并" };
  }

  const safeTarget = safeBranchName(targetBranch);
  if (!safeTarget) {
    return { success: false, error: "请指定有效的目标分支名" };
  }
  if (safeTarget === entry.branch) {
    return { success: false, error: "目标分支不能与当前工作树分支相同" };
  }

  const targetExists = await runGit(
    ["show-ref", "--verify", "--quiet", `refs/heads/${safeTarget}`],
    listed.repoRoot
  );
  if (!targetExists.ok) {
    return { success: false, error: `目标分支不存在：${safeTarget}` };
  }

  const occupiedByOther = (listed.worktrees || []).find(
    (w) => !w.isMain && realPath(w.path) !== resolvedSource && w.branch === safeTarget
  );
  if (occupiedByOther) {
    return {
      success: false,
      error: `目标分支 ${safeTarget} 已被其他工作树 (${occupiedByOther.path}) 检出，无法在主工作区切换合并`,
    };
  }

  const wtStatus = await runGit(["status", "--porcelain"], entry.path);
  if (!wtStatus.ok) {
    return { success: false, error: wtStatus.stderr || "检查工作树状态失败" };
  }
  const hasWtChanges = Boolean(wtStatus.stdout.trim());
  let committedBeforeMerge = false;
  if (hasWtChanges) {
    if (!autoCommit) {
      return {
        success: false,
        error: "工作树存在未提交改动，请先提交或勾选「自动提交未保存改动」",
      };
    }
    const addRes = await runGit(["add", "-A"], entry.path);
    if (!addRes.ok) {
      return { success: false, error: addRes.stderr || "暂存工作树改动失败" };
    }
    const msg =
      String(commitMessage || "").trim() ||
      `chore(worktree): merge ${entry.branch} into ${safeTarget}`;
    const commitRes = await runGit(["commit", "-m", msg], entry.path);
    if (!commitRes.ok) {
      return { success: false, error: commitRes.stderr || "自动提交工作树改动失败" };
    }
    committedBeforeMerge = true;
  }

  const mainStatus = await runGit(["status", "--porcelain"], listed.repoRoot);
  if (!mainStatus.ok) {
    return { success: false, error: mainStatus.stderr || "检查主工作区状态失败" };
  }
  if (mainStatus.stdout.trim()) {
    return {
      success: false,
      error: "主工作区存在未提交改动，请先在主工作区提交或暂存后再合并，以免改动冲突或丢失",
    };
  }

  const mainEntry = (listed.worktrees || []).find((w) => w.isMain);
  const prevMainBranch = mainEntry?.branch || "";
  if (prevMainBranch !== safeTarget) {
    const checkoutRes = await runGit(["checkout", safeTarget], listed.repoRoot);
    if (!checkoutRes.ok) {
      return {
        success: false,
        error: checkoutRes.stderr || `无法在主工作区切换到目标分支 ${safeTarget}`,
      };
    }
  }

  const mergeRes = await runGit(
    ["merge", "--no-ff", entry.branch, "-m", `Merge branch '${entry.branch}' into ${safeTarget}`],
    listed.repoRoot,
    120000
  );
  if (!mergeRes.ok) {
    await runGit(["merge", "--abort"], listed.repoRoot);
    if (prevMainBranch && prevMainBranch !== safeTarget) {
      await runGit(["checkout", prevMainBranch], listed.repoRoot);
    }
    return {
      success: false,
      conflict: true,
      error: `合并到 ${safeTarget} 时发生冲突，已自动中止合并并恢复主工作区：\n${mergeRes.stderr || mergeRes.stdout}`,
    };
  }

  let removed = false;
  let removeWarning = "";
  if (removeAfterMerge) {
    const rmRes = await removeWorktree(listed.repoRoot, entry.path, { force: false });
    if (rmRes.success) {
      removed = true;
    } else {
      removeWarning = rmRes.error || "合并成功，但清理工作树失败";
    }
  }

  return {
    success: true,
    repoRoot: listed.repoRoot,
    sourceBranch: entry.branch,
    targetBranch: safeTarget,
    committedBeforeMerge,
    removed,
    removeWarning,
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
  if (isUnderWorktreesRoot(resolvedTarget) && fs.existsSync(resolvedTarget)) {
    try {
      fs.rmSync(resolvedTarget, { recursive: true, force: true });
    } catch {
      // 忽略残留文件删除失败
    }
  }
  return { success: true, path: resolvedTarget, repoRoot: listed.repoRoot };
}

async function inspectGitDirectories(folders = []) {
  const list = Array.isArray(folders) ? folders : [];
  const results = [];
  for (const folder of list) {
    const folderPath = String(folder?.path || "").trim();
    if (!folderPath || !fs.existsSync(folderPath)) {
      results.push({
        path: folderPath,
        name: folder?.name || path.basename(folderPath) || "unknown",
        isPrimary: Boolean(folder?.isPrimary),
        isGit: false,
        error: "目录不存在",
      });
      continue;
    }
    const repoRoot = await getRepoRoot(folderPath);
    if (!repoRoot) {
      results.push({
        path: folderPath,
        name: folder?.name || path.basename(folderPath),
        isPrimary: Boolean(folder?.isPrimary),
        isGit: false,
        error: "非 Git 仓库",
      });
      continue;
    }
    const headRes = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
    const currentBranch = headRes.ok ? headRes.stdout.trim() : "";
    results.push({
      path: folderPath,
      name: folder?.name || path.basename(folderPath),
      isPrimary: Boolean(folder?.isPrimary),
      isGit: true,
      repoRoot,
      currentBranch: currentBranch && currentBranch !== "HEAD" ? currentBranch : "",
    });
  }
  return { success: true, folders: results };
}

async function createMultiWorktrees({ folders = [], branch = "", base = "HEAD" } = {}) {
  const selected = (Array.isArray(folders) ? folders : []).filter((f) => f && f.path);
  if (selected.length === 0) {
    return { success: false, error: "请至少选择一个目录" };
  }

  const baseRef = safeBranchName(base) || "HEAD";
  let branchName = safeBranchName(branch);
  if (branch && !branchName) {
    return { success: false, error: `无效的分支名：${branch}` };
  }
  if (!branchName) {
    branchName = `omcx/task-${Date.now().toString(36)}`;
  }

  // 第一阶段：前置全量校验，避免无效创建
  const rootDir = worktreesRoot();
  const seenRepoRoots = new Set();
  const seenTargets = new Set();
  for (const folder of selected) {
    const repoRoot = await getRepoRoot(folder.path);
    if (!repoRoot) {
      return {
        success: false,
        error: `目录「${folder.name || folder.path}」不是有效的 Git 仓库`,
      };
    }
    const normalizedRepo = path.resolve(repoRoot);
    if (seenRepoRoots.has(normalizedRepo)) {
      return {
        success: false,
        error: `多个选中的目录属于同一 Git 仓库（${repoRoot}），请勿重复勾选`,
      };
    }
    seenRepoRoots.add(normalizedRepo);

    const verifyBase = await runGit(["rev-parse", "--verify", `${baseRef}^{commit}`], repoRoot);
    if (!verifyBase.ok) {
      return {
        success: false,
        error: `目录「${folder.name || folder.path}」中基引用不存在：${baseRef}`,
      };
    }

    const exists = await runGit(
      ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
      repoRoot
    );
    if (exists.ok) {
      const listed = await listWorktrees(repoRoot);
      const occupied = (listed.worktrees || []).find((w) => w.branch === branchName);
      if (occupied) {
        return {
          success: false,
          error: `目录「${folder.name || folder.path}」的分支 ${branchName} 已检出在 ${occupied.path}`,
        };
      }
    }

    const targetPath = path.join(
      rootDir,
      `${safePathSegment(path.basename(repoRoot))}-${safePathSegment(branchName)}`
    );
    const resolvedTarget = path.resolve(targetPath);
    if (resolvedTarget === normalizedRepo) {
      return {
        success: false,
        error: `目录「${folder.name || folder.path}」的工作树路径不能与主工作区相同`,
      };
    }
    if (seenTargets.has(resolvedTarget) || fs.existsSync(targetPath)) {
      return {
        success: false,
        error: `目录「${folder.name || folder.path}」的目标工作树路径已存在或冲突：${targetPath}`,
      };
    }
    seenTargets.add(resolvedTarget);
  }

  // 第二阶段：原子创建，任一失败立即全量回滚
  const created = [];
  for (const folder of selected) {
    const res = await createWorktree(folder.path, {
      branch: branchName,
      base: baseRef,
      name: folder.name,
    });
    if (!res?.success) {
      // 逆序回滚已创建的所有 worktree 与本次新建分支
      for (let i = created.length - 1; i >= 0; i--) {
        const item = created[i];
        try {
          await removeWorktree(item.repoRoot, item.worktreePath, { force: true });
          if (item.createdBranch && item.branch) {
            await runGit(["branch", "-D", item.branch], item.repoRoot);
          }
        } catch {
          // 尽量完成其余回滚
        }
      }
      return {
        success: false,
        rolledBack: true,
        error: `目录「${folder.name || folder.path}」创建失败（已全部回滚）：${res?.error || "未知错误"}`,
      };
    }
    created.push({
      name: folder.name || path.basename(folder.path),
      sourcePath: folder.path,
      repoRoot: res.repoRoot,
      worktreePath: res.path,
      branch: res.branch,
      sourceBranch: res.sourceBranch || "",
      isPrimary: Boolean(folder.isPrimary),
      createdBranch: Boolean(res.createdBranch),
    });
  }

  return {
    success: true,
    branch: branchName,
    items: created.map(({ createdBranch: _omit, ...rest }) => rest),
  };
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
  listBranches,
  inspectManagedWorktree,
  inspectGitDirectories,
  isUnderWorktreesRoot,
  createWorktree,
  createMultiWorktrees,
  saveSessionWorktreeGroup,
  getSessionWorktreeGroup,
  removeSessionWorktreeGroup,
  mergeWorktree,
  removeWorktree,
  pruneWorktrees,
  worktreesRoot,
};
