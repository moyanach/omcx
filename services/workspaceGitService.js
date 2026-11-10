const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

function runGitExec(args, cwd, maxBuffer = 2 * 1024 * 1024) {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, maxBuffer, timeout: 15000 },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: stdout ? String(stdout) : "",
          stderr: stderr ? String(stderr) : "",
          error: err ? err.message : null,
        });
      }
    );
  });
}

/**
 * 获取指定目录的 Git 状态和改动行数摘要
 * @param {string} workDir
 * @returns {Promise<{isGit: boolean, branch?: string, insertions: number, deletions: number, modifiedFiles: Array<{path: string, status: string}>}>}
 */
async function getWorkspaceGitStatus(workDir) {
  if (!workDir || !fs.existsSync(workDir)) {
    return {
      isGit: false,
      insertions: 0,
      deletions: 0,
      modifiedFiles: [],
    };
  }

  const gitDir = path.join(workDir, ".git");
  if (!fs.existsSync(gitDir)) {
    return {
      isGit: false,
      insertions: 0,
      deletions: 0,
      modifiedFiles: [],
    };
  }

  const [branchRes, statusRes, diffRes, cachedDiffRes] = await Promise.all([
    runGitExec(["rev-parse", "--abbrev-ref", "HEAD"], workDir),
    runGitExec(["status", "--porcelain"], workDir),
    runGitExec(["diff", "--shortstat"], workDir),
    runGitExec(["diff", "--cached", "--shortstat"], workDir),
  ]);

  const branch = branchRes.ok && branchRes.stdout.trim() ? branchRes.stdout.trim() : "main";
  const modifiedFiles = [];

  if (statusRes.ok && statusRes.stdout) {
    const lines = statusRes.stdout.split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      const rawStatus = line.slice(0, 2).trim() || "M";
      let filePath = line.slice(3).trim();
      // 处理重命名 "old -> new"
      if (filePath.includes(" -> ")) {
        filePath = filePath.split(" -> ").pop().trim();
      }
      // 去除 git 对中文或含空格路径添加的引号
      if (filePath.startsWith('"') && filePath.endsWith('"')) {
        filePath = filePath.slice(1, -1);
      }
      const normalizedStatus =
        rawStatus === "??"
          ? "U"
          : rawStatus.includes("D")
          ? "D"
          : rawStatus.includes("A")
          ? "A"
          : "M";
      modifiedFiles.push({ path: filePath, status: normalizedStatus });
    }
  }

  let insertions = 0;
  let deletions = 0;
  for (const res of [diffRes, cachedDiffRes]) {
    if (res.ok && res.stdout) {
      const insM = res.stdout.match(/(\d+)\s+insertion/);
      const delM = res.stdout.match(/(\d+)\s+deletion/);
      if (insM) insertions += parseInt(insM[1], 10);
      if (delM) deletions += parseInt(delM[1], 10);
    }
  }

  return {
    isGit: true,
    branch,
    insertions,
    deletions,
    modifiedFiles,
  };
}

/**
 * 获取工作区单个文件的 Git 变更对比（返回旧文件内容与新文件内容供左右分栏或行内 Diff 渲染）
 * @param {string} workDir
 * @param {string} filePath
 */
