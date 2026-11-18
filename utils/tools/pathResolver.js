const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  resolveRealPathSafe,
  isUnderFolderReal,
  getBuiltinReadOnlyTrustedDirs,
  checkSensitivePath,
  checkProtectedWorkspaceWrite,
} = require("../../services/sandboxPolicyService");

const USER_HOME = os.homedir();

function getProjectRoot() {
  const candidates = [
    path.join(__dirname, "..", ".."),
    process.cwd(),
  ];
  for (const dir of candidates) {
    const pkg = path.join(dir, "package.json");
    if (fs.existsSync(pkg)) return dir;
  }
  return path.resolve(__dirname, "..", "..");
}

const DEFAULT_ROOT = getProjectRoot();

/**
 * 校验目标路径是否归属于某个根目录（同时校验逻辑路径与 realpath 真实物理路径，防止软链接穿越）
 */
function isUnderFolder(targetPath, folderPath) {
  if (!targetPath || !folderPath) return false;
  return isUnderFolderReal(targetPath, folderPath);
}

/**
 * 校验是否属于系统内置免授权只读目录（全局 Skills / Memory / 当前会话上传附件目录）
 * 同时强制优先拦截 ~/.omcx/config.json、~/.ssh 等敏感黑名单
 */
function isBuiltinTrustedPath(targetPath, sessionId = null) {
  if (!targetPath || typeof targetPath !== "string") return false;
  const sensitive = checkSensitivePath(targetPath, sessionId);
  if (sensitive.blocked) return false;

  const trustedDirs = getBuiltinReadOnlyTrustedDirs(sessionId);
  return trustedDirs.some((dir) => isUnderFolderReal(targetPath, dir));
}

function expandHomePath(userPath) {
  const raw = String(userPath || "").trim();
  if (raw === "~") return USER_HOME;
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    return path.join(USER_HOME, raw.slice(2));
  }
  return raw;
}

/**
 * 多源文件夹安全路径解析（支持区分 read / write 模式、realpath 校验、敏感黑名单与工作区受保护文件检测）
 * @param {string} userPath - 用户或 Agent 传入的文件路径 (可能是绝对路径或相对路径)
 * @param {string|null} workDir - 主要工作目录
 * @param {string[]} [allowedFolders=[]] - 工作空间挂载的可读源文件夹列表
 * @param {object} [options={}]
 * @param {"read"|"write"} [options.mode="read"] - 访问模式：write 模式下仅允许写入真实工作区目录，不允许静默改写内置只读 Skills/Memory
 * @param {string|null} [options.sessionId=null] - 当前会话 ID（用于精准放行当前会话 attachments 只读访问）
 * @param {string[]|null} [options.writableFolders=null] - 显式指定的可写工作区目录列表
 */
function resolveWorkspacePath(userPath, workDir, allowedFolders = [], options = {}) {
  const mode = options.mode === "write" ? "write" : "read";
  const sessionId = options.sessionId || null;
  const expandedPath = expandHomePath(userPath);

  const allReadableFolders = new Set();
  if (workDir) allReadableFolders.add(path.resolve(workDir));
  if (Array.isArray(allowedFolders)) {
    allowedFolders.forEach((f) => {
      if (f && typeof f === "string") allReadableFolders.add(path.resolve(f));
    });
  }
  // 未绑定任何工作空间时，仅把应用自身目录作为只读兜底，绝不静默提升为可写目标
  const hasExplicitFolders = allReadableFolders.size > 0;
  if (!hasExplicitFolders) {
    allReadableFolders.add(DEFAULT_ROOT);
  }

  const folderList = Array.from(allReadableFolders);
  const primaryFolder = folderList[0] || DEFAULT_ROOT;

  // 可写目录集合：若传入了显式 writableFolders 则使用，否则从 folderList 中剔除系统内置只读目录
  const builtinTrusted = getBuiltinReadOnlyTrustedDirs(sessionId);
  const writableList =
    Array.isArray(options.writableFolders) && options.writableFolders.length > 0
      ? options.writableFolders.map((f) => path.resolve(f))
      : folderList.filter((f) => {
          if (!hasExplicitFolders && path.resolve(f) === path.resolve(DEFAULT_ROOT)) return false;
          return !builtinTrusted.some((trusted) => isUnderFolderReal(f, trusted));
        });
  const effectiveWritableList = writableList.length > 0 ? writableList : hasExplicitFolders ? [primaryFolder] : [];

  const finalizeResult = (candidatePath) => {
    const normalized = path.resolve(candidatePath);
    const realResolved = resolveRealPathSafe(normalized);
    const sensitive = checkSensitivePath(realResolved, sessionId);

    const inWritableWorkspace = effectiveWritableList.some((f) =>
      isUnderFolderReal(realResolved, f)
    );
    const inReadableScope =
      inWritableWorkspace ||
      isBuiltinTrustedPath(realResolved, sessionId) ||
      folderList.some((f) => isUnderFolderReal(realResolved, f));

    const isExternal = mode === "write" ? !inWritableWorkspace : !inReadableScope;
    const protectedCheck =
      mode === "write" && !isExternal
        ? checkProtectedWorkspaceWrite(realResolved, effectiveWritableList)
        : { protected: false };

    return {
      resolvedPath: normalized,
      realPath: realResolved,
      isExternal,
      primaryFolder,
      isSensitiveBlocked: sensitive.blocked,
      sensitiveReason: sensitive.reason,
      isProtectedWrite: protectedCheck.protected,
      protectedReason: protectedCheck.reason,
    };
  };

  // 1. 如果是绝对路径（或 ~ 展开后的路径）
  if (path.isAbsolute(expandedPath)) {
    return finalizeResult(expandedPath);
  }

  // 2. 如果是相对路径，进行多目录智能探测
  // A. 优先检查相对于主目录
  const primaryCandidate = path.resolve(primaryFolder, userPath);
  if (fs.existsSync(primaryCandidate)) {
    return finalizeResult(primaryCandidate);
  }

  // B. 遍历挂载的其他源文件夹
  const searchFolders = mode === "write" ? effectiveWritableList : folderList;
  for (const folder of searchFolders) {
    const candidate = path.resolve(folder, userPath);
    if (fs.existsSync(candidate)) {
      return finalizeResult(candidate);
    }

    const folderBaseName = path.basename(folder);
    if (userPath.startsWith(folderBaseName + "/") || userPath.startsWith(folderBaseName + "\\")) {
      const stripped = userPath.slice(folderBaseName.length + 1);
      const subCandidate = path.resolve(folder, stripped);
      if (fs.existsSync(subCandidate)) {
        return finalizeResult(subCandidate);
      }
    }
  }

  // C. 若文件尚未创建，检查写入目标是否从属于某个文件夹
  for (const folder of searchFolders) {
    const folderBaseName = path.basename(folder);
    if (userPath.startsWith(folderBaseName + "/") || userPath.startsWith(folderBaseName + "\\")) {
      const stripped = userPath.slice(folderBaseName.length + 1);
      return finalizeResult(path.resolve(folder, stripped));
    }
  }

  // 默认归入主目录
  return finalizeResult(primaryCandidate);
}

module.exports = {
  resolveWorkspacePath,
  isUnderFolder,
  isBuiltinTrustedPath,
  DEFAULT_ROOT,
};
