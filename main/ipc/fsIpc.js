const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const crypto = require("crypto");
const { ipcMain, dialog, shell } = require("electron");
const {
  safeHandler,
  asyncPathExists,
  asyncStatSafe,
  getMainWindow,
  getWorkspaceFolders,
  isKnownSessionOutputPath,
  isImageFile,
  extFromMime,
  getAttachmentExtension,
  processAttachmentImageBuffer,
  getStorageService,
  getSandboxPolicyService,
  getPathResolver,
  getFileIndexer,
  getToolRegistry,
} = require("../shared");

const DIRECT_READONLY_TOOLS = new Set([
  "read_file",
  "list_directory",
  "search_code",
  "search_symbols",
  "repo_map",
]);

function registerFsIpc() {
  ipcMain.handle(
    "get-workspaces",
    safeHandler(() => getStorageService().getWorkspaces())
  );

  ipcMain.handle(
    "save-workspace",
    safeHandler((event, ws) => getStorageService().saveWorkspace(ws))
  );

  ipcMain.handle(
    "delete-workspace",
    safeHandler((event, id) => getStorageService().deleteWorkspace(id))
  );

  ipcMain.handle(
    "dialog-select-work-directory",
    safeHandler(async () => {
      const result = await dialog.showOpenDialog(getMainWindow(), {
        properties: ["openDirectory"],
        title: "选择项目工作目录",
      });
      if (result.canceled) return null;
      return result.filePaths[0] || null;
    })
  );

  ipcMain.handle(
    "save-chat-attachment",
    safeHandler(async (event, { sessionId, name, mime, sourcePath, base64 }) => {
      if (!sessionId || (!base64 && !sourcePath)) throw new Error("附件参数不完整");
      const storageService = getStorageService();
      const { resolveRealPathSafe, checkSensitivePath } = getSandboxPolicyService();
      const cleanName = name || "attachment";
      const isImg = isImageFile({ name: cleanName, mime });

      if (sourcePath) {
        if (!(await asyncPathExists(sourcePath))) throw new Error("附件源文件不存在");
        const realSource = resolveRealPathSafe(sourcePath) || path.resolve(sourcePath);
        const sensitiveCheck = checkSensitivePath(realSource);
        if (sensitiveCheck.blocked) {
          throw new Error(sensitiveCheck.reason || "安全策略已禁止上传该敏感文件");
        }
        const sourceStat = await fsp.stat(realSource);
        if (!sourceStat.isFile()) throw new Error("附件源路径不是文件");
        if (sourceStat.size > 512 * 1024 * 1024) throw new Error("附件超过 512MB 上限");

        const id = crypto.randomUUID();
        if (isImg) {
          const rawBuffer = await fsp.readFile(realSource);
          const processed = processAttachmentImageBuffer(rawBuffer, mime);
          const ext = extFromMime(processed.mime, cleanName);
          const saved = storageService.saveAttachmentBuffer(sessionId, id, ext, processed.buffer);
          return {
            id,
            path: saved.path,
            width: processed.width,
            height: processed.height,
            size: saved.size,
            mime: processed.mime,
            name: cleanName,
          };
        }

        const ext = getAttachmentExtension(cleanName) || "bin";
        const dir = storageService.getSessionAttachmentsDir(sessionId);
        await fsp.mkdir(dir, { recursive: true });
        const targetPath = path.join(dir, `${id}.${ext}`);
        await fsp.copyFile(realSource, targetPath);
        const stat = await fsp.stat(targetPath);
        return {
          id,
          path: targetPath,
          size: stat.size,
          mime: mime || "application/octet-stream",
          name: cleanName,
        };
      }

      const inputBuffer = Buffer.from(String(base64 || ""), "base64");
      if (isImg) {
        const processed = processAttachmentImageBuffer(inputBuffer, mime);
        const id = crypto.randomUUID();
        const ext = extFromMime(processed.mime, cleanName);
        const saved = storageService.saveAttachmentBuffer(sessionId, id, ext, processed.buffer);
        return {
          id,
          path: saved.path,
          width: processed.width,
          height: processed.height,
          size: saved.size,
          mime: processed.mime,
          name: cleanName,
        };
      }

      const id = crypto.randomUUID();
      const ext = getAttachmentExtension(cleanName) || "bin";
      const saved = storageService.saveAttachmentBuffer(sessionId, id, ext, inputBuffer);
      return {
        id,
        path: saved.path,
        size: saved.size,
        mime: mime || "application/octet-stream",
        name: cleanName,
      };
    })
  );

  ipcMain.handle(
    "delete-chat-attachment",
    safeHandler((event, filePath) => getStorageService().deleteAttachmentFile(filePath))
  );

  ipcMain.handle(
    "workspace-list-dir",
    safeHandler(async (event, { workDir, dirPath = "." } = {}) => {
      const { DEFAULT_ROOT, isUnderFolder } = getPathResolver();
      const { checkSensitivePath } = getSandboxPolicyService();
      const baseRoot = workDir && String(workDir).trim() ? path.resolve(workDir.trim()) : DEFAULT_ROOT;
      const { matchedWorkspace, allowedFolders } = getWorkspaceFolders(baseRoot);
      const validFolders = allowedFolders.length > 0 ? allowedFolders : [baseRoot];

      const targetAbs = path.isAbsolute(dirPath)
        ? path.resolve(dirPath)
        : path.resolve(baseRoot, dirPath || ".");

      const isAllowed = validFolders.some((root) => isUnderFolder(targetAbs, root));
      if (!isAllowed || checkSensitivePath(targetAbs).blocked) {
        return { success: false, error: "无权访问该目录", entries: [] };
      }
      const targetStat = await asyncStatSafe(targetAbs);
      if (!targetStat || !targetStat.isDirectory()) {
        return { success: false, error: "目录不存在", entries: [] };
      }

      const skipNames = new Set([".DS_Store", ".git", "node_modules"]);
      const rawItems = await fsp.readdir(targetAbs, { withFileTypes: true });
      const entries = [];

      for (const item of rawItems) {
        if (skipNames.has(item.name)) continue;
        if (item.name === ".env" || item.name.startsWith(".env.")) continue;
        const fullPath = path.join(targetAbs, item.name);
        if (checkSensitivePath(fullPath).blocked) continue;
        const stat = await asyncStatSafe(fullPath);
        if (!stat) continue;
        const isDir = stat.isDirectory();
        const relPath = path.relative(baseRoot, fullPath).replace(/\\/g, "/");
        entries.push({
          name: item.name,
          path: relPath && !relPath.startsWith("..") ? relPath : fullPath,
          absPath: fullPath,
          isDir,
          size: isDir ? 0 : stat.size,
          ext: isDir ? "" : path.extname(item.name).replace(".", "").toLowerCase(),
          mtimeMs: stat.mtimeMs,
        });
      }

      entries.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      const rawRoots = matchedWorkspace?.folders?.length
        ? matchedWorkspace.folders.map((f) => ({
            name: f.name || path.basename(f.path),
            path: path.resolve(f.path),
            isPrimary: !!f.isPrimary,
          }))
        : [{ name: path.basename(baseRoot), path: baseRoot, isPrimary: true }];
      const rootChecks = await Promise.all(rawRoots.map(async (f) => ((await asyncPathExists(f.path)) ? f : null)));
      const workspaceRoots = rootChecks.filter(Boolean);

      return {
        success: true,
        workDir: baseRoot,
        currentDir: targetAbs,
        roots: workspaceRoots,
        entries,
      };
    })
  );

  ipcMain.handle(
    "workspace-read-file",
    safeHandler(async (event, { workDir, filePath, maxChars = 250000 } = {}) => {
      if (!filePath) return { success: false, error: "文件路径为空" };
      const { DEFAULT_ROOT, isBuiltinTrustedPath } = getPathResolver();
      const { checkSensitivePath, resolveRealPathSafe, isUnderFolderReal } = getSandboxPolicyService();
      const storageService = getStorageService();

      const baseRoot = workDir && String(workDir).trim() ? path.resolve(workDir.trim()) : DEFAULT_ROOT;
      const { allowedFolders } = getWorkspaceFolders(baseRoot);
      const validFolders = allowedFolders.length > 0 ? allowedFolders : [baseRoot];

      let targetAbs = path.isAbsolute(filePath)
        ? path.resolve(filePath)
        : path.resolve(baseRoot, filePath);

      if (!(await asyncPathExists(targetAbs))) {
        for (const folder of validFolders) {
          const candidate = path.resolve(folder, filePath);
          if (await asyncPathExists(candidate)) {
            targetAbs = candidate;
            break;
          }
        }
      }

      if (!(await asyncPathExists(targetAbs))) {
        const normRel = filePath.replace(/\\/g, "/").replace(/^\.?\//, "");
        const firstSlash = normRel.indexOf("/");

        if (firstSlash > 0) {
          const withoutFirst = normRel.slice(firstSlash + 1);
          for (const folder of validFolders) {
            const cand = path.resolve(folder, withoutFirst);
            const candStat = await asyncStatSafe(cand);
            if (candStat && candStat.isFile()) {
              targetAbs = cand;
              break;
            }
          }
        }

        if (!(await asyncPathExists(targetAbs))) {
          const IGNORED = new Set([
            ".git",
            "node_modules",
            ".venv",
            "venv",
            "__pycache__",
            "dist",
            "build",
            ".next",
            ".nuxt",
            "target",
            "vendor",
            "Pods",
            "coverage",
            ".cache",
            ".omcx",
            ".vscode",
          ]);
          const targetSuffix = "/" + normRel;
          const targetFileName = normRel.split("/").pop();
          const MAX_SCAN_ENTRIES = 30000;
          const MAX_SCAN_MS = 1500;
          const scanStartedAt = Date.now();
          let scannedEntries = 0;
          let suffixMatch = "";
          let filenameFallback = "";

          for (const folder of validFolders) {
            if (suffixMatch) break;
            const queue = [folder];
            let dirLoops = 0;
            while (queue.length > 0 && !suffixMatch) {
              if (
                scannedEntries > MAX_SCAN_ENTRIES ||
                Date.now() - scanStartedAt > MAX_SCAN_MS
              ) {
                break;
              }
              const curDir = queue.shift();
              dirLoops += 1;
              if (dirLoops % 25 === 0) {
                await new Promise((r) => setImmediate(r));
              }
              let entries = [];
              try {
                entries = await fsp.readdir(curDir, { withFileTypes: true });
              } catch {
                continue;
              }
              for (const item of entries) {
                if (item.name.startsWith(".") || IGNORED.has(item.name)) continue;
                scannedEntries += 1;
                const full = path.join(curDir, item.name);
                let isDir = item.isDirectory();
                let isFile = item.isFile();
                if (item.isSymbolicLink()) {
                  const st = await asyncStatSafe(full);
                  if (!st) continue;
                  isDir = st.isDirectory();
                  isFile = st.isFile();
                }
                if (isDir) {
                  queue.push(full);
                } else if (isFile) {
                  const normFull = full.replace(/\\/g, "/");
                  if (normFull.endsWith(targetSuffix)) {
                    suffixMatch = full;
                    break;
                  }
                  if (!filenameFallback && item.name === targetFileName) {
                    filenameFallback = full;
                  }
                }
              }
            }
          }

          targetAbs = suffixMatch || filenameFallback || targetAbs;
        }
      }

      if (checkSensitivePath(targetAbs).blocked) {
        return { success: false, error: "安全策略已禁止读取该敏感文件" };
      }
      const baseName = path.basename(targetAbs).toLowerCase();
      if (baseName === ".env" || baseName.startsWith(".env.")) {
        return { success: false, error: "出于安全保护，不直接展示 .env 密钥文件" };
      }
      const stat = await asyncStatSafe(targetAbs);
      if (!stat) {
        return { success: false, error: `文件不存在: ${filePath}` };
      }
      if (!stat.isFile()) {
        return { success: false, error: `目标路径不是文件: ${filePath}` };
      }

      const realTarget = resolveRealPathSafe(targetAbs) || targetAbs;
      const insideWorkspace = validFolders.some((folder) => isUnderFolderReal(realTarget, folder));
      const isTrustedBuiltin = isBuiltinTrustedPath(realTarget);
      const isAttachment = storageService.isSessionAttachmentPath(realTarget);
      const isKnownOutput = isKnownSessionOutputPath(realTarget);
      if (!insideWorkspace && !isTrustedBuiltin && !isAttachment && !isKnownOutput) {
        return { success: false, error: `安全策略已拒绝访问工作空间外部路径: ${filePath}` };
      }

      const safeMaxChars = Number.isFinite(Number(maxChars))
        ? Math.max(1000, Math.min(1000000, Math.floor(Number(maxChars))))
        : 250000;
      const readBytes = Math.min(stat.size, safeMaxChars * 4);
      let buf = Buffer.alloc(readBytes);
      const fh = await fsp.open(realTarget, "r");
      try {
        const { bytesRead } = await fh.read(buf, 0, readBytes, 0);
        buf = buf.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }

      const ext = path.extname(targetAbs).replace(".", "").toLowerCase();
      const isBinary = buf.subarray(0, 4096).includes(0);
      if (isBinary) {
        return {
          success: true,
          path: filePath,
          absPath: targetAbs,
          resolvedPath: targetAbs,
          name: path.basename(targetAbs),
          ext,
          size: stat.size,
          isBinary: true,
          content: "",
          totalLines: 0,
          truncated: false,
        };
      }

      let content = buf.toString("utf-8");
      let truncated = stat.size > readBytes;
      if (content.length > maxChars) {
        content = content.slice(0, maxChars);
        truncated = true;
      }
      const totalLines = content.split("\n").length;

      return {
        success: true,
        path: filePath,
        absPath: targetAbs,
        resolvedPath: targetAbs,
        name: path.basename(targetAbs),
        ext,
        size: stat.size,
        isBinary: false,
        content,
        totalLines,
        truncated,
      };
    })
  );

  ipcMain.handle(
    "get-workspace-file-index",
    safeHandler((event, workDir) => {
      if (!workDir || typeof workDir !== "string") {
        return { files: [], source: "none", truncated: false };
      }
      const { allowedFolders } = getWorkspaceFolders(workDir);
      return getFileIndexer().listWorkspaceFiles(workDir, allowedFolders);
    })
  );

  ipcMain.handle(
    "get-recent-projects",
    safeHandler(() => getStorageService().getRecentProjects())
  );

  ipcMain.handle(
    "add-recent-project",
    safeHandler((event, proj) => getStorageService().addRecentProject(proj))
  );

  ipcMain.handle(
    "get-tools",
    safeHandler(() => getToolRegistry().getToolSummaries())
  );

  ipcMain.handle(
    "execute-tool",
    safeHandler(async (event, { name, args, workDir } = {}) => {
      if (!DIRECT_READONLY_TOOLS.has(name)) {
        return {
          success: false,
          error: `execute-tool 仅支持只读工具 (${Array.from(DIRECT_READONLY_TOOLS).join(", ")})，写操作请通过 Agent 会话执行`,
        };
      }
      const { PERMISSION_MODES } = getSandboxPolicyService();
      const resolvedWorkDir =
        workDir && typeof workDir === "string" && (await asyncPathExists(workDir))
          ? path.resolve(workDir)
          : null;
      const context = {
        sessionId: null,
        workDir: resolvedWorkDir,
        allowedFolders: resolvedWorkDir ? [resolvedWorkDir] : [],
        permissionMode: PERMISSION_MODES.PLAN,
        checkPermission: null,
      };
      return await getToolRegistry().execute(name, args || {}, context);
    })
  );

  ipcMain.on("show-in-folder", (event, filePath) => {
    if (!filePath) return;
    asyncPathExists(filePath)
      .then((exists) => {
        if (exists) shell.showItemInFolder(filePath);
      })
      .catch(() => {});
  });

  ipcMain.on("open-external-url", (event, targetUrl) => {
    if (typeof targetUrl === "string" && /^https?:\/\//i.test(targetUrl.trim())) {
      shell.openExternal(targetUrl.trim());
    }
  });

  ipcMain.handle(
    "select-save-directory",
    safeHandler(async () => {
      const result = await dialog.showOpenDialog(getMainWindow(), {
        properties: ["openDirectory"],
        title: "选择保存目录",
      });
      if (result.canceled) return null;
      return result.filePaths[0] || null;
    })
  );

  ipcMain.handle(
    "select-background-image",
    safeHandler(async () => {
      const result = await dialog.showOpenDialog(getMainWindow(), {
        properties: ["openFile"],
        title: "选择主题背景图片",
        filters: [
          {
            name: "图片文件",
            extensions: ["png", "jpg", "jpeg", "webp", "gif", "svg", "bmp"],
          },
        ],
      });
      if (result.canceled || !result.filePaths?.[0]) return null;

      const srcPath = result.filePaths[0];
      const wallpaperDir = path.join(os.homedir(), ".omcx", "wallpaper");
      await fsp.mkdir(wallpaperDir, { recursive: true });
      try {
        for (const f of await fsp.readdir(wallpaperDir)) {
          try {
            await fsp.unlink(path.join(wallpaperDir, f));
          } catch {}
        }
      } catch {}

      const ext = path.extname(srcPath).toLowerCase() || ".png";
      const destPath = path.join(wallpaperDir, `wallpaper_${Date.now()}${ext}`);
      await fsp.copyFile(srcPath, destPath);
      return `local-media://local${encodeURI(destPath)}`;
    })
  );
}

module.exports = { registerFsIpc };
