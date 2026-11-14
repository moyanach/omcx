const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const GIT_STATUS_CACHE_TTL_MS = 400;
const gitStatusCache = new Map(); // normalizedDir -> { expiresAt, data }
const gitStatusInFlight = new Map(); // normalizedDir -> Promise

function normalizeDirKey(workDir) {
  if (!workDir) return "";
  try {
    return fs.realpathSync(path.resolve(workDir));
  } catch {
    return path.resolve(workDir);
  }
}

/**
 * 向上查找 Git 仓库根目录（兼容普通仓库、Worktree 的 .git 文件与 Monorepo 子目录）
 */
function resolveGitRepoRoot(workDir) {
  if (!workDir || !fs.existsSync(workDir)) return null;
  let cur = normalizeDirKey(workDir);
  while (cur) {
    if (fs.existsSync(path.join(cur, ".git"))) {
      return cur;
    }
    const parent = path.dirname(cur);
    if (!parent || parent === cur) break;
    cur = parent;
  }
  return null;
}

function invalidateGitStatusCache(workDir) {
  if (!workDir) {
    gitStatusCache.clear();
    return;
  }
  const key = normalizeDirKey(workDir);
  const root = resolveGitRepoRoot(workDir);
  gitStatusCache.delete(key);
  if (root) gitStatusCache.delete(root);
  for (const cachedKey of Array.from(gitStatusCache.keys())) {
    if (cachedKey === key || (root && (cachedKey === root || cachedKey.startsWith(root + path.sep)))) {
      gitStatusCache.delete(cachedKey);
    }
  }
}

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
 * 获取指定目录的 Git 状态和改动行数摘要（带并发请求去重与 400ms 短缓存）
 * @param {string} workDir
 * @returns {Promise<{isGit: boolean, branch?: string, insertions: number, deletions: number, modifiedFiles: Array<{path: string, status: string}>}>}
 */