async function getWorkspaceFileDiff(workDir, filePath) {
  if (!workDir || !filePath) {
    return { success: false, error: "参数不完整" };
  }

  const root = path.resolve(workDir);
  const absTarget = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(root, filePath);

  if (absTarget !== root && !absTarget.startsWith(root + path.sep)) {
    return { success: false, error: "文件路径超出当前工作目录范围" };
  }

  const relPath = path.relative(root, absTarget).replace(/\\/g, "/");

  let oldText = "";
  const showRes = await runGitExec(["show", `HEAD:${relPath}`], root, 3 * 1024 * 1024);
  if (showRes.ok) {
    oldText = showRes.stdout;
  }

  let newText = "";
  let isBinary = false;
  if (fs.existsSync(absTarget)) {
    try {
      const stat = fs.statSync(absTarget);
      if (stat.isFile()) {
        const buf = fs.readFileSync(absTarget);
        if (buf.subarray(0, 4096).includes(0)) {
          isBinary = true;
        } else {
          newText = buf.toString("utf-8").slice(0, 300000);
        }
      }
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  if (oldText.length > 300000) {
    oldText = oldText.slice(0, 300000);
  }

  return {
    success: true,
    filePath: relPath,
    absPath: absTarget,
    oldText,
    newText,
    isBinary,
  };
}

/**
 * 在指定工作区执行 Git Stage + Commit
 * @param {string} workDir
 * @param {string} commitMessage
 */
async function commitWorkspaceChanges(workDir, commitMessage) {
  if (!workDir || !fs.existsSync(path.join(workDir, ".git"))) {
    return { success: false, error: "当前目录不是有效的 Git 仓库" };
  }
  const msg = String(commitMessage || "").trim() || "chore: update workspace files";

  const addRes = await runGitExec(["add", "-A"], workDir);
  if (!addRes.ok) {
    return {
      success: false,
      error: addRes.stderr || addRes.error || "git add 失败",
    };
  }

  const commitRes = await runGitExec(["commit", "-m", msg], workDir);
  if (!commitRes.ok) {
    return {
      success: false,
      error: commitRes.stderr || commitRes.stdout || commitRes.error || "git commit 失败",
    };
  }

  const hashRes = await runGitExec(["rev-parse", "--short", "HEAD"], workDir);
  return {
    success: true,
    commitHash: hashRes.ok ? hashRes.stdout.trim() : "",
    stdout: commitRes.stdout.trim(),
  };
}

/**
 * 获取指定目录的所有 Git 分支列表及当前分支
 * @param {string} workDir
 * @returns {Promise<{success: boolean, currentBranch: string, branches: Array<{name: string, isCurrent: boolean}>, error?: string}>}
 */
async function getWorkspaceBranches(workDir) {
  if (!workDir || !fs.existsSync(workDir)) {
    return { success: false, currentBranch: "", branches: [], error: "路径不存在" };
  }
  const gitDir = path.join(workDir, ".git");
  if (!fs.existsSync(gitDir)) {
    return { success: false, currentBranch: "", branches: [], error: "当前目录不是有效的 Git 仓库" };
  }

  // 1. 获取当前分支
  const headRes = await runGitExec(["rev-parse", "--abbrev-ref", "HEAD"], workDir);
  const currentBranch = headRes.ok ? headRes.stdout.trim() : "";

  // 2. 获取本地分支列表
  const branchRes = await runGitExec(
    ["branch", "--format=%(refname:short)|%(HEAD)"],
    workDir
  );

  if (!branchRes.ok) {
    return {
      success: false,
      currentBranch,
      branches: currentBranch ? [{ name: currentBranch, isCurrent: true }] : [],
      error: branchRes.stderr || "获取分支列表失败",
    };
  }

  const branches = [];
  const lines = branchRes.stdout.split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const parts = line.split("|");
    const name = parts[0]?.trim();
    const isHead = parts[1]?.trim() === "*";
    if (name) {
      branches.push({
        name,
        isCurrent: isHead || name === currentBranch,
      });
    }
  }

  // 确保当前分支排在首位，其余按字母排序
  branches.sort((a, b) => {
    if (a.isCurrent) return -1;
    if (b.isCurrent) return 1;
    return a.name.localeCompare(b.name);
  });

  return {
    success: true,
    currentBranch,
    branches,
  };
}

/**
 * 切换或新建检出 Git 分支
 * @param {string} workDir
 * @param {string} branchName
 * @param {boolean} [createNew=false]
 */
async function checkoutWorkspaceBranch(workDir, branchName, createNew = false) {
  if (!workDir || !branchName) {
    return { success: false, error: "参数不完整" };
  }
  const safeBranch = String(branchName).trim();
  if (!safeBranch) {
    return { success: false, error: "分支名称不能为空" };
  }

  const args = createNew ? ["checkout", "-b", safeBranch] : ["checkout", safeBranch];
  const res = await runGitExec(args, workDir);

  if (!res.ok) {
    const rawErr = (res.stderr || res.stdout || res.error || "").trim();
    let friendlyErr = rawErr;
    if (rawErr.includes("Your local changes to the following files would be overwritten")) {
      friendlyErr = "检出失败：当前工作区存在未提交的文件修改，与目标分支冲突。请先提交或暂存后再切换。";
    } else if (rawErr.includes("already exists")) {
      friendlyErr = `检出失败：分支 '${safeBranch}' 已存在。`;
    } else if (rawErr.includes("did not match any file(s) known to git")) {
      friendlyErr = `检出失败：未找到名为 '${safeBranch}' 的分支。`;
    }
    return {
      success: false,
      error: friendlyErr,
      rawError: rawErr,
    };
  }

  return {
    success: true,
    branch: safeBranch,
    message: res.stdout.trim() || res.stderr.trim() || `已成功切换到分支 ${safeBranch}`,
  };
}

module.exports = {
  getWorkspaceGitStatus,
  getWorkspaceFileDiff,
  commitWorkspaceChanges,
  getWorkspaceBranches,
  checkoutWorkspaceBranch,
};
