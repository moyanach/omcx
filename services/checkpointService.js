/**
 * CheckpointService — 会话级文件检查点与一键回滚
 *
 * 设计原则：
 * 1. 仅对 Agent 即将写入/编辑的文件做「写前快照」，不触碰用户手工修改；
 * 2. 同一回合内同一文件只记录第一次的原始内容，回滚即回到该回合开始前；
 * 3. 新建文件记录 existed=false，回滚时直接删除；
 * 4. 单文件超过 2MB 不做内容备份，仅记录元数据并在回滚时明确提示；
 * 5. 新会话数据落盘至 <workDir>/.omcx/checkpoints/<sessionId>/<turnId>/，与消息库解耦；
 *    升级前已存在的会话仍从旧的全局 <OMCX_HOME>/checkpoints/ 读取，保证历史回滚可用。
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const projectArtifactService = require("./projectArtifactService");

const KIND = projectArtifactService.KIND.CHECKPOINTS;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES_PER_TURN = 300;
const MAX_TURNS_PER_SESSION = 80;

function safeSegment(value) {
  const raw = String(value || "");
  const cleaned = raw
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 120);
  // "." / ".." 会被 path.join 当成目录跳转，必须替换为不可导航的稳定哈希段
  if (!cleaned || /^\.+$/.test(cleaned)) {
    return `seg_${crypto.createHash("sha1").update(raw).digest("hex").slice(0, 16)}`;
  }
  return cleaned;
}

function toPosix(p) {
  return String(p || "").replace(/\\/g, "/");
}

function isInside(parent, target) {
  if (!parent || !target) return false;
  const rel = path.relative(path.resolve(parent), path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * 解析会话绑定的工作目录：显式传入优先，其次从会话记录读取。
 * 早期版本没有落 workDir 的会话会返回 null，此时自然回落到全局旧目录。
 */
function resolveWorkDir(sessionId, workDir) {
  if (workDir) return workDir;
  if (!sessionId) return null;
  try {
    const session = require("./storageService").getSession(sessionId);
    return session?.work_dir || session?.workDir || null;
  } catch {
    return null;
  }
}

/**
 * 会话目录候选序列：解析出的落盘目录优先，其次是另一侧目录（用于旧会话兜底）。
 */
function sessionDirCandidates(sessionId, workDir) {
  const resolved = resolveWorkDir(sessionId, workDir);
  const segment = safeSegment(sessionId);
  return projectArtifactService
    .readCandidates(KIND, resolved)
    .map((base) => path.join(base, segment));
}

/** 写入目标会话目录（始终优先项目内，并按需补齐 .gitignore） */
function writeSessionDir(sessionId, workDir) {
  const resolved = resolveWorkDir(sessionId, workDir);
  const target = projectArtifactService.prepareDir(KIND, resolved);
  const base = target.dir || projectArtifactService.globalDir(KIND, resolved);
  return path.join(base, safeSegment(sessionId));
}

/** 读取时优先命中已存在的会话目录，兼容升级前的全局旧数据 */
function resolveSessionDir(sessionId, workDir) {
  const candidates = sessionDirCandidates(sessionId, workDir);
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return candidates[0];
}

function turnDir(sessionId, turnId, workDir) {
  return path.join(resolveSessionDir(sessionId, workDir), safeSegment(turnId));
}

function writeTurnDir(sessionId, turnId, workDir) {
  return path.join(writeSessionDir(sessionId, workDir), safeSegment(turnId));
}

function manifestPath(sessionId, turnId, workDir) {
  return path.join(turnDir(sessionId, turnId, workDir), "manifest.json");
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, data) {
  const tmp = `${filePath}.tmp_${process.pid}_${Date.now()}`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, JSON.stringify(data, null, 2), "utf-8");
    try {
      fs.fsyncSync(fd);
    } catch {}
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}

function normalizeFileRecord(absPath, workDir) {
  const resolved = path.resolve(absPath);
  const relative = workDir && isInside(workDir, resolved)
    ? toPosix(path.relative(workDir, resolved))
    : toPosix(resolved);
  return { absPath: resolved, relative };
}

function readManifest(sessionId, turnId, workDir) {
  return readJson(manifestPath(sessionId, turnId, workDir), null);
}

function listTurns(sessionId, workDir) {
  const dir = resolveSessionDir(sessionId, workDir);
  if (!fs.existsSync(dir)) return [];
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => readManifest(sessionId, entry.name, workDir))
      .filter(Boolean)
      .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
  } catch {
    return [];
  }
}

function pruneSession(sessionId, workDir) {
  const turns = listTurns(sessionId, workDir);
  if (turns.length <= MAX_TURNS_PER_SESSION) return;
  for (const turn of turns.slice(MAX_TURNS_PER_SESSION)) {
    try {
      fs.rmSync(turnDir(sessionId, turn.id, workDir), { recursive: true, force: true });
    } catch {
      // 清理失败不影响主流程
    }
  }
}

/**
 * 写前记录文件快照（幂等：同一回合同一文件只记录一次）
 * @param {object} params
 * @param {string} params.sessionId
 * @param {string} params.turnId
 * @param {string} params.filePath 绝对路径或相对 workDir 的路径
 * @param {string|null} params.workDir
 * @param {string} [params.tool]
 * @returns {{recorded:boolean, reason?:string, existed?:boolean}}
 */
