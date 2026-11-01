const fs = require("fs");
const path = require("path");

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
 * 校验目标路径是否归属于某个根目录
 */
function isUnderFolder(targetPath, folderPath) {
  if (!folderPath) return false;
  const resolvedTarget = path.resolve(targetPath);
  const resolvedFolder = path.resolve(folderPath);
  const relative = path.relative(resolvedFolder, resolvedTarget);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * 多源文件夹全量放行安全解析
 * @param {string} userPath - 用户或 Agent 传入的文件路径 (可能是绝对路径或相对路径)
 * @param {string|null} workDir - 主要工作目录
 * @param {string[]} [allowedFolders=[]] - 工作空间挂载的全部源文件夹物理路径列表
 * @returns {{ resolvedPath: string, isExternal: boolean, primaryFolder: string }}
 */
function resolveWorkspacePath(userPath, workDir, allowedFolders = []) {
  const allFolders = new Set();
  if (workDir) allFolders.add(path.resolve(workDir));
  if (Array.isArray(allowedFolders)) {
    allowedFolders.forEach((f) => {
      if (f && typeof f === "string") allFolders.add(path.resolve(f));
    });
  }
  if (allFolders.size === 0) {
    allFolders.add(DEFAULT_ROOT);
  }

  const folderList = Array.from(allFolders);
  const primaryFolder = folderList[0] || DEFAULT_ROOT;

  // 1. 如果是绝对路径
  if (path.isAbsolute(userPath)) {
    const normalized = path.resolve(userPath);
    // 检查是否属于挂载的任意一个源文件夹
    const matched = folderList.some((f) => isUnderFolder(normalized, f));
    return {
      resolvedPath: normalized,
      isExternal: !matched,
      primaryFolder,
    };
  }

  // 2. 如果是相对路径，进行多目录智能探测
  // A. 优先检查相对于主目录
  const primaryCandidate = path.resolve(primaryFolder, userPath);
  if (fs.existsSync(primaryCandidate)) {
    return {
      resolvedPath: primaryCandidate,
      isExternal: false,
      primaryFolder,
    };
  }

  // B. 遍历挂载的其他源文件夹
  for (const folder of folderList) {
    const candidate = path.resolve(folder, userPath);
    if (fs.existsSync(candidate)) {
      return {
        resolvedPath: candidate,
        isExternal: false,
        primaryFolder,
      };
    }

    // 检查相对路径开头是否恰好是某个文件夹的名称 (如 userPath = "silence-fastapi/main.py", folder = ".../silence-fastapi")
    const folderBaseName = path.basename(folder);
    if (userPath.startsWith(folderBaseName + "/") || userPath.startsWith(folderBaseName + "\\")) {
      const stripped = userPath.slice(folderBaseName.length + 1);
      const subCandidate = path.resolve(folder, stripped);
      if (fs.existsSync(subCandidate)) {
        return {
          resolvedPath: subCandidate,
          isExternal: false,
          primaryFolder,
        };
      }
    }
  }

  // C. 若文件尚未创建，检查写入目标是否从属于某个文件夹
  for (const folder of folderList) {
    const folderBaseName = path.basename(folder);
    if (userPath.startsWith(folderBaseName + "/") || userPath.startsWith(folderBaseName + "\\")) {
      const stripped = userPath.slice(folderBaseName.length + 1);
      return {
        resolvedPath: path.resolve(folder, stripped),
        isExternal: false,
        primaryFolder,
      };
    }
  }

  // 默认归入主目录
  return {
    resolvedPath: primaryCandidate,
    isExternal: false,
    primaryFolder,
  };
}

module.exports = {
  resolveWorkspacePath,
  isUnderFolder,
  DEFAULT_ROOT,
};