async function getWorkspaceGitStatus(workDir) {
  const repoRoot = resolveGitRepoRoot(workDir);
  if (!repoRoot) {
    return {
      isGit: false,
      insertions: 0,
      deletions: 0,
      modifiedFiles: [],
    };
  }

  const cacheKey = normalizeDirKey(workDir);
  const cached = gitStatusCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  if (gitStatusInFlight.has(cacheKey)) {
    return gitStatusInFlight.get(cacheKey);
  }

  const pendingPromise = (async () => {
    const [branchRes, statusRes, diffRes, cachedDiffRes] = await Promise.all([
      runGitExec(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot),
      runGitExec(["status", "--porcelain"], repoRoot),
      runGitExec(["diff", "--shortstat"], repoRoot),
      runGitExec(["diff", "--cached", "--shortstat"], repoRoot),
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

    const result = {
      isGit: true,
      branch,
      insertions,
      deletions,
      modifiedFiles,
    };
    gitStatusCache.set(cacheKey, { expiresAt: Date.now() + GIT_STATUS_CACHE_TTL_MS, data: result });
    return result;
  })().finally(() => {
    gitStatusInFlight.delete(cacheKey);
  });

  gitStatusInFlight.set(cacheKey, pendingPromise);
  return pendingPromise;
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

  const root = normalizeDirKey(workDir);
  const repoRoot = resolveGitRepoRoot(workDir) || root;
  const absTarget = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(repoRoot, filePath);

  let realTarget = absTarget;
  try {
    if (fs.existsSync(absTarget)) {
      realTarget = fs.realpathSync(absTarget);
    } else {
      const parentReal = fs.realpathSync(path.dirname(absTarget));
      realTarget = path.join(parentReal, path.basename(absTarget));
    }
  } catch {}

  const allowedBase = repoRoot || root;
  if (realTarget !== allowedBase && !realTarget.startsWith(allowedBase + path.sep)) {
    return { success: false, error: "文件路径超出当前工作目录或仓库范围" };
  }

  const relPath = path.relative(repoRoot, realTarget).replace(/\\/g, "/");

  let oldText = "";
  const showRes = await runGitExec(["show", `HEAD:${relPath}`], repoRoot, 3 * 1024 * 1024);
  if (showRes.ok) {
    oldText = showRes.stdout;
  }

  let newText = "";
  let isBinary = false;
  if (fs.existsSync(realTarget)) {
    try {
      const stat = fs.statSync(realTarget);
      if (stat.isFile()) {
        // 仅需判定二进制并在 300k 字符处截断，按固定上限分块读取，避免超大文件整体载入内存
        const probeBytes = Math.min(stat.size, 4096);
        const textBytes = Math.min(stat.size, 1024 * 1024);
        const readBytes = Math.max(probeBytes, textBytes);
        const buf = Buffer.allocUnsafe(readBytes);
        const fd = fs.openSync(realTarget, "r");
        let filled = 0;
        try {
          while (filled < readBytes) {
            const read = fs.readSync(fd, buf, filled, readBytes - filled, filled);
            if (read <= 0) break;
            filled += read;
          }
        } finally {
          fs.closeSync(fd);
        }
        const head = buf.subarray(0, Math.min(filled, 4096));
        if (head.includes(0)) {
          isBinary = true;
        } else {
          newText = buf.subarray(0, filled).toString("utf-8").slice(0, 300000);
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
  if (!resolveGitRepoRoot(workDir)) {
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

  invalidateGitStatusCache(workDir);
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
  if (!resolveGitRepoRoot(workDir)) {
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
  // 防参数注入：分支名不允许以 - 开头（git 合法分支名本身也不允许），并显式用 -- 结束选项
  if (safeBranch.startsWith("-")) {
    return { success: false, error: "分支名称不能以 - 开头" };
  }

  const args = createNew
    ? ["checkout", "-b", safeBranch]
    : ["checkout", safeBranch, "--"];
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

  invalidateGitStatusCache(workDir);
  return {
    success: true,
    branch: safeBranch,
    message: res.stdout.trim() || res.stderr.trim() || `已成功切换到分支 ${safeBranch}`,
  };
}

/**
 * 删除本地 Git 分支，并支持可选同时删除远程分支
 * @param {string} workDir
 * @param {string} branchName
 * @param {{ deleteRemote?: boolean, force?: boolean }} [options]
 */
async function deleteWorkspaceBranch(
  workDir,
  branchName,
  { deleteRemote = false, force = false } = {}
) {
  if (!workDir || !branchName) {
    return { success: false, error: "参数不完整" };
  }
  const safeBranch = String(branchName).trim();
  if (!safeBranch) {
    return { success: false, error: "分支名称不能为空" };
  }
  if (safeBranch.startsWith("-")) {
    return { success: false, error: "分支名称不能以 - 开头" };
  }
  if (!resolveGitRepoRoot(workDir)) {
    return { success: false, error: "当前目录不是有效的 Git 仓库" };
  }

  const headRes = await runGitExec(["rev-parse", "--abbrev-ref", "HEAD"], workDir);
  const currentBranch = headRes.ok ? headRes.stdout.trim() : "";
  if (currentBranch && currentBranch === safeBranch) {
    return { success: false, error: `不能删除当前正在使用的分支 '${safeBranch}'` };
  }

  // 删除本地分支前先记录其追踪的 remote 与远端分支名
  let remoteName = "origin";
  let remoteBranch = safeBranch;
  if (deleteRemote) {
    const rCfg = await runGitExec(["config", "--get", `branch.${safeBranch}.remote`], workDir);
    if (rCfg.ok && rCfg.stdout.trim()) {
      remoteName = rCfg.stdout.trim();
    }
    const mCfg = await runGitExec(["config", "--get", `branch.${safeBranch}.merge`], workDir);
    if (mCfg.ok && mCfg.stdout.trim()) {
      remoteBranch = mCfg.stdout.trim().replace(/^refs\/heads\//, "");
    }
  }

  const delFlag = force ? "-D" : "-d";
  const delRes = await runGitExec(["branch", delFlag, "--", safeBranch], workDir);
  if (!delRes.ok) {
    const rawErr = (delRes.stderr || delRes.stdout || delRes.error || "").trim();
    if (/not fully merged/i.test(rawErr)) {
      return {
        success: false,
        notMerged: true,
        error: `分支 '${safeBranch}' 尚有未合并的提交，如需删除请确认强制删除`,
        rawError: rawErr,
      };
    }
    if (/used by worktree|checked out at/i.test(rawErr)) {
      return {
        success: false,
        error: `分支 '${safeBranch}' 正被其他工作树使用，请先移除对应工作树后再删除分支`,
        rawError: rawErr,
      };
    }
    return {
      success: false,
      error: rawErr || `删除分支 '${safeBranch}' 失败`,
      rawError: rawErr,
    };
  }

  let remoteDeleted = false;
  let remoteSkipped = false;
  let remoteWarning = "";

  if (deleteRemote) {
    const remoteRes = await runGitExec(
      ["push", remoteName, "--delete", "--", remoteBranch],
      workDir,
      30000
    );
    if (remoteRes.ok) {
      remoteDeleted = true;
    } else {
      const rErr = (remoteRes.stderr || remoteRes.stdout || remoteRes.error || "").trim();
      if (/remote ref does not exist/i.test(rErr)) {
        remoteSkipped = true;
        remoteWarning = `远程 ${remoteName}/${remoteBranch} 不存在，已跳过远程删除`;
      } else {
        remoteWarning = `本地分支已删除，但删除远程 ${remoteName}/${remoteBranch} 失败：${rErr || "请检查网络或仓库权限"}`;
      }
    }
  }

  return {
    success: true,
    branch: safeBranch,
    remoteDeleted,
    remoteSkipped,
    remoteWarning,
  };
}

/**
 * 解析 git log %D 装饰串（例如 "HEAD -> zhoushijie, origin/zhoushijie, origin/develop, tag: v1.0"）
 * 合并同名本地分支与 origin/<branch> 为单枚胶囊以贴合 Git Graph Next 展示风格
 */
function parseDecorations(raw) {
  const text = String(raw || "").trim();
  if (!text) return [];
  const tokens = text.split(",").map((s) => s.trim()).filter(Boolean);
  const localBranches = new Map();
  const remoteOnly = [];
  const tags = [];
  let headBranch = "";

  for (const tok of tokens) {
    if (tok.startsWith("HEAD -> ")) {
      const name = tok.slice("HEAD -> ".length).trim();
      headBranch = name;
      localBranches.set(name, { name, kind: "head", isHead: true, hasOrigin: false });
    } else if (tok === "HEAD") {
      // detached HEAD
      localBranches.set("HEAD", { name: "HEAD", kind: "head", isHead: true, hasOrigin: false });
    } else if (tok.startsWith("tag: ")) {
      tags.push({ name: tok.slice("tag: ".length).trim(), kind: "tag", isHead: false, hasOrigin: false });
    } else if (tok.includes("/")) {
      // e.g. origin/zhoushijie, upstream/main
      if (tok.endsWith("/HEAD")) continue;
      const slashIdx = tok.indexOf("/");
      const remoteName = tok.slice(0, slashIdx);
      const shortName = tok.slice(slashIdx + 1);
      if (remoteName === "origin" && localBranches.has(shortName)) {
        localBranches.get(shortName).hasOrigin = true;
      } else {
        remoteOnly.push({
          name: shortName,
          remote: remoteName,
          kind: "remote",
          isHead: false,
          hasOrigin: remoteName === "origin",
        });
      }
    } else {
      if (!localBranches.has(tok)) {
        localBranches.set(tok, { name: tok, kind: "local", isHead: tok === headBranch, hasOrigin: false });
      }
    }
  }

  // 再合并一次：如果 remoteOnly 里有 origin/<x> 且 localBranches 也有 <x>（因为顺序在后）
  const finalRemotes = [];
  for (const r of remoteOnly) {
    if (r.remote === "origin" && localBranches.has(r.name)) {
      localBranches.get(r.name).hasOrigin = true;
    } else {
      finalRemotes.push(r);
    }
  }

  return [...localBranches.values(), ...finalRemotes, ...tags];
}

/**
 * 只读获取多分支 Git 提交图谱数据
 */
async function getGitCommitGraph(workDir, { limit = 150, scope = "all" } = {}) {
  if (!workDir || !fs.existsSync(workDir)) {
    return { isGit: false, commits: [], uncommittedCount: 0, currentBranch: "" };
  }
  const checkRes = await runGitExec(["rev-parse", "--is-inside-work-tree"], workDir);
  if (!checkRes.ok || checkRes.stdout.trim() !== "true") {
    return { isGit: false, commits: [], uncommittedCount: 0, currentBranch: "" };
  }

  const safeLimit = Math.max(20, Math.min(500, Number(limit) || 150));
  const RS = "\x1e";
  const US = "\x1f";
  const format = `%H${US}%h${US}%P${US}%D${US}%an${US}%ar${US}%s${RS}`;
  const logArgs = [
    "log",
    ...(scope === "current" ? ["HEAD"] : ["--all"]),
    `--max-count=${safeLimit}`,
    "--date-order",
    `--format=${format}`,
  ];

  const [branchRes, statusRes, logRes] = await Promise.all([
    runGitExec(["rev-parse", "--abbrev-ref", "HEAD"], workDir),
    runGitExec(["status", "--porcelain"], workDir),
    runGitExec(logArgs, workDir, 8 * 1024 * 1024),
  ]);

  const currentBranch = branchRes.ok ? branchRes.stdout.trim() : "";
  const uncommittedCount = statusRes.ok
    ? statusRes.stdout.split(/\r?\n/).filter(Boolean).length
    : 0;

  const commits = [];
  if (logRes.ok && logRes.stdout) {
    const records = logRes.stdout.split(RS);
    for (const rec of records) {
      const trimmed = rec.replace(/^[\r\n]+/, "");
      if (!trimmed) continue;
      const parts = trimmed.split(US);
      if (parts.length < 7) continue;
      const [hash, shortHash, parentsRaw, decRaw, author, relativeTime, subject] = parts;
      commits.push({
        hash: (hash || "").trim(),
        shortHash: (shortHash || "").trim(),
        parents: (parentsRaw || "").trim() ? parentsRaw.trim().split(/\s+/) : [],
        refs: parseDecorations(decRaw),
        author: (author || "").trim(),
        relativeTime: (relativeTime || "").trim(),
        subject: (subject || "").trim(),
      });
    }
  }

  return {
    isGit: true,
    currentBranch,
    uncommittedCount,
    commits,
    hasMore: commits.length >= safeLimit,
  };
}

/**
 * 只读获取单条提交的详细信息与改动文件列表
 */
async function getGitCommitDetail(workDir, hash) {
  if (!workDir || !hash || !/^[a-fA-F0-9]{4,40}$/.test(String(hash).trim())) {
    return { ok: false, error: "无效的提交哈希" };
  }
  const safeHash = String(hash).trim();
  const res = await runGitExec(
    ["show", "--stat", "--format=%H%n%h%n%an%n%ae%n%ad%n%s%n%b%n---FILES---", safeHash],
    workDir,
    4 * 1024 * 1024
  );
  if (!res.ok) {
    return { ok: false, error: res.stderr || res.error || "读取提交详情失败" };
  }
  const text = res.stdout || "";
  const markerIdx = text.indexOf("---FILES---");
  const headerPart = markerIdx >= 0 ? text.slice(0, markerIdx) : text;
  const filesPart = markerIdx >= 0 ? text.slice(markerIdx + "---FILES---".length).trim() : "";
  const lines = headerPart.split(/\r?\n/);
  const [fullHash, shortHash, author, email, date, subject, ...bodyLines] = lines;

  return {
    ok: true,
    hash: fullHash || safeHash,
    shortHash: shortHash || safeHash.slice(0, 7),
    author: author || "",
    email: email || "",
    date: date || "",
    subject: subject || "",
    body: bodyLines.join("\n").trim(),
    stat: filesPart,
  };
}

async function getWorkingTreeChanges(workDir) {
  if (!resolveGitRepoRoot(workDir)) {
    return { success: false, staged: [], unstaged: [], stashCount: 0, error: "当前目录不是有效的 Git 仓库" };
  }
  const [statusRes, stashRes] = await Promise.all([
    runGitExec(["status", "--porcelain=v1", "-uall"], workDir),
    runGitExec(["stash", "list"], workDir),
  ]);
  if (!statusRes.ok) {
    return { success: false, staged: [], unstaged: [], stashCount: 0, error: statusRes.stderr || "读取工作区状态失败" };
  }
  const staged = [];
  const unstaged = [];
  for (const raw of statusRes.stdout.split(/\r?\n/)) {
    if (!raw || raw.length < 4) continue;
    const x = raw[0];
    const y = raw[1];
    let filePath = raw.slice(3).trim();
    if (filePath.includes(" -> ")) {
      filePath = filePath.split(" -> ").pop().trim();
    }
    if (!filePath) continue;
    if (x === "?" && y === "?") {
      unstaged.push({ path: filePath, status: "?" });
      continue;
    }
    if (x !== " ") {
      staged.push({ path: filePath, status: x });
    }
    if (y !== " ") {
      unstaged.push({ path: filePath, status: y });
    }
  }
  const stashCount = stashRes.ok
    ? stashRes.stdout.split(/\r?\n/).filter((l) => l.trim()).length
    : 0;
  return { success: true, staged, unstaged, stashCount };
}

async function commitStagedChanges(workDir, commitMessage) {
  if (!resolveGitRepoRoot(workDir)) {
    return { success: false, error: "当前目录不是有效的 Git 仓库" };
  }
  const msg = String(commitMessage || "").trim();
  if (!msg) {
    return { success: false, error: "提交信息不能为空" };
  }
  const cached = await runGitExec(["diff", "--cached", "--name-only"], workDir);
  if (!cached.ok || !cached.stdout.trim()) {
    return { success: false, error: "暂存区为空，请先 Add 要提交的文件" };
  }
  const res = await runGitExec(["commit", "-m", msg], workDir);
  if (!res.ok) {
    return { success: false, error: res.stderr || res.stdout || "提交失败" };
  }
  invalidateGitStatusCache(workDir);
  const hashRes = await runGitExec(["rev-parse", "--short", "HEAD"], workDir);
  return {
    success: true,
    hash: hashRes.ok ? hashRes.stdout.trim() : "",
  };
}

async function discardWorkspaceFile(workDir, filePath) {
  const repoRoot = resolveGitRepoRoot(workDir);
  if (!repoRoot || !filePath) {
    return { success: false, error: "无效的工作区或文件路径" };
  }
  const resolvedRoot = normalizeDirKey(repoRoot);
  const resolvedFile = path.resolve(resolvedRoot, filePath);
  let realFile = resolvedFile;
  try {
    if (fs.existsSync(resolvedFile)) realFile = fs.realpathSync(resolvedFile);
  } catch {}
  if (realFile !== resolvedRoot && !realFile.startsWith(resolvedRoot + path.sep)) {
    return { success: false, error: "文件路径越界" };
  }
  const stRes = await runGitExec(["status", "--porcelain=v1", "--", filePath], repoRoot);
  if (stRes.ok && stRes.stdout.trim().startsWith("??")) {
    try {
      fs.rmSync(realFile, { recursive: true, force: true });
      invalidateGitStatusCache(workDir);
      return { success: true };
    } catch (err) {
      return { success: false, error: err?.message || "删除未跟踪文件失败" };
    }
  }
  const res = await runGitExec(["checkout", "--", filePath], repoRoot);
  if (res.ok) invalidateGitStatusCache(workDir);
  return res.ok ? { success: true } : { success: false, error: res.stderr || "丢弃更改失败" };
}

async function gitFetch(workDir) {
  if (!resolveGitRepoRoot(workDir)) {
    return { success: false, error: "当前目录不是有效的 Git 仓库" };
  }
  const res = await new Promise((resolve) => {
    execFile("git", ["fetch", "--all", "--prune"], { cwd: workDir, timeout: 30000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || "", stderr: stderr || (err ? err.message : "") });
    });
  });
  return res.ok
    ? { success: true, message: "已同步远程分支与提交 (Fetch)" }
    : { success: false, error: (res.stderr || res.stdout || "Fetch 失败").trim() };
}

async function gitPull(workDir) {
  if (!resolveGitRepoRoot(workDir)) {
    return { success: false, error: "当前目录不是有效的 Git 仓库" };
  }
  const res = await new Promise((resolve) => {
    execFile("git", ["pull", "--no-rebase"], { cwd: workDir, timeout: 30000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || "", stderr: stderr || (err ? err.message : "") });
    });
  });
  if (!res.ok) {
    const raw = (res.stderr || res.stdout || "").trim();
    if (/CONFLICT|Automatic merge failed/i.test(raw)) {
      await runGitExec(["merge", "--abort"], workDir);
      return { success: false, error: `Pull 时发生合并冲突，已自动中止并恢复现场：\n${raw}` };
    }
    return { success: false, error: raw || "Pull 失败" };
  }
  invalidateGitStatusCache(workDir);
  return { success: true, message: (res.stdout || "Pull 成功").trim() };
}

async function gitPush(workDir) {
  if (!resolveGitRepoRoot(workDir)) {
    return { success: false, error: "当前目录不是有效的 Git 仓库" };
  }
  const headRes = await runGitExec(["rev-parse", "--abbrev-ref", "HEAD"], workDir);
  const currentBranch = headRes.ok ? headRes.stdout.trim() : "";
  if (!currentBranch || currentBranch === "HEAD") {
    return { success: false, error: "当前处于游离 HEAD 状态，请先切换到具体分支后再推送" };
  }
  const upRes = await runGitExec(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], workDir);
  const args = upRes.ok ? ["push"] : ["push", "-u", "origin", currentBranch];
  const res = await new Promise((resolve) => {
    execFile("git", args, { cwd: workDir, timeout: 30000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || "", stderr: stderr || (err ? err.message : "") });
    });
  });
  return res.ok
    ? { success: true, message: `已推送分支 ${currentBranch}` }
    : { success: false, error: (res.stderr || res.stdout || "Push 失败").trim() };
}

async function gitMergeBranch(workDir, sourceBranch) {
  if (!resolveGitRepoRoot(workDir)) {
    return { success: false, error: "当前目录不是有效的 Git 仓库" };
  }
  const safeSource = String(sourceBranch || "").trim();
  if (!safeSource || safeSource.startsWith("-")) {
    return { success: false, error: "无效的源分支名称" };
  }
  const stRes = await runGitExec(["status", "--porcelain"], workDir);
  if (stRes.ok && stRes.stdout.trim()) {
    return { success: false, error: "当前工作区有未提交修改，请先 Commit 或 Stash 后再合并" };
  }
  const res = await runGitExec(["merge", "--no-ff", safeSource], workDir);
  if (!res.ok) {
    const raw = (res.stderr || res.stdout || res.error || "").trim();
    if (/CONFLICT|Automatic merge failed/i.test(raw)) {
      await runGitExec(["merge", "--abort"], workDir);
      return { success: false, error: `合并 ${safeSource} 时发生冲突，已自动中止恢复：\n${raw}` };
    }
    return { success: false, error: raw || `合并 ${safeSource} 失败` };
  }
  invalidateGitStatusCache(workDir);
  return { success: true, message: `已成功将 ${safeSource} 合并到当前分支` };
}

async function gitStashAction(workDir, action = "push") {
  if (!resolveGitRepoRoot(workDir)) {
    return { success: false, error: "当前目录不是有效的 Git 仓库" };
  }
  if (action === "pop") {
    const res = await runGitExec(["stash", "pop"], workDir);
    if (res.ok) invalidateGitStatusCache(workDir);
    return res.ok
      ? { success: true, message: "已从 Stash 恢复工作区改动" }
      : { success: false, error: (res.stderr || res.stdout || "Stash Pop 失败").trim() };
  }
  const res = await runGitExec(["stash", "push", "-u", "-m", "omcx-graph-stash"], workDir);
  if (res.ok) invalidateGitStatusCache(workDir);
  return res.ok
    ? { success: true, message: (res.stdout || "已暂存工作区改动 (Stash)").trim() }
    : { success: false, error: (res.stderr || res.stdout || "Stash 失败").trim() };
}

async function gitCherryPick(workDir, hash) {
  if (!resolveGitRepoRoot(workDir)) {
    return { success: false, error: "当前目录不是有效的 Git 仓库" };
  }
  const safeHash = String(hash || "").trim();
  if (!/^[0-9a-fA-F]{4,40}$/.test(safeHash)) {
    return { success: false, error: "无效的 Commit Hash" };
  }
  const res = await runGitExec(["cherry-pick", safeHash], workDir);
  if (!res.ok) {
    const raw = (res.stderr || res.stdout || res.error || "").trim();
    await runGitExec(["cherry-pick", "--abort"], workDir);
    return { success: false, error: `Cherry-pick 失败（已中止恢复）：\n${raw}` };
  }
  invalidateGitStatusCache(workDir);
  return { success: true, message: `已将提交 ${safeHash.slice(0, 7)} Cherry-pick 到当前分支` };
}

async function gitCreateBranchAt(workDir, branchName, startPoint) {
  if (!resolveGitRepoRoot(workDir)) {
    return { success: false, error: "当前目录不是有效的 Git 仓库" };
  }
  const safeBranch = String(branchName || "").trim();
  const safeStart = String(startPoint || "").trim();
  if (!safeBranch || safeBranch.startsWith("-")) {
    return { success: false, error: "分支名称无效" };
  }
  if (!safeStart || safeStart.startsWith("-")) {
    return { success: false, error: "起点引用无效" };
  }
  const res = await runGitExec(["checkout", "-b", safeBranch, safeStart], workDir);
  if (res.ok) invalidateGitStatusCache(workDir);
  return res.ok
    ? { success: true, branch: safeBranch, message: `已创建并切换到分支 ${safeBranch}` }
    : { success: false, error: (res.stderr || res.stdout || "创建分支失败").trim() };
}

module.exports = {
  resolveGitRepoRoot,
  invalidateGitStatusCache,
  getWorkspaceGitStatus,
  getWorkingTreeChanges,
  commitStagedChanges,
  discardWorkspaceFile,
  gitFetch,
  gitPull,
  gitPush,
  gitMergeBranch,
  gitStashAction,
  gitCherryPick,
  gitCreateBranchAt,
  getWorkspaceFileDiff,
  commitWorkspaceChanges,
  getWorkspaceBranches,
  checkoutWorkspaceBranch,
  deleteWorkspaceBranch,
  getGitCommitGraph,
  getGitCommitDetail,
};