function recordFile({ sessionId, turnId, filePath, workDir = null, tool = "" } = {}) {
  if (!sessionId || !turnId || !filePath) {
    return { recorded: false, reason: "missing_arguments" };
  }

  const absPath = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(workDir || process.cwd(), filePath);

  // 禁止把检查点写进设备/管道等特殊文件
  let stat = null;
  try {
    stat = fs.statSync(absPath);
    if (!stat.isFile()) return { recorded: false, reason: "not_a_regular_file" };
  } catch {
    stat = null;
  }

  fs.mkdirSync(writeTurnDir(sessionId, turnId, workDir), { recursive: true });
  const mPath = manifestPath(sessionId, turnId, workDir);
  const now = Date.now();
  const manifest = readJson(mPath, null) || {
    id: turnId,
    sessionId,
    workDir: workDir ? path.resolve(workDir) : null,
    createdAt: now,
    updatedAt: now,
    files: [],
  };

  const normalized = normalizeFileRecord(absPath, workDir);
  const existedEntry = manifest.files.find((item) => item.absPath === normalized.absPath);
  if (existedEntry) {
    return {
      recorded: false,
      reason: "already_recorded",
      existed: existedEntry.existed,
    };
  }

  if (manifest.files.length >= MAX_FILES_PER_TURN) {
    return { recorded: false, reason: "turn_file_limit" };
  }

  const record = {
    absPath: normalized.absPath,
    relative: normalized.relative,
    existed: Boolean(stat),
    mode: stat ? stat.mode & 0o777 : null,
    size: stat ? stat.size : 0,
    tool: String(tool || ""),
    recordedAt: now,
    backup: null,
    skipped: false,
  };

  if (stat && stat.size <= MAX_FILE_BYTES) {
    const digest = crypto
      .createHash("sha1")
      .update(normalized.absPath)
      .digest("hex")
      .slice(0, 16);
    const backupName = `${digest}.bak`;
    const backupsDir = path.join(writeTurnDir(sessionId, turnId, workDir), "files");
    fs.mkdirSync(backupsDir, { recursive: true });
    try {
      fs.copyFileSync(absPath, path.join(backupsDir, backupName));
      record.backup = `files/${backupName}`;
    } catch (err) {
      record.skipped = true;
      record.skipReason = `快照复制失败: ${err.message}`;
    }
  } else if (stat) {
    record.skipped = true;
    record.skipReason = `文件超过 ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB，未备份内容`;
  }

  manifest.files.push(record);
  manifest.updatedAt = now;
  writeJsonAtomic(mPath, manifest);
  pruneSession(sessionId, workDir);
  return { recorded: true, existed: record.existed, skipped: record.skipped };
}

function getCheckpoint(sessionId, turnId) {
  return readManifest(sessionId, turnId);
}

function listCheckpoints(sessionId) {
  return listTurns(sessionId).map((manifest) => ({
    id: manifest.id,
    sessionId: manifest.sessionId,
    workDir: manifest.workDir,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    fileCount: Array.isArray(manifest.files) ? manifest.files.length : 0,
    files: (manifest.files || []).slice(0, 30).map((item) => ({
      path: item.relative,
      existed: item.existed,
      skipped: item.skipped,
      tool: item.tool,
    })),
    truncatedFiles: Math.max(0, (manifest.files || []).length - 30),
  }));
}

/**
 * 回滚某个回合：按记录逆序恢复。返回逐文件结果，便于前端提示。
 */
function restoreCheckpoint(sessionId, turnId) {
  const manifest = readManifest(sessionId, turnId);
  if (!manifest) {
    return { success: false, error: "检查点不存在或已损坏" };
  }

  const results = [];
  const files = [...(manifest.files || [])].reverse();
  for (const record of files) {
    try {
      const absPath = record.absPath;
      if (record.skipped || (record.existed && !record.backup)) {
        results.push({
          path: record.relative,
          success: false,
          error: record.skipReason || "缺少备份内容，无法回滚",
        });
        continue;
      }
      if (record.existed) {
        const backupPath = path.join(turnDir(sessionId, turnId), record.backup);
        if (!fs.existsSync(backupPath)) {
          results.push({ path: record.relative, success: false, error: "备份文件已丢失" });
          continue;
        }
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.copyFileSync(backupPath, absPath);
        if (record.mode !== null && record.mode !== undefined) {
          try {
            fs.chmodSync(absPath, record.mode);
          } catch {}
        }
        results.push({ path: record.relative, success: true, action: "restored" });
      } else {
        if (fs.existsSync(absPath)) {
          fs.unlinkSync(absPath);
          results.push({ path: record.relative, success: true, action: "removed" });
        } else {
          results.push({ path: record.relative, success: true, action: "already_absent" });
        }
      }
    } catch (err) {
      results.push({ path: record.relative, success: false, error: err.message });
    }
  }

  const failed = results.filter((item) => !item.success);
  return {
    success: failed.length === 0,
    restored: results.filter((item) => item.action === "restored").length,
    removed: results.filter((item) => item.action === "removed").length,
    failed,
    results,
  };
}

function deleteCheckpoint(sessionId, turnId) {
  const dir = turnDir(sessionId, turnId);
  if (!fs.existsSync(dir)) return { success: false, error: "检查点不存在" };
  fs.rmSync(dir, { recursive: true, force: true });
  return { success: true };
}

module.exports = {
  // 兼容旧调用方：指向升级前的全局目录，仅作只读兜底用途
  CHECKPOINT_ROOT: projectArtifactService.globalDir(KIND),
  recordFile,
  getCheckpoint,
  listCheckpoints,
  restoreCheckpoint,
  deleteCheckpoint,
  resolveSessionDir,
};
